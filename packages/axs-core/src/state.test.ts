/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

import { describe, expect, it, vi } from "vitest";

import { AXS_USAGE_RECORD_OFFSETS } from "./axs/device-info.js";
import { createSrambondDecoder, LIVE_STATE_CHARACTERISTIC } from "./axs/srambond.js";
import { fromHex } from "./bytes.js";
import { eaxEncrypt } from "./crypto/aes-eax.js";
import { DecoderRegistry } from "./decode/registry.js";
import type { RawFrame } from "./frame.js";
import { StateAggregator } from "./state.js";

/** Any key works; the frames below are sealed with it. */
const TEST_KEY = new Uint8Array(16).fill(0x2a);

function frame(data: Uint8Array, characteristicUuid: string | null = null, seq = 0): RawFrame {
  return {
    seq,
    timestamp: 1_700_000_000_000 + seq,
    elapsedMs: seq,
    deviceId: "device-1",
    source: "notification",
    serviceUuid: null,
    characteristicUuid,
    data,
  };
}

/**
 * An encrypted `d905000b` live-state frame carrying `drivetrain_status`, exactly
 * as the component serves it. Decoded through a keyed SRAMBond decoder.
 */
function gearFrame(gear: number, seq = 0): RawFrame {
  const plaintext = Uint8Array.from([
    0xa0, 0x01, 0x01, // field 20 (fd_position) = 1
    0xa8, 0x01, gear, // field 21 (rd_position) = gear
    0xb0, 0x01, 0x0c, // field 22 (rd_trim) = 12
  ]);
  const nonce = new Uint8Array(16).fill(seq & 0xff);
  const sealed = eaxEncrypt(TEST_KEY, nonce, plaintext, { tagLength: 16 });
  const data = new Uint8Array(nonce.length + sealed.length);
  data.set(nonce);
  data.set(sealed, nonce.length);
  return frame(data, LIVE_STATE_CHARACTERISTIC, seq);
}

/** A plaintext `d9050003` usage record carrying the cumulative shift counter. */
function usageFrame(shiftCounter: number, seq = 0): RawFrame {
  const record = new Uint8Array(54);
  record[0] = 0x01;
  record[AXS_USAGE_RECORD_OFFSETS.shiftCount] = shiftCounter;
  return frame(record, "d9050003-90aa-4c7c-b036-1e01fb8eb7ee", seq);
}

function aggregator() {
  const registry = new DecoderRegistry();
  registry.add(createSrambondDecoder(TEST_KEY));
  return new StateAggregator("device-1", "SIM RD", registry);
}

describe("StateAggregator", () => {
  it("starts empty", () => {
    const state = aggregator().current();

    expect(state.gearRear).toBeNull();
    expect(state.firmwareRevision).toBeNull();
    expect(state.shiftCount).toBe(0);
    expect(state.frameCount).toBe(0);
  });

  it("folds Device Information strings in with provenance", () => {
    const agg = aggregator();
    agg.ingest(frame(fromHex("31 2e 32 38 2e 30"), "2a26"));

    const firmware = agg.current().firmwareRevision!;
    expect(firmware.value).toBe("1.28.0");
    expect(firmware.decoder).toBe("gatt/device-information");
    expect(firmware.confidence).toBeGreaterThan(0.9);
  });

  it("folds the standard battery percentage in", () => {
    const agg = aggregator();
    agg.ingest(frame(fromHex("57"), "2a19"));
    expect(agg.current().batteryPercent?.value).toBe(87);
  });

  it("tracks gear from a decrypted drivetrain_status frame", () => {
    const agg = aggregator();
    agg.ingest(gearFrame(5));

    expect(agg.current().gearRear?.value).toBe(5);
    expect(agg.current().gearFront?.value).toBe(1);
  });

  it("does not count a re-read of an unchanged gear as a shift", () => {
    // The component is polled several times a second. Without the
    // changed-value check every read would register as a shift.
    const agg = aggregator();
    agg.ingest(gearFrame(5, 0));
    agg.ingest(gearFrame(5, 1));
    agg.ingest(gearFrame(5, 2));

    expect(agg.current().shiftCount).toBe(0);
  });

  it("counts a shift when the gear changes", () => {
    const agg = aggregator();
    agg.ingest(gearFrame(5, 0));
    agg.ingest(gearFrame(6, 1));
    agg.ingest(gearFrame(7, 2));

    expect(agg.current().shiftCount).toBe(2);
    expect(agg.current().gearRear?.value).toBe(7);
  });

  it("emits a shift event carrying the gear transition", () => {
    const agg = aggregator();
    const onShift = vi.fn();
    agg.events.on("shift", onShift);

    agg.ingest(gearFrame(5, 0));
    agg.ingest(gearFrame(6, 1));

    expect(onShift).toHaveBeenCalledOnce();
    expect(onShift).toHaveBeenCalledWith({ from: 5, to: 6, totalShifts: 1 });
  });

  it("counts shifts made while disconnected, via the component's own counter", () => {
    // The usage record's cumulative counter catches shifts that happened while
    // polling was not running — gear-change detection alone would miss them.
    const agg = aggregator();
    agg.ingest(usageFrame(10, 0));
    agg.ingest(usageFrame(14, 1)); // four shifts happened out of range

    expect(agg.current().shiftCount).toBe(4);
  });

  it("handles wraparound of the component's shift counter", () => {
    const agg = aggregator();
    agg.ingest(usageFrame(254, 0));
    agg.ingest(usageFrame(2, 1));

    expect(agg.current().shiftCount).toBe(4);
  });

  it("emits change events only when something actually changed", () => {
    const agg = aggregator();
    const onChange = vi.fn();

    agg.ingest(gearFrame(5, 0));
    agg.events.on("change", onChange);
    agg.ingest(gearFrame(5, 1)); // same gear, re-read

    expect(onChange).not.toHaveBeenCalled();
  });

  it("never lets a speculative reading overwrite a confirmed one", () => {
    // A heuristic reading is speculative (~0.5); the GATT string decoder is
    // near-certain at 0.99. Order of arrival must not matter.
    const agg = aggregator();
    agg.ingest(frame(fromHex("57"), "2a19")); // battery 87%, confidence 0.99

    const confirmed = agg.current().batteryPercent!;
    expect(confirmed.confidence).toBeGreaterThan(0.9);

    const registry = new DecoderRegistry([
      {
        name: "speculative",
        decode: () => ({
          decoder: "speculative",
          confidence: 0.3,
          summary: "guess",
          fields: { batteryPercent: 12 },
        }),
      },
    ]);

    agg.ingest(frame(fromHex("00")), registry.decode(frame(fromHex("00"))));
    expect(agg.current().batteryPercent!.value).toBe(87);
  });

  it("accepts a higher-confidence reading over a lower one", () => {
    const agg = aggregator();
    const low = frame(fromHex("00"));

    agg.ingest(low, [
      { decoder: "low", confidence: 0.2, summary: "", fields: { batteryPercent: 10 } },
    ]);
    agg.ingest(low, [
      { decoder: "high", confidence: 0.9, summary: "", fields: { batteryPercent: 90 } },
    ]);

    expect(agg.current().batteryPercent!.value).toBe(90);
  });

  it("counts every ingested frame, decoded or not", () => {
    const agg = aggregator();
    agg.ingest(frame(fromHex("de ad")));
    agg.ingest(frame(fromHex("be ef")));

    expect(agg.current().frameCount).toBe(2);
  });

  it("clears derived state on reset but keeps device identity", () => {
    const agg = aggregator();
    agg.ingest(gearFrame(5, 0));
    agg.ingest(gearFrame(6, 1));
    agg.reset();

    const state = agg.current();
    expect(state.gearRear).toBeNull();
    expect(state.shiftCount).toBe(0);
    expect(state.deviceId).toBe("device-1");
    expect(state.deviceName).toBe("SIM RD");
  });
});

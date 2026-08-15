/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * These tests use **real bytes captured from a real derailleur**, asserted
 * against what the official SRAM AXS app displayed for the same component at
 * the same moment.
 *
 * Ground truth (AXS app, 2026-08-01, bike "Spectral CF8"):
 *   Component     GX RD
 *   Model         RD-GX-E-B1
 *   Serial        1503603158
 *   Firmware      2.55.6
 *   MicroAdjust   min 1, current 12, max 23
 */

import { describe, expect, it } from "vitest";

import { fromHex } from "../bytes.js";
import { DecoderRegistry } from "../decode/registry.js";
import type { RawFrame } from "../frame.js";
import {
  axsModelName,
  decodeAxsFirmware,
  decodeMicroAdjust,
} from "./device-info.js";

/** Verbatim reads from serial 1503603158. */
const CAPTURE = {
  serial: fromHex("d6 29 9f 59"),
  model: fromHex("33 04"),
  deviceRecord: fromHex(
    "02 00 00 00 00 06 37 02 00 00 02 01 54 01 00 00 00 01 01 06 40 28 05 00 " +
      "67 33 31 33 63 61 61 30 65 64 36 2e 64 69 72 00",
  ),
  microAdjust: fromHex("b8 01 01 c0 01 0c c8 01 17"),
  identityProtobuf: fromHex("ca 01 0a b0 01 d6 d3 fc cc 05 b8 01 01"),
};

const SRAM_BASE = "-90aa-4c7c-b036-1e01fb8eb7ee";

function frame(characteristicUuid: string, data: Uint8Array): RawFrame {
  return {
    seq: 0,
    timestamp: 1_754_000_000_000,
    elapsedMs: 0,
    deviceId: "real-gx-rd",
    source: "read",
    serviceUuid: null,
    characteristicUuid,
    data,
  };
}

const registry = new DecoderRegistry();

describe("serial number (d905fe54)", () => {
  it("decodes the serial the AXS app displays", () => {
    const best = registry.best(frame(`d905fe54${SRAM_BASE}`, CAPTURE.serial))!;

    expect(best.decoder).toBe("axs/serial");
    expect(best.fields.axsSerial).toBe(1503603158);
    expect(best.fields.serialNumber).toBe("1503603158");
  });

  it("agrees with the serial embedded in the d905fff2 protobuf", () => {
    // Independent corroboration: the same serial arrives via a completely
    // different characteristic and encoding.
    const best = registry.best(frame(`d905fff2${SRAM_BASE}`, CAPTURE.identityProtobuf))!;

    expect(best.decoder).toBe("protobuf/structure");
    expect((best.fields.values as Record<string, string>)["25.22"]).toBe("1503603158");
  });
});

describe("model id (d905fe56)", () => {
  it("maps the captured id to the model the app displays", () => {
    const best = registry.best(frame(`d905fe56${SRAM_BASE}`, CAPTURE.model))!;

    expect(best.fields.axsModelId).toBe(1075);
    expect(best.fields.modelNumber).toBe("RD-GX-E-B1");
  });

  it("reports an unmapped id honestly rather than guessing", () => {
    const best = registry.best(frame(`d905fe56${SRAM_BASE}`, fromHex("ff 7f")))!;

    expect(best.fields.axsModelId).toBe(32767);
    expect(best.fields.modelNumber).toBeUndefined();
    expect(best.summary).toContain("unmapped");
    expect(best.confidence).toBeLessThan(0.9);
  });

  it("exposes the model table", () => {
    expect(axsModelName(1075)).toBe("RD-GX-E-B1");
    expect(axsModelName(999999)).toBeNull();
  });
});

describe("firmware version (d905fe58)", () => {
  it("decodes the version the app displays", () => {
    // Bytes are stored patch-first: 06 37 02 -> 2.55.6
    const version = decodeAxsFirmware(CAPTURE.deviceRecord)!;

    expect(version.text).toBe("2.55.6");
    expect(version.major).toBe(2);
    expect(version.minor).toBe(55);
    expect(version.patch).toBe(6);
  });

  it("recovers the git build identifier from the record tail", () => {
    const best = registry.best(frame(`d905fe58${SRAM_BASE}`, CAPTURE.deviceRecord))!;

    expect(best.decoder).toBe("axs/device-record");
    expect(best.fields.firmwareRevision).toBe("2.55.6");
    expect(best.fields.axsBuildId).toBe("g313caa0ed6.dir");
  });

  it("returns null for a truncated record instead of reading garbage", () => {
    expect(decodeAxsFirmware(fromHex("02 00"))).toBeNull();
  });
});

describe("microadjust (d905000a)", () => {
  it("decodes min/current/max exactly as the app shows them", () => {
    const adjust = decodeMicroAdjust(CAPTURE.microAdjust)!;

    expect(adjust.min).toBe(1);
    expect(adjust.current).toBe(12);
    expect(adjust.max).toBe(23);
  });

  it("surfaces microadjust through the registry", () => {
    const best = registry.best(frame(`d905000a${SRAM_BASE}`, CAPTURE.microAdjust))!;

    expect(best.decoder).toBe("axs/microadjust");
    expect(best.fields.microAdjustCurrent).toBe(12);
    expect(best.summary).toContain("range 1–23");
  });

  it("does not report a cog count", () => {
    // Field 24 read 12 on a 12-speed drivetrain and was initially mistaken for
    // a cassette cog count. The app's MicroAdjust screen disproved it. Guard
    // against that misreading creeping back in.
    const best = registry.best(frame(`d905000a${SRAM_BASE}`, CAPTURE.microAdjust))!;

    expect(best.fields.totalRear).toBeUndefined();
    expect(best.fields.gearRear).toBeUndefined();
  });

  it("returns null when the expected fields are absent", () => {
    expect(decodeMicroAdjust(fromHex("08 01"))).toBeNull();
  });
});

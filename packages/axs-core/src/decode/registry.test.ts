/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

import { describe, expect, it } from "vitest";

import { fromHex } from "../bytes.js";
import type { Decoder, RawFrame } from "../frame.js";
import { DecoderRegistry } from "./registry.js";

function frame(overrides: Partial<RawFrame> = {}): RawFrame {
  return {
    seq: 0,
    timestamp: 1_700_000_000_000,
    elapsedMs: 0,
    deviceId: "device-1",
    source: "notification",
    serviceUuid: null,
    characteristicUuid: null,
    data: new Uint8Array(0),
    ...overrides,
  };
}

describe("DecoderRegistry", () => {
  const registry = new DecoderRegistry();

  it("decodes Device Information strings with high confidence", () => {
    const results = registry.decode(
      frame({ characteristicUuid: "2a26", source: "read", data: fromHex("31 2e 32 38 2e 30") }),
    );

    const best = results[0]!;
    expect(best.decoder).toBe("gatt/device-information");
    expect(best.fields.firmwareRevision).toBe("1.28.0");
    expect(best.confidence).toBeGreaterThan(0.9);
  });

  it("strips trailing NUL padding from DIS strings", () => {
    const results = registry.decode(
      frame({ characteristicUuid: "2a24", source: "read", data: fromHex("47 58 00 00") }),
    );
    expect(results[0]!.fields.modelNumber).toBe("GX");
  });

  it("decodes the standard battery level", () => {
    const best = registry.best(
      frame({ characteristicUuid: "2a19", source: "read", data: fromHex("57") }),
    )!;

    expect(best.decoder).toBe("gatt/battery-level");
    expect(best.fields.batteryPercent).toBe(87);
  });

  it("flags vendor-defined characteristics as analysis targets", () => {
    const results = registry.decode(
      frame({ characteristicUuid: "f0000002-0451-4000-b000-000000000000", data: fromHex("aa") }),
    );

    expect(results.find((r) => r.decoder === "gatt/vendor-characteristic")).toBeDefined();
  });

  it("always produces at least the heuristic view", () => {
    const results = registry.decode(frame({ data: fromHex("de ad be ef") }));

    const heuristic = results.find((r) => r.decoder === "heuristic")!;
    expect(heuristic.fields.hex).toBe("de ad be ef");
    expect(results.length).toBeGreaterThan(0);
  });

  it("handles an empty payload without throwing", () => {
    expect(() => registry.decode(frame({ data: new Uint8Array(0) }))).not.toThrow();
    expect(registry.best(frame({ data: new Uint8Array(0) }))?.summary).toContain("empty");
  });

  it("sorts results by descending confidence", () => {
    const results = registry.decode(
      frame({ characteristicUuid: "2a26", source: "read", data: fromHex("31 2e 30") }),
    );
    const confidences = results.map((r) => r.confidence);
    expect([...confidences].sort((a, b) => b - a)).toEqual(confidences);
  });

  it("isolates a throwing decoder instead of losing the frame", () => {
    const exploding: Decoder = {
      name: "exploding",
      decode() {
        throw new Error("boom");
      },
    };

    const local = new DecoderRegistry([exploding]);
    const results = local.decode(frame({ data: fromHex("01") }));

    expect(results).toHaveLength(1);
    expect(results[0]!.summary).toContain("boom");
    expect(results[0]!.fields.error).toBe(true);
  });

  it("supports adding and removing decoders", () => {
    const local = new DecoderRegistry([]);
    expect(local.decode(frame())).toHaveLength(0);

    local.add({
      name: "custom",
      decode: () => ({ decoder: "custom", confidence: 1, summary: "hi", fields: {} }),
    });
    expect(local.decode(frame())).toHaveLength(1);

    local.remove("custom");
    expect(local.decode(frame())).toHaveLength(0);
  });

  it("returns null from best() when no decoder matches", () => {
    expect(new DecoderRegistry([]).best(frame())).toBeNull();
  });
});

/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

import { describe, expect, it } from "vitest";

import {
  bytesEqual,
  fromBase64,
  fromHex,
  hexDump,
  toBase64,
  toHex,
  toPrintableAscii,
  toUtf8,
  u16be,
  u16le,
  u24le,
  u32be,
  u32le,
} from "./bytes.js";

describe("base64", () => {
  it("round-trips arbitrary bytes", () => {
    const original = Uint8Array.from([0, 1, 2, 127, 128, 255, 42]);
    expect(bytesEqual(fromBase64(toBase64(original)), original)).toBe(true);
  });

  it("matches known vectors", () => {
    // "Man" -> "TWFu" is the canonical RFC 4648 example.
    expect(toBase64(Uint8Array.from([0x4d, 0x61, 0x6e]))).toBe("TWFu");
    expect(toHex(fromBase64("TWFu"))).toBe("4d 61 6e");
  });

  it("pads correctly for each remainder", () => {
    expect(toBase64(Uint8Array.from([0x4d]))).toBe("TQ==");
    expect(toBase64(Uint8Array.from([0x4d, 0x61]))).toBe("TWE=");
    expect(toBase64(Uint8Array.from([0x4d, 0x61, 0x6e]))).toBe("TWFu");
  });

  it("handles the empty array", () => {
    expect(toBase64(new Uint8Array(0))).toBe("");
    expect(fromBase64("").length).toBe(0);
  });

  it("tolerates whitespace and stray characters in input", () => {
    expect(toHex(fromBase64("TW\nFu  "))).toBe("4d 61 6e");
  });

  it("round-trips every single byte value", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(bytesEqual(fromBase64(toBase64(all)), all)).toBe(true);
  });
});

describe("hex", () => {
  it("formats with a separator", () => {
    expect(toHex(Uint8Array.from([0x01, 0xab, 0xff]))).toBe("01 ab ff");
    expect(toHex(Uint8Array.from([0x01, 0xab]), "")).toBe("01ab");
  });

  it("parses tolerant input", () => {
    expect(toHex(fromHex("01ABff"))).toBe("01 ab ff");
    expect(toHex(fromHex("01 ab ff"))).toBe("01 ab ff");
    expect(toHex(fromHex("0x01:0xab-0xff"))).toBe("01 ab ff");
  });

  it("rejects an odd digit count", () => {
    expect(() => fromHex("abc")).toThrow(/odd number/i);
  });
});

describe("integer readers", () => {
  const bytes = Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x05]);

  it("reads little-endian", () => {
    expect(u16le(bytes, 0)).toBe(0x0201);
    expect(u24le(bytes, 0)).toBe(0x030201);
    expect(u32le(bytes, 0)).toBe(0x04030201);
  });

  it("reads big-endian", () => {
    expect(u16be(bytes, 0)).toBe(0x0102);
    expect(u32be(bytes, 0)).toBe(0x01020304);
  });

  it("honours the offset", () => {
    expect(u16le(bytes, 1)).toBe(0x0302);
  });

  it("keeps 32-bit reads unsigned", () => {
    const high = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);
    expect(u32le(high, 0)).toBe(4294967295);
    expect(u32be(high, 0)).toBe(4294967295);
  });
});

describe("text", () => {
  it("substitutes non-printable bytes", () => {
    expect(toPrintableAscii(Uint8Array.from([0x41, 0x00, 0x42, 0xff]))).toBe("A.B.");
  });

  it("decodes ASCII as UTF-8", () => {
    expect(toUtf8(Uint8Array.from([0x53, 0x52, 0x41, 0x4d]))).toBe("SRAM");
  });

  it("decodes multi-byte UTF-8", () => {
    // "é" = C3 A9, "€" = E2 82 AC
    expect(toUtf8(Uint8Array.from([0xc3, 0xa9]))).toBe("é");
    expect(toUtf8(Uint8Array.from([0xe2, 0x82, 0xac]))).toBe("€");
  });

  it("does not throw on malformed sequences", () => {
    expect(() => toUtf8(Uint8Array.from([0xff, 0xfe]))).not.toThrow();
  });
});

describe("hexDump", () => {
  it("renders offset, hex and ascii columns", () => {
    const dump = hexDump(Uint8Array.from([0x41, 0x42, 0x43]));
    expect(dump).toContain("00000000");
    expect(dump).toContain("41 42 43");
    expect(dump).toContain("|ABC|");
  });

  it("wraps at the row width", () => {
    const dump = hexDump(new Uint8Array(20), 16);
    expect(dump.split("\n")).toHaveLength(2);
  });
});

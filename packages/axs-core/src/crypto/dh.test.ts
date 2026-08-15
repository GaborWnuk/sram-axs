/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

import { describe, expect, it } from "vitest";

import { fromHex, toHex } from "../bytes.js";
import { bigIntToBytes, bytesToBigInt, modPow, publicKey, sharedSecret, type DhGroup } from "./dh.js";

describe("byte <-> bigint conversion", () => {
  it("round-trips big-endian", () => {
    const b = fromHex("0102030405060708090a0b0c0d0e0f10");
    expect(toHex(bigIntToBytes(bytesToBigInt(b, "be"), 16, "be"), "")).toBe(toHex(b, ""));
  });

  it("little-endian reverses byte order", () => {
    expect(bytesToBigInt(fromHex("01000000"), "le")).toBe(1n);
    expect(bytesToBigInt(fromHex("00000001"), "be")).toBe(1n);
  });
});

describe("modPow", () => {
  it("matches a known modular exponentiation", () => {
    // 4^13 mod 497 = 445 (classic RSA textbook example)
    expect(modPow(4n, 13n, 497n)).toBe(445n);
  });
});

describe("Diffie-Hellman agreement", () => {
  // A small but real prime group, just to prove both sides converge. The real
  // SRAMBond group is pinned in the srambond module from the capture.
  const group: DhGroup = { modulus: 0xfffffffffffffffbn, generator: 5n, keyLength: 8, order: "be" };

  it("both parties derive the same shared secret", () => {
    const a = fromHex("0000000000000007");
    const b = fromHex("0000000000000011");
    const A = publicKey(group, a);
    const B = publicKey(group, b);
    const sa = sharedSecret(group, a, B);
    const sb = sharedSecret(group, b, A);
    expect(toHex(sa, "")).toBe(toHex(sb, ""));
  });
});

/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

import { describe, expect, it } from "vitest";

import { fromHex, toHex } from "../bytes.js";
import { _internal, cmac, eaxDecrypt, eaxEncrypt } from "./aes-eax.js";

/** Contiguous lower-case hex, matching the published test-vector notation. */
const hx = (b: Uint8Array): string => toHex(b, "");

describe("AES block (FIPS-197)", () => {
  it("encrypts the FIPS-197 AES-128 test vector", () => {
    const key = new _internal.AesKey(fromHex("000102030405060708090a0b0c0d0e0f"));
    expect(hx(key.encryptBlock(fromHex("00112233445566778899aabbccddeeff")))).toBe(
      "69c4e0d86a7b0430d8cdb78070b4c55a",
    );
  });

  it("encrypts the FIPS-197 AES-256 test vector", () => {
    const key = new _internal.AesKey(
      fromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"),
    );
    expect(hx(key.encryptBlock(fromHex("00112233445566778899aabbccddeeff")))).toBe(
      "8ea2b7ca516745bfeafc49904b496089",
    );
  });
});

describe("AES-CMAC (NIST SP 800-38B, AES-128)", () => {
  const key = new _internal.AesKey(fromHex("2b7e151628aed2a6abf7158809cf4f3c"));

  it("CMAC of the empty message", () => {
    expect(hx(cmac(key, new Uint8Array(0)))).toBe("bb1d6929e95937287fa37d129b756746");
  });

  it("CMAC of a single full block", () => {
    expect(hx(cmac(key, fromHex("6bc1bee22e409f96e93d7e117393172a")))).toBe(
      "070a16b46b4d4144f79bdd9dd04a287c",
    );
  });
});

describe("AES-EAX (published test vectors)", () => {
  it("authenticates an empty message (tag only)", () => {
    const sealed = eaxEncrypt(
      fromHex("233952dee4d5ed5f9b9c6d6ff80ff478"),
      fromHex("62ec67f9c3a4a407fcb2a8c49031a8b3"),
      new Uint8Array(0),
      { header: fromHex("6bfb914fd07eae6b") },
    );
    expect(hx(sealed)).toBe("e037830e8389f27b025a2d6527e79d01");
  });

  it("seals a short message with header", () => {
    const sealed = eaxEncrypt(
      fromHex("91945d3f4dcbee0bf45ef52255f095a4"),
      fromHex("becaf043b0a23d843194ba972c66debd"),
      fromHex("f7fb"),
      { header: fromHex("fa3bfd4806eb53fa") },
    );
    expect(hx(sealed)).toBe("19dd5c4c9331049d0bdab0277408f67967e5");
  });

  it("round-trips seal then open", () => {
    const key = fromHex("8395fcf1e95bebd697bd010bc766aac3");
    const nonce = fromHex("22e7add93cfc6393c57ec0b3c17d6b44");
    const header = fromHex("126735fcc320d25a");
    const msg = fromHex("ca40d7446e545ffaed3bd12a740a659ffbbb3ceab7");
    const sealed = eaxEncrypt(key, nonce, msg, { header });
    expect(hx(eaxDecrypt(key, nonce, sealed, { header }))).toBe(hx(msg));
  });

  it("rejects a tampered tag", () => {
    const key = fromHex("8395fcf1e95bebd697bd010bc766aac3");
    const nonce = fromHex("22e7add93cfc6393c57ec0b3c17d6b44");
    const sealed = eaxEncrypt(key, nonce, fromHex("deadbeef"));
    const last = sealed.length - 1;
    sealed[last] = (sealed[last]! ^ 0x01) & 0xff;
    expect(() => eaxDecrypt(key, nonce, sealed)).toThrow(/tag mismatch/);
  });
});

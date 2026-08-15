/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

import { describe, expect, it } from "vitest";

import { fromHex } from "../bytes.js";
import { decodeSrambondState, decryptLiveStateFrame } from "./srambond.js";

/**
 * Ground truth: 41-byte `d905000b` frames captured from a real RD-GX-E-B1 over a
 * full 1→12→1 cassette sweep, decrypted here with the device's AES-EAX key.
 * Each must decode to its physical gear. This is the end-to-end proof that the
 * pure-TS EAX + protobuf pipeline reproduces the hardware exactly.
 */
const DEVICE_KEY = fromHex("1f1dd977bc1c6707e6da9b811608f456");

const SWEEP: Array<[number, string]> = [
  [1, "597c1e0ca539c9e80c9e5f010ac5274a22419e2dcbee1f99fe1b7ce7fae2a4def1caffddbe325cbfc8"],
  [2, "f1dc85b564d7e5fd5468c0464146c63c6c899039efe255ef0c8845cbe308b1ed02758efc9e20efc702"],
  [3, "869d5f7a87594d7ea68c60e6bd6764b010083bf9be39ea40e73474acd776192ed09e2a2fed5b83c9a0"],
  [4, "9e3cd4694e9d8b945c4e3ec25fd0d637143c0a2b5d0f3f0cc70203c57a3c6c60521529025693e16111"],
  [5, "8bbc0d50e75d567a3fa5c0d76c6b778535c0da71e0151a10f70f5301c2f2804f002e71d098512622b9"],
  [6, "5d742bef1643b0406518c8a8670f9a0c3768f5ca587043d37a559d48c30be0ece2c500bcb9a2945703"],
  [7, "174d634b6f0dfc866d918339d09f4dc209e31b9c9213bf466b40743b3f9230da1e74fddb0481f60de9"],
  [8, "5363007cb1b928e9a4ff59b43b9a095cdb271bcb5b55bbeb3a383023a0c90b60ed5e5e38f2afe21e94"],
  [9, "55d20530ad3948ce67bcede8314e2a633fcc532099514f15d450c69d69510575ade4ffa01496c1f0bc"],
  [10, "11bc0a75a29a8dbc07213496208d471a3d7af168e3de323cb9c8d3ea3beca3b3ae53911f832f32b9b6"],
  [11, "84b47cd4f0e8e6bd56a06d141a661d1ebb58760e061580292796a4e71de9257b06cf0725433c5186a8"],
  [12, "be32c0a36b2542d6b095937cba5967391a40f47819b235de6557d17e8275b6d81c55354b14b119eb22"],
];

describe("SRAMBond live-state decryption (real captured frames)", () => {
  for (const [gear, frameHex] of SWEEP) {
    it(`d905000b frame decrypts to gear ${gear}`, () => {
      const status = decodeSrambondState(DEVICE_KEY, fromHex(frameHex));
      expect(status.gearRear).toBe(gear);
      // fd_position and rd_trim are stable across the sweep on this 1x transmission.
      expect(status.gearFront).toBe(1);
      expect(status.trimRear).toBe(12);
    });
  }

  it("decrypts to the exact drivetrain_status plaintext", () => {
    // gear 7 frame -> a0 01 01  a8 01 07  b0 01 0c
    const pt = decryptLiveStateFrame(DEVICE_KEY, fromHex(SWEEP[6]![1]));
    expect(Array.from(pt)).toEqual([0xa0, 0x01, 0x01, 0xa8, 0x01, 0x07, 0xb0, 0x01, 0x0c]);
  });

  it("rejects a frame decrypted with the wrong key", () => {
    const wrong = fromHex("00000000000000000000000000000000");
    expect(() => decryptLiveStateFrame(wrong, fromHex(SWEEP[0]![1]))).toThrow(/tag mismatch/);
  });

  it("rejects a truncated frame", () => {
    expect(() => decryptLiveStateFrame(DEVICE_KEY, fromHex("0011223344"))).toThrow(/too short/);
  });
});

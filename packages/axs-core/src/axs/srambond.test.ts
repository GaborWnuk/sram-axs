/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

import { describe, expect, it } from "vitest";

import { fromHex } from "../bytes.js";
import {
  RD_GX_E_B1_DEVICE_KEY as DEVICE_KEY,
  RD_GX_E_B1_SWEEP as SWEEP,
} from "../testing/rd-gx-e-b1-capture.js";
import { decodeSrambondState, decryptLiveStateFrame } from "./srambond.js";

/**
 * Ground truth: 41-byte `d905000b` frames captured from a real RD-GX-E-B1 over a
 * full 1→12→1 cassette sweep, decrypted here with the device's AES-EAX key.
 * Each must decode to its physical gear. This is the end-to-end proof that the
 * pure-TS EAX + protobuf pipeline reproduces the hardware exactly.
 *
 * The corpus itself lives in `testing/rd-gx-e-b1-capture.ts`, which documents
 * its provenance and is shared with the characterization test. Keeping one copy
 * matters for more than tidiness: the key is a live device credential, and a
 * second transcription of it is a second thing to remember to rotate.
 */

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

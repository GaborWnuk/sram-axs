/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * The reference capture: real bytes from a real component.
 *
 * Everything here was read off a SRAM GX Eagle Transmission (`RD-GX-E-B1`,
 * firmware 2.55.6) on the bench, and cross-checked against what the official
 * SRAM AXS app displayed for the same component at the same moment:
 *
 *     Component     GX RD
 *     Model         RD-GX-E-B1
 *     Serial        1234567890   (placeholder — see below)
 *     Firmware      2.55.6
 *     MicroAdjust   min 1, current 12, max 23
 *
 * The component's serial has been replaced with the placeholder 1234567890
 * everywhere it appears — in decoded values *and* in the bytes that encode it,
 * in both the little-endian uint32 of `d905fe54` and the protobuf varint of
 * `d905fff2`. Every other byte is exactly as captured.
 *
 * This module is the single home for that corpus. It is deliberately not
 * exported from `index.ts`: it is test ground truth, not API, and tsup only
 * bundles what the barrel reaches, so it never ships.
 *
 * ## What this is for
 *
 * Two different jobs, which is why it lives here rather than inside one test:
 *
 *   - proving the crypto and the decoders reproduce the hardware exactly
 *     (`axs/srambond.test.ts`);
 *   - proving a *refactor* did not change what a consumer ends up seeing
 *     (`characterization.test.ts`), by replaying the whole capture through the
 *     pipeline and comparing the resulting state against a recorded snapshot.
 *
 * The second is why the frames are assembled into a real {@link SessionDocument}
 * rather than left as loose hex: it exercises the actual
 * `loadSession` → registry → aggregator path a consumer uses.
 */

import { fromHex } from "../bytes.js";
import type { RawFrame } from "../frame.js";
import { serializeFrame, type SessionDocument } from "../recorder.js";

/** SRAM's 128-bit vendor UUID base. */
const SRAM_BASE = "-90aa-4c7c-b036-1e01fb8eb7ee";

const sram = (short: string): string => `d905${short}${SRAM_BASE}`;

/**
 * The component's live-state key, recovered by running the SRAMBond handshake
 * against it.
 *
 * Per-device and device-minted: it decrypts this one component's live state and
 * nothing else, it grants no write access, and re-bonding makes the component
 * mint a fresh one that invalidates it (see SECURITY.md §2.4). It is committed
 * because the captured frames below are worthless without it — they are the
 * only proof that the pure-TypeScript AES-EAX implementation reproduces what
 * the hardware actually produced.
 */
export const RD_GX_E_B1_DEVICE_KEY = fromHex("1f1dd977bc1c6707e6da9b811608f456");

/**
 * Plaintext reads from the identity characteristics.
 *
 * These need no key — they are readable from any central in range, which is
 * itself a documented finding (PROTOCOL.md §3).
 */
export const RD_GX_E_B1_READS: ReadonlyArray<{ characteristic: string; hex: string }> = [
  // d905fe54 — serial, little-endian uint32. Placeholder value.
  { characteristic: sram("fe54"), hex: "d2029649" },
  // d905fe56 — model id 1075, little-endian uint16.
  { characteristic: sram("fe56"), hex: "3304" },
  // d905fe58 — device record: firmware triplet at offset 5 (patch-first,
  // 06 37 02 = 2.55.6) then the ASCII git build id.
  {
    characteristic: sram("fe58"),
    hex:
      "0200000000063702000002015401000000010106402805" +
      "0067333133636161306564362e64697200",
  },
  // d905000a — MicroAdjust: protobuf varints 23/24/25 = min/current/max.
  { characteristic: sram("000a"), hex: "b80101c0010cc80117" },
  // d905fff2 — identity protobuf; field 25 → nested 22 carries the serial again.
  { characteristic: sram("fff2"), hex: "ca010ab001d285d8cc04b80101" },
];

/**
 * A full 1→12→1 cassette sweep on the encrypted live-state channel.
 *
 * 41-byte `d905000b` frames, `nonce(16) ‖ ciphertext(9) ‖ tag(16)`, each
 * decrypting to a `drivetrain_status` whose field 21 is the physical gear the
 * bike was in when it was captured.
 */
export const RD_GX_E_B1_SWEEP: ReadonlyArray<readonly [gear: number, hex: string]> = [
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

/** The live-state characteristic the sweep was captured from. */
export const RD_GX_E_B1_LIVE_STATE = sram("000b");

/** Fixed epoch for the capture, so replays are byte-for-byte reproducible. */
const CAPTURE_STARTED_AT = 1_754_000_000_000;

/** One frame per read, 250 ms apart — the poll interval used on the bench. */
function captureFrame(seq: number, characteristicUuid: string, hex: string): RawFrame {
  return {
    seq,
    timestamp: CAPTURE_STARTED_AT + seq * 250,
    elapsedMs: seq * 250,
    deviceId: "rd-gx-e-b1",
    source: "read",
    // Not recorded on the bench: the decoders key off the characteristic, and
    // inventing a service UUID would put a value in the corpus that no
    // hardware produced.
    serviceUuid: null,
    characteristicUuid,
    data: fromHex(hex),
  };
}

/**
 * The capture as a replayable session document.
 *
 * Frame order matches the bench run: the identity read pass first, then the
 * cassette sweep. Timestamps are fixed rather than generated, so replaying this
 * twice produces identical state — which is what makes a characterization
 * snapshot meaningful.
 */
export function rdGxEB1Session(): SessionDocument {
  const frames: RawFrame[] = [];

  RD_GX_E_B1_READS.forEach(({ characteristic, hex }) => {
    frames.push(captureFrame(frames.length, characteristic, hex));
  });

  for (const [, hex] of RD_GX_E_B1_SWEEP) {
    frames.push(captureFrame(frames.length, RD_GX_E_B1_LIVE_STATE, hex));
  }

  const last = frames[frames.length - 1];

  return {
    version: 1,
    deviceId: "rd-gx-e-b1",
    deviceName: "SRAM 1234567890",
    startedAt: CAPTURE_STARTED_AT,
    endedAt: last ? last.timestamp : CAPTURE_STARTED_AT,
    notes:
      "GX Eagle Transmission RD-GX-E-B1, firmware 2.55.6. Identity read pass " +
      "followed by a 1→12 cassette sweep on the encrypted live-state channel. " +
      "Serial replaced with the placeholder 1234567890 in both decoded values " +
      "and encoded bytes.",
    metadata: {
      model: "RD-GX-E-B1",
      firmware: "2.55.6",
      capturedWith: "axs probe",
      // Device Information Service strings, the battery level and the
      // d9050003 usage record were not part of this capture, so nothing here
      // exercises those paths.
      characteristics: ["d905fe54", "d905fe56", "d905fe58", "d905000a", "d905fff2", "d905000b"],
    },
    frames: frames.map(serializeFrame),
  };
}

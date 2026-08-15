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
  ByteChangeTracker,
  analyzeBytes,
  integerCandidates,
  shannonEntropy,
} from "./heuristics.js";

describe("shannonEntropy", () => {
  it("is zero for a uniform buffer", () => {
    expect(shannonEntropy(new Uint8Array(16))).toBe(0);
  });

  it("is 1 bit for two equally likely values", () => {
    expect(shannonEntropy(Uint8Array.from([0, 1, 0, 1]))).toBeCloseTo(1, 5);
  });

  it("approaches 8 bits for a full byte range", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(shannonEntropy(all)).toBeCloseTo(8, 5);
  });

  it("is zero for an empty buffer rather than NaN", () => {
    expect(shannonEntropy(new Uint8Array(0))).toBe(0);
  });
});

describe("integerCandidates", () => {
  it("offers 8-, 16- and 32-bit readings in both endiannesses", () => {
    const candidates = integerCandidates(fromHex("01 02 03 04"));

    expect(candidates).toContainEqual({ offset: 0, width: 1, endianness: "n/a", value: 1 });
    expect(candidates).toContainEqual({ offset: 0, width: 2, endianness: "le", value: 0x0201 });
    expect(candidates).toContainEqual({ offset: 0, width: 2, endianness: "be", value: 0x0102 });
    expect(candidates).toContainEqual({
      offset: 0,
      width: 4,
      endianness: "le",
      value: 0x04030201,
    });
  });

  it("does not read past the end of the buffer", () => {
    const candidates = integerCandidates(fromHex("01 02"));
    expect(candidates.every((c) => c.offset + c.width <= 2)).toBe(true);
  });

  it("caps the offsets it enumerates", () => {
    const candidates = integerCandidates(new Uint8Array(200), 8);
    expect(Math.max(...candidates.map((c) => c.offset))).toBeLessThan(8);
  });
});

describe("analyzeBytes", () => {
  it("detects an all-printable payload as text", () => {
    const analysis = analyzeBytes(fromHex("53 52 41 4d")); // "SRAM"

    expect(analysis.looksLikeText).toBe(true);
    expect(analysis.ascii).toBe("SRAM");
  });

  it("does not call a payload with control bytes text", () => {
    expect(analyzeBytes(fromHex("53 00 41 4d")).looksLikeText).toBe(false);
  });

  it("reports zero length for an empty payload", () => {
    expect(analyzeBytes(new Uint8Array(0)).length).toBe(0);
  });
});

describe("ByteChangeTracker", () => {
  it("identifies which offset carries the changing field", () => {
    // This is the core reverse-engineering workflow: shift gears, then look for
    // the byte whose change count matches the number of shifts.
    const tracker = new ByteChangeTracker();
    tracker.add(fromHex("01 00 ff 01"));
    tracker.add(fromHex("01 00 ff 02"));
    tracker.add(fromHex("01 00 ff 03"));
    tracker.add(fromHex("01 00 ff 04"));

    const report = tracker.report();
    expect(report[0]!.offset).toBe(3);
    expect(report[0]!.changes).toBe(3);
    expect(report[0]!.minValue).toBe(1);
    expect(report[0]!.maxValue).toBe(4);
  });

  it("reports unchanging offsets as the frame skeleton", () => {
    const tracker = new ByteChangeTracker();
    tracker.add(fromHex("01 00 ff 01"));
    tracker.add(fromHex("01 00 ff 02"));

    expect(tracker.constantOffsets()).toEqual([0, 1, 2]);
  });

  it("counts transitions, not distinct values", () => {
    const tracker = new ByteChangeTracker();
    tracker.add(fromHex("01"));
    tracker.add(fromHex("02"));
    tracker.add(fromHex("01"));

    const stats = tracker.report()[0]!;
    expect(stats.changes).toBe(2);
    expect(stats.distinctValues).toBe(2);
  });

  it("does not count a change on the very first frame", () => {
    const tracker = new ByteChangeTracker();
    tracker.add(fromHex("aa"));
    expect(tracker.report()[0]!.changes).toBe(0);
  });

  it("tracks the frame count", () => {
    const tracker = new ByteChangeTracker();
    tracker.add(fromHex("01"));
    tracker.add(fromHex("02"));
    expect(tracker.frameCount).toBe(2);
  });

  it("copes with frames of differing length", () => {
    const tracker = new ByteChangeTracker();
    tracker.add(fromHex("01 02"));
    tracker.add(fromHex("01 02 03 04"));

    expect(() => tracker.report()).not.toThrow();
    expect(tracker.report()).toHaveLength(4);
  });

  it("bounds the distinct-value set it retains", () => {
    const tracker = new ByteChangeTracker(4);
    for (let i = 0; i < 50; i++) tracker.add(Uint8Array.from([i]));
    expect(tracker.report()[0]!.distinctValues).toBe(4);
  });

  it("clears its state on reset", () => {
    const tracker = new ByteChangeTracker();
    tracker.add(fromHex("01"));
    tracker.reset();

    expect(tracker.frameCount).toBe(0);
    expect(tracker.report()).toHaveLength(0);
  });
});

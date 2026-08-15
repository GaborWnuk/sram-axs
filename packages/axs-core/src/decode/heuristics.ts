/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * Heuristics for frames whose meaning is unknown.
 *
 * This is the heart of the reconnaissance workflow. You will be staring at
 * unlabelled byte blobs from an undocumented GATT service, and the two
 * questions that actually crack a protocol are:
 *
 *   "which bytes changed when I did that thing?"  -> {@link ByteChangeTracker}
 *   "could this field plausibly be X?"            -> {@link analyzeBytes}
 */

import {
  toHex,
  toPrintableAscii,
  u16be,
  u16le,
  u32be,
  u32le,
} from "../bytes.js";

export interface IntegerCandidate {
  offset: number;
  width: 1 | 2 | 4;
  endianness: "le" | "be" | "n/a";
  value: number;
}

export interface ByteAnalysis {
  length: number;
  hex: string;
  ascii: string;
  /** True when every byte is printable ASCII — the frame is probably a string. */
  looksLikeText: boolean;
  /** Shannon entropy in bits per byte. High values suggest encryption or compression. */
  entropy: number;
  /** Every reasonable integer reading, for eyeballing against known values. */
  integers: IntegerCandidate[];
}

/** Shannon entropy in bits per byte, 0..8. */
export function shannonEntropy(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;

  const counts = new Array<number>(256).fill(0);
  for (let i = 0; i < bytes.length; i++) {
    counts[bytes[i] as number] = (counts[bytes[i] as number] as number) + 1;
  }

  let entropy = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const p = count / bytes.length;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

/**
 * Enumerate integer readings of a payload.
 *
 * Capped at 32 bytes because beyond that the candidate list stops being
 * something a human can scan and the tracker is the better tool.
 */
export function integerCandidates(bytes: Uint8Array, maxOffset = 32): IntegerCandidate[] {
  const out: IntegerCandidate[] = [];
  const limit = Math.min(bytes.length, maxOffset);

  for (let i = 0; i < limit; i++) {
    out.push({ offset: i, width: 1, endianness: "n/a", value: bytes[i] as number });
  }
  for (let i = 0; i + 1 < limit; i++) {
    out.push({ offset: i, width: 2, endianness: "le", value: u16le(bytes, i) });
    out.push({ offset: i, width: 2, endianness: "be", value: u16be(bytes, i) });
  }
  for (let i = 0; i + 3 < limit; i++) {
    out.push({ offset: i, width: 4, endianness: "le", value: u32le(bytes, i) });
    out.push({ offset: i, width: 4, endianness: "be", value: u32be(bytes, i) });
  }

  return out;
}

/** Run every heuristic over a payload. */
export function analyzeBytes(bytes: Uint8Array): ByteAnalysis {
  const ascii = toPrintableAscii(bytes);
  const printableCount = ascii.split("").filter((c) => c !== ".").length;

  return {
    length: bytes.length,
    hex: toHex(bytes),
    ascii,
    looksLikeText: bytes.length > 0 && printableCount === bytes.length,
    entropy: shannonEntropy(bytes),
    integers: integerCandidates(bytes),
  };
}

/** Per-offset statistics accumulated across many frames. */
export interface ByteStats {
  offset: number;
  /** How many times this offset changed value between consecutive frames. */
  changes: number;
  /** Distinct values observed. Capped to keep memory bounded. */
  distinctValues: number;
  minValue: number;
  maxValue: number;
  lastValue: number;
  /** True when the byte never changed — likely a constant, header or padding. */
  constant: boolean;
}

/**
 * Tracks which byte offsets vary across a stream of same-shaped frames.
 *
 * Workflow: park the app on one characteristic, shift through the cassette, then
 * read the report. The offset with a change count matching your shift count is
 * your gear byte. This turns protocol reverse engineering from guesswork into
 * something closer to a controlled experiment.
 */
export class ByteChangeTracker {
  private previous: Uint8Array | null = null;
  private readonly changes: number[] = [];
  private readonly values: Array<Set<number>> = [];
  private readonly mins: number[] = [];
  private readonly maxs: number[] = [];
  /**
   * Most recent value seen *at each offset*.
   *
   * Tracked separately rather than read out of `previous`, because frames on
   * one characteristic vary in length: a short final frame would otherwise make
   * every higher offset report 0, which reads as real data and is not.
   */
  private readonly lasts: number[] = [];
  private frames = 0;

  /** Cap on distinct values retained per offset, to bound memory. */
  constructor(private readonly maxDistinctPerOffset = 64) {}

  add(bytes: Uint8Array): void {
    this.frames++;

    for (let i = 0; i < bytes.length; i++) {
      const value = bytes[i] as number;

      if (this.changes[i] === undefined) {
        this.changes[i] = 0;
        this.values[i] = new Set();
        this.mins[i] = value;
        this.maxs[i] = value;
      }

      const set = this.values[i] as Set<number>;
      if (set.size < this.maxDistinctPerOffset) set.add(value);

      this.mins[i] = Math.min(this.mins[i] as number, value);
      this.maxs[i] = Math.max(this.maxs[i] as number, value);
      this.lasts[i] = value;

      const prev = this.previous?.[i];
      if (prev !== undefined && prev !== value) {
        this.changes[i] = (this.changes[i] as number) + 1;
      }
    }

    this.previous = bytes.slice();
  }

  get frameCount(): number {
    return this.frames;
  }

  /** Per-offset report, most-volatile offsets first. */
  report(): ByteStats[] {
    const stats: ByteStats[] = [];

    for (let i = 0; i < this.changes.length; i++) {
      if (this.changes[i] === undefined) continue;
      stats.push({
        offset: i,
        changes: this.changes[i] as number,
        distinctValues: (this.values[i] as Set<number>).size,
        minValue: this.mins[i] as number,
        maxValue: this.maxs[i] as number,
        lastValue: this.lasts[i] as number,
        constant: (this.changes[i] as number) === 0,
      });
    }

    return stats.sort((a, b) => b.changes - a.changes);
  }

  /** Offsets that never changed — the frame's skeleton. */
  constantOffsets(): number[] {
    return this.report()
      .filter((s) => s.constant)
      .map((s) => s.offset)
      .sort((a, b) => a - b);
  }

  reset(): void {
    this.previous = null;
    this.changes.length = 0;
    this.values.length = 0;
    this.mins.length = 0;
    this.maxs.length = 0;
    this.lasts.length = 0;
    this.frames = 0;
  }
}

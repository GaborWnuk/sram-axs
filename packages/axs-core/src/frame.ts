/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * The raw frame — the atom of the logger.
 *
 * Design rule: frames are captured and stored *without interpretation*. Decoding
 * happens later, as a pure function over stored frames. That separation is what
 * lets you re-run a new decoder hypothesis against yesterday's capture instead
 * of having to get back on the bike.
 */

/** Where a frame came from. */
export type FrameSource =
  | "advertisement"
  | "read"
  | "notification"
  | "indication"
  | "write";

export interface RawFrame {
  /** Monotonic sequence number within a session. */
  seq: number;
  /** Milliseconds since epoch. */
  timestamp: number;
  /** Milliseconds since the session started. Easier to reason about when scrubbing a log. */
  elapsedMs: number;
  deviceId: string;
  source: FrameSource;
  serviceUuid: string | null;
  characteristicUuid: string | null;
  data: Uint8Array;
  /** Free-form marker the operator can attach, e.g. "shifted to cog 5". */
  label?: string;
}

/** A frame plus every decoder's opinion of it. */
export interface AnnotatedFrame {
  frame: RawFrame;
  decodings: DecodedResult[];
}

export interface DecodedResult {
  /** Name of the decoder that produced this. */
  decoder: string;
  /** 0..1. Heuristic decoders sit low; exact UUID matches sit high. */
  confidence: number;
  /** One-line human summary for the log view. */
  summary: string;
  /** Structured output, decoder-specific. */
  fields: Record<string, unknown>;
}

export interface Decoder {
  name: string;
  /** Return null when this decoder has nothing to say about the frame. */
  decode(frame: RawFrame): DecodedResult | null;
}

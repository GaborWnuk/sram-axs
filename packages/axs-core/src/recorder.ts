/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * Session recording.
 *
 * A capture is worth far more than a live view: you can replay it against a
 * decoder you write next week. Sessions serialise to plain JSON with base64
 * payloads so they can be shared, diffed and committed as test fixtures.
 */

import { fromBase64, toBase64 } from "./bytes.js";
import type { RawFrame } from "./frame.js";
import type { DeviceSession } from "./probe.js";
import type { Unsubscribe } from "./emitter.js";
import { clearTimeoutCompat, setTimeoutCompat, type TimerHandle } from "./timers.js";

/** Serialised form of a frame. */
export interface SerializedFrame {
  seq: number;
  timestamp: number;
  elapsedMs: number;
  deviceId: string;
  source: string;
  serviceUuid: string | null;
  characteristicUuid: string | null;
  /** Base64-encoded payload. */
  data: string;
  label?: string;
}

export interface SessionDocument {
  /** Bumped when the on-disk shape changes. */
  version: 1;
  deviceId: string;
  deviceName: string | null;
  startedAt: number;
  endedAt: number | null;
  /** Free-form notes the operator adds, e.g. bike/component/firmware. */
  notes: string;
  /** Arbitrary operator-supplied context. */
  metadata: Record<string, unknown>;
  frames: SerializedFrame[];
}

export function serializeFrame(frame: RawFrame): SerializedFrame {
  const out: SerializedFrame = {
    seq: frame.seq,
    timestamp: frame.timestamp,
    elapsedMs: frame.elapsedMs,
    deviceId: frame.deviceId,
    source: frame.source,
    serviceUuid: frame.serviceUuid,
    characteristicUuid: frame.characteristicUuid,
    data: toBase64(frame.data),
  };
  if (frame.label !== undefined) out.label = frame.label;
  return out;
}

export function deserializeFrame(frame: SerializedFrame): RawFrame {
  const out: RawFrame = {
    seq: frame.seq,
    timestamp: frame.timestamp,
    elapsedMs: frame.elapsedMs,
    deviceId: frame.deviceId,
    source: frame.source as RawFrame["source"],
    serviceUuid: frame.serviceUuid,
    characteristicUuid: frame.characteristicUuid,
    data: fromBase64(frame.data),
  };
  if (frame.label !== undefined) out.label = frame.label;
  return out;
}

/**
 * Collects frames from a session.
 *
 * `maxFrames` bounds memory — a 4 Hz notification stream left running for an
 * hour is ~14k frames, which is fine, but an unthrottled vendor stream is not.
 * When the cap is hit the oldest frames are dropped.
 */
export class SessionRecorder {
  private frames: RawFrame[] = [];
  private unsubscribe: Unsubscribe | null = null;
  private endedAt: number | null = null;

  notes = "";
  metadata: Record<string, unknown> = {};

  constructor(
    private readonly session: DeviceSession,
    private readonly maxFrames = 50_000,
  ) {}

  /**
   * Begin recording. Idempotent.
   *
   * By default this also picks up frames the session emitted before the
   * recorder existed — the connect-time read pass (firmware, serial, model)
   * happens inside `probe()` and would otherwise be missing from the capture.
   * Pass `{ includeHistory: false }` to record only from now on.
   */
  start(options: { includeHistory?: boolean } = {}): void {
    if (this.unsubscribe) return;

    if (options.includeHistory !== false && this.frames.length === 0) {
      this.frames.push(...this.session.frameHistory());
    }

    this.unsubscribe = this.session.events.on("frame", (frame) => {
      this.frames.push(frame);
      if (this.frames.length > this.maxFrames) {
        this.frames.splice(0, this.frames.length - this.maxFrames);
      }
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.endedAt = Date.now();
  }

  get isRecording(): boolean {
    return this.unsubscribe !== null;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  all(): readonly RawFrame[] {
    return this.frames;
  }

  /** Frames from one characteristic, for focused analysis. */
  forCharacteristic(characteristicUuid: string): RawFrame[] {
    const target = characteristicUuid.toLowerCase();
    return this.frames.filter((f) => f.characteristicUuid?.toLowerCase() === target);
  }

  /**
   * Attach a label to the most recent frame.
   *
   * The intended workflow: tap "mark" in the app at the instant you shift, so
   * the capture carries ground truth you can correlate against.
   */
  labelLatest(label: string): boolean {
    const latest = this.frames[this.frames.length - 1];
    if (!latest) return false;
    latest.label = label;
    return true;
  }

  clear(): void {
    this.frames = [];
  }

  toDocument(): SessionDocument {
    return {
      version: 1,
      deviceId: this.session.deviceId,
      deviceName: this.session.deviceName,
      startedAt: this.session.startedAt,
      endedAt: this.endedAt,
      notes: this.notes,
      metadata: this.metadata,
      frames: this.frames.map(serializeFrame),
    };
  }

  toJSON(pretty = false): string {
    return JSON.stringify(this.toDocument(), null, pretty ? 2 : undefined);
  }

  /** Newline-delimited JSON — friendlier for very large captures and for `grep`. */
  toJSONL(): string {
    return this.frames.map((f) => JSON.stringify(serializeFrame(f))).join("\n");
  }
}

/** Parse a serialised session back into frames. */
export function loadSession(json: string): { document: SessionDocument; frames: RawFrame[] } {
  const document = JSON.parse(json) as SessionDocument;

  if (document.version !== 1) {
    throw new Error(`Unsupported session version: ${String(document.version)}`);
  }

  return { document, frames: document.frames.map(deserializeFrame) };
}

/**
 * Replay frames with their original relative timing.
 *
 * `speed` scales playback: 2 runs twice as fast, `Infinity` replays instantly.
 * Returns a cancel function.
 */
export function replaySession(
  frames: readonly RawFrame[],
  onFrame: (frame: RawFrame) => void,
  options: { speed?: number } = {},
): () => void {
  const { speed = 1 } = options;
  let cancelled = false;

  if (!Number.isFinite(speed)) {
    for (const frame of frames) onFrame(frame);
    return () => {};
  }

  const timers: TimerHandle[] = [];
  const base = frames[0]?.elapsedMs ?? 0;

  for (const frame of frames) {
    const delay = (frame.elapsedMs - base) / speed;
    timers.push(
      setTimeoutCompat(() => {
        if (!cancelled) onFrame(frame);
      }, delay),
    );
  }

  return () => {
    cancelled = true;
    for (const timer of timers) clearTimeoutCompat(timer);
  };
}

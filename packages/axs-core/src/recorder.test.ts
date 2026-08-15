/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

import { describe, expect, it, vi } from "vitest";

import { bytesEqual, fromHex } from "./bytes.js";
import type { RawFrame } from "./frame.js";
import { deserializeFrame, loadSession, replaySession, serializeFrame } from "./recorder.js";

function frame(seq: number, data: Uint8Array, elapsedMs = seq * 100): RawFrame {
  return {
    seq,
    timestamp: 1_700_000_000_000 + elapsedMs,
    elapsedMs,
    deviceId: "device-1",
    source: "notification",
    serviceUuid: "180f",
    characteristicUuid: "2a19",
    data,
  };
}

describe("frame serialisation", () => {
  it("round-trips a frame exactly", () => {
    const original = frame(3, fromHex("01 02 ff 80"));
    const restored = deserializeFrame(serializeFrame(original));

    expect(restored.seq).toBe(original.seq);
    expect(restored.timestamp).toBe(original.timestamp);
    expect(restored.source).toBe(original.source);
    expect(restored.characteristicUuid).toBe(original.characteristicUuid);
    expect(bytesEqual(restored.data, original.data)).toBe(true);
  });

  it("preserves an operator label", () => {
    const original = { ...frame(0, fromHex("aa")), label: "shifted to cog 5" };
    expect(deserializeFrame(serializeFrame(original)).label).toBe("shifted to cog 5");
  });

  it("omits the label key entirely when there is none", () => {
    expect("label" in serializeFrame(frame(0, fromHex("aa")))).toBe(false);
  });

  it("round-trips binary payloads that are not valid text", () => {
    const original = frame(0, Uint8Array.from([0x00, 0xff, 0x80, 0x7f, 0x01]));
    expect(bytesEqual(deserializeFrame(serializeFrame(original)).data, original.data)).toBe(true);
  });

  it("round-trips an empty payload", () => {
    expect(deserializeFrame(serializeFrame(frame(0, new Uint8Array(0)))).data.length).toBe(0);
  });
});

describe("loadSession", () => {
  it("rejects an unsupported document version", () => {
    const doc = JSON.stringify({ version: 99, frames: [] });
    expect(() => loadSession(doc)).toThrow(/Unsupported session version/);
  });

  it("parses a well-formed document", () => {
    const doc = JSON.stringify({
      version: 1,
      deviceId: "device-1",
      deviceName: "SIM RD",
      startedAt: 0,
      endedAt: null,
      notes: "bench",
      metadata: {},
      frames: [serializeFrame(frame(0, fromHex("01 02")))],
    });

    const { document, frames } = loadSession(doc);
    expect(document.notes).toBe("bench");
    expect(frames).toHaveLength(1);
    expect(bytesEqual(frames[0]!.data, fromHex("01 02"))).toBe(true);
  });
});

describe("replaySession", () => {
  it("replays instantly at infinite speed", () => {
    const frames = [frame(0, fromHex("01")), frame(1, fromHex("02")), frame(2, fromHex("03"))];
    const received: number[] = [];

    replaySession(frames, (f) => received.push(f.seq), { speed: Infinity });
    expect(received).toEqual([0, 1, 2]);
  });

  it("honours original relative timing", () => {
    vi.useFakeTimers();
    try {
      const frames = [frame(0, fromHex("01"), 0), frame(1, fromHex("02"), 500)];
      const received: number[] = [];

      replaySession(frames, (f) => received.push(f.seq));

      vi.advanceTimersByTime(100);
      expect(received).toEqual([0]);

      vi.advanceTimersByTime(500);
      expect(received).toEqual([0, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("scales playback speed", () => {
    vi.useFakeTimers();
    try {
      const frames = [frame(0, fromHex("01"), 0), frame(1, fromHex("02"), 1000)];
      const received: number[] = [];

      replaySession(frames, (f) => received.push(f.seq), { speed: 10 });
      vi.advanceTimersByTime(150);

      expect(received).toEqual([0, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops delivering frames once cancelled", () => {
    vi.useFakeTimers();
    try {
      const frames = [frame(0, fromHex("01"), 0), frame(1, fromHex("02"), 1000)];
      const received: number[] = [];

      const cancel = replaySession(frames, (f) => received.push(f.seq));
      cancel();
      vi.advanceTimersByTime(5000);

      expect(received).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles an empty frame list", () => {
    expect(() => replaySession([], () => {}, { speed: Infinity })).not.toThrow();
  });
});

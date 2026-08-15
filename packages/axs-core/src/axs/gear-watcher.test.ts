/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

import { describe, expect, it, vi } from "vitest";

import {
  FakeTransport,
  SIMULATOR_DEVICE_KEY,
  simulatedDerailleur,
} from "../testing/fake-transport.js";
import { GearWatcher, watchLiveState, type GearWatcherStatus } from "./gear-watcher.js";

/** Let queued promise callbacks run without advancing the fake clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

function watcher(transport: FakeTransport, overrides = {}) {
  return new GearWatcher(transport, "sim-rd-0001", {
    deviceKey: SIMULATOR_DEVICE_KEY,
    pollIntervalMs: 100,
    reconnectPolicy: { initialDelayMs: 50, maxDelayMs: 200, jitter: false },
    ...overrides,
  });
}

describe("GearWatcher", () => {
  it("connects and streams decoded gear readings", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport([simulatedDerailleur()]);
      const w = watcher(transport);
      const gears: number[] = [];
      w.events.on("gear", ({ gear }) => gears.push(gear));

      w.start();
      await vi.advanceTimersByTimeAsync(3000);

      expect(gears.length).toBeGreaterThan(0);
      expect(w.currentGear).toBe(gears[gears.length - 1]);
      await w.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects automatically after the component drops the link", async () => {
    // This is the behaviour that matters on a real bike: AXS parts drop idle
    // connections constantly, and the reader has to survive it unattended.
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport([simulatedDerailleur()]);
      const w = watcher(transport);
      const statuses: GearWatcherStatus[] = [];
      w.events.on("status", ({ status }) => statuses.push(status));

      w.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(statuses).toContain("connected");

      const before = statuses.filter((s) => s === "connected").length;
      transport.disconnectDevice("sim-rd-0001");
      await vi.advanceTimersByTimeAsync(2000);

      expect(statuses).toContain("reconnecting");
      const after = statuses.filter((s) => s === "connected").length;
      expect(after).toBeGreaterThan(before);

      await w.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps decoding gear after a reconnect", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport([simulatedDerailleur()]);
      const w = watcher(transport);
      w.start();
      await vi.advanceTimersByTimeAsync(1000);

      transport.disconnectDevice("sim-rd-0001");
      await vi.advanceTimersByTimeAsync(500);

      const readings: number[] = [];
      w.events.on("reading", (r) => {
        if (r.gearRear !== undefined) readings.push(r.gearRear);
      });
      await vi.advanceTimersByTimeAsync(2000);

      expect(readings.length).toBeGreaterThan(0);
      await w.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries with backoff when the component cannot be connected to", async () => {
    vi.useFakeTimers();
    try {
      // An empty transport stands in for a component that is asleep.
      const transport = new FakeTransport([]);
      const w = watcher(transport);
      const attempts: number[] = [];
      w.events.on("status", ({ status, attempt }) => {
        if (status === "reconnecting") attempts.push(attempt);
      });

      w.start();
      await vi.advanceTimersByTimeAsync(2000);

      // Attempts must keep climbing rather than stopping at the first failure.
      expect(attempts.length).toBeGreaterThan(1);
      expect(Math.max(...attempts)).toBeGreaterThan(1);

      await w.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after maxAttempts and reports stopped", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport([]);
      const w = watcher(transport, { reconnectPolicy: { initialDelayMs: 10, jitter: false, maxAttempts: 3 } });
      const final: string[] = [];
      w.events.on("status", ({ status }) => final.push(status));

      w.start();
      await vi.advanceTimersByTimeAsync(2000);

      expect(final).toContain("stopped");
      await w.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns instead of throwing when a frame will not decrypt", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport([simulatedDerailleur()]);
      const w = watcher(transport, { deviceKey: new Uint8Array(16).fill(0xaa) });
      const warnings: string[] = [];
      w.events.on("warning", ({ message }) => warnings.push(message));
      const gears: number[] = [];
      w.events.on("gear", ({ gear }) => gears.push(gear));

      w.start();
      await vi.advanceTimersByTimeAsync(1000);

      expect(warnings.some((m) => m.includes("did not decrypt"))).toBe(true);
      expect(gears).toHaveLength(0);
      await w.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops cleanly and emits no further readings", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport([simulatedDerailleur()]);
      const w = watcher(transport);
      w.start();
      await vi.advanceTimersByTimeAsync(1000);
      await w.stop();

      let after = 0;
      w.events.on("reading", () => after++);
      await vi.advanceTimersByTimeAsync(2000);
      await flush();

      expect(after).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * `watchLiveState` exists because two hardware facts rule out the obvious
 * approaches inside a session: a second connection closes the first, and the
 * live-state characteristic notifies a bare `0xff` doorbell rather than the
 * frame. It therefore has to read, over a link it does not own.
 */
describe("watchLiveState", () => {
  it("polls an existing link and decodes gear, without closing it", async () => {
    const transport = new FakeTransport();
    const peripheral = await transport.connect("sim-rd-0001");
    const disconnect = vi.spyOn(peripheral, "disconnect");

    const seen: number[] = [];
    const stop = watchLiveState(peripheral, {
      deviceKey: SIMULATOR_DEVICE_KEY,
      pollIntervalMs: 10,
      onState: (state) => {
        if (typeof state.gearRear === "number") seen.push(state.gearRear);
      },
    });

    // The first read is issued immediately, before any interval elapses.
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    stop();

    expect(seen.every((gear) => gear >= 1 && gear <= 12)).toBe(true);
    // The link belongs to its owner; stopping must not tear it down.
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("reports decode failures instead of throwing, and keeps polling", async () => {
    const transport = new FakeTransport();
    const peripheral = await transport.connect("sim-rd-0001");

    const errors: string[] = [];
    const wrongKey = new Uint8Array(16).fill(0xab);

    const stop = watchLiveState(peripheral, {
      deviceKey: wrongKey,
      pollIntervalMs: 5,
      onState: () => {
        throw new Error("must not decode under the wrong key");
      },
      onError: (error) => errors.push(error.message),
    });

    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(1));
    stop();
  });
});

/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * The generic watcher, read as something other than a drivetrain.
 *
 * `gear-watcher.test.ts` already covers the connect/poll/reconnect machinery
 * through `GearWatcher`, and those tests pass unchanged, which is what proves
 * extracting this class preserved behaviour. What is left to show is the point
 * of the extraction: that the same machinery reads a component whose live state
 * is not a gear, without any change to the watcher.
 */

import { describe, expect, it, vi } from "vitest";

import { parseProtobuf } from "../decode/protobuf.js";
import {
  FakeTransport,
  SIMULATOR_DEVICE_KEY,
  simulatedDerailleur,
} from "../testing/fake-transport.js";
import { decodeDrivetrainConfig } from "./drivetrain.js";
import { LiveStateWatcher, watchLiveState } from "./live-state-watcher.js";

/** The simulator's encrypted `drivetrain_config` channel. */
const CONFIG_CHARACTERISTIC = "d9050025-90aa-4c7c-b036-1e01fb8eb7ee";

describe("LiveStateWatcher", () => {
  it("reads a live-state channel with a caller-supplied decoder", async () => {
    vi.useFakeTimers();
    try {
      // A decoder that knows nothing about drivetrains: it reports the shape of
      // the plaintext, which is exactly what a new component's first decoder
      // looks like before its fields are understood.
      const transport = new FakeTransport([simulatedDerailleur()]);
      const watcher = new LiveStateWatcher<{ fieldNumbers: number[] }>(
        transport,
        "sim-rd-0001",
        {
          deviceKey: SIMULATOR_DEVICE_KEY,
          pollIntervalMs: 100,
          reconnectPolicy: { initialDelayMs: 50, maxDelayMs: 200, jitter: false },
          decode: (plaintext) => ({
            fieldNumbers: parseProtobuf(plaintext).fields.map((f) => f.fieldNumber),
          }),
        },
      );

      const readings: number[][] = [];
      watcher.events.on("reading", (reading) => readings.push(reading.fieldNumbers));

      watcher.start();
      await vi.advanceTimersByTimeAsync(1000);
      await watcher.stop();

      expect(readings.length).toBeGreaterThan(0);
      // drivetrain_status: fd_position, rd_position, rd_trim.
      expect(readings[0]).toEqual([20, 21, 22]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a different characteristic when told to", async () => {
    vi.useFakeTimers();
    try {
      // Same component, same key, a different encrypted channel carrying a
      // different message — the case a second component family reduces to.
      const transport = new FakeTransport([simulatedDerailleur()]);
      const watcher = new LiveStateWatcher(transport, "sim-rd-0001", {
        deviceKey: SIMULATOR_DEVICE_KEY,
        characteristic: CONFIG_CHARACTERISTIC,
        pollIntervalMs: 100,
        reconnectPolicy: { initialDelayMs: 50, maxDelayMs: 200, jitter: false },
        decode: decodeDrivetrainConfig,
      });

      const seen: Array<number | undefined> = [];
      watcher.events.on("reading", (reading) => seen.push(reading.totalRear));

      watcher.start();
      await vi.advanceTimersByTimeAsync(1000);
      await watcher.stop();

      expect(seen[0]).toBe(12);
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns instead of throwing when a frame will not decrypt", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport([simulatedDerailleur()]);
      const watcher = new LiveStateWatcher(transport, "sim-rd-0001", {
        deviceKey: new Uint8Array(16).fill(0x11), // not the simulator's key
        pollIntervalMs: 100,
        reconnectPolicy: { initialDelayMs: 50, maxDelayMs: 200, jitter: false },
        decode: decodeDrivetrainConfig,
      });

      const warnings: string[] = [];
      const readings: unknown[] = [];
      watcher.events.on("warning", ({ message }) => warnings.push(message));
      watcher.events.on("reading", (reading) => readings.push(reading));

      watcher.start();
      await vi.advanceTimersByTimeAsync(500);
      await watcher.stop();

      // A wrong key must degrade to "no readings", never to a crash: on a bike
      // this happens whenever the component has been re-bonded elsewhere.
      expect(readings).toHaveLength(0);
      expect(warnings[0]).toMatch(/did not decrypt/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("watchLiveState with a supplied decoder", () => {
  it("decodes a borrowed link with something other than the drivetrain message", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport([simulatedDerailleur()]);
      const peripheral = await transport.connect("sim-rd-0001");

      const lengths: number[] = [];
      const stop = watchLiveState<{ length: number }>(peripheral, {
        deviceKey: SIMULATOR_DEVICE_KEY,
        pollIntervalMs: 100,
        decode: (plaintext) => ({ length: plaintext.length }),
        onState: (state) => lengths.push(state.length),
      });

      await vi.advanceTimersByTimeAsync(500);
      stop();

      expect(lengths.length).toBeGreaterThan(0);
      expect(lengths[0]).toBeGreaterThan(0);
      await peripheral.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });
});

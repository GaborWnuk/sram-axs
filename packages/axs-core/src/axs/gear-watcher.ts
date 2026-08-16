/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * A self-healing reader for live *drivetrain* state.
 *
 * This is {@link LiveStateWatcher} with the decoder fixed to the drivetrain
 * message, plus the one thing a drivetrain has that other components do not: a
 * gear that changes, and a UI that wants to know when it does.
 *
 * ```ts
 * const watcher = new GearWatcher(transport, deviceId, { deviceKey });
 * watcher.events.on("gear", ({ gear }) => render(gear));
 * watcher.events.on("status", ({ status }) => showConnectionDot(status));
 * watcher.start();
 * // …later
 * await watcher.stop();
 * ```
 *
 * Everything hard — one central at a time, idle drops, the content-free
 * doorbell, backoff — lives in `LiveStateWatcher` and is shared with every
 * other component family. Reach for that one directly when reading something
 * that is not a drivetrain.
 *
 * Reading is strictly read-only: the watcher never writes to the component.
 */

import { Emitter } from "../emitter.js";
import type { BleTransport } from "../transport.js";
import { decodeDrivetrainStatus, type DrivetrainStatus } from "./drivetrain.js";
import {
  LiveStateWatcher,
  type LiveStateStatus,
  type LiveStateWatcherOptions,
} from "./live-state-watcher.js";

/**
 * Connection state of the watcher.
 *
 * An alias rather than its own union: connection lifecycle is a property of the
 * link, not of the drivetrain, so the two must not be able to drift apart.
 */
export type GearWatcherStatus = LiveStateStatus;

/** One decoded reading of the drivetrain. */
export interface GearReading extends DrivetrainStatus {
  /** Milliseconds since epoch. */
  timestamp: number;
}

interface GearWatcherEvents extends Record<string, unknown> {
  /** A decoded reading. Emitted for every successful decrypt, not only changes. */
  reading: GearReading;
  /** Emitted only when the rear gear changes — the useful signal for a UI. */
  gear: { gear: number; previous: number | null; reading: GearReading };
  /** Connection lifecycle. `attempt` counts consecutive failures while reconnecting. */
  status: { status: GearWatcherStatus; attempt: number; error?: Error };
  /** A non-fatal problem: one failed read or one frame that would not decrypt. */
  warning: { message: string; error?: Error };
}

/** Everything {@link LiveStateWatcher} takes, except what the plaintext means. */
export type GearWatcherOptions = Omit<LiveStateWatcherOptions<DrivetrainStatus>, "decode">;

export class GearWatcher {
  readonly events = new Emitter<GearWatcherEvents>();

  private readonly watcher: LiveStateWatcher<DrivetrainStatus>;
  private lastGear: number | null = null;

  constructor(transport: BleTransport, deviceId: string, options: GearWatcherOptions) {
    this.watcher = new LiveStateWatcher<DrivetrainStatus>(transport, deviceId, {
      ...options,
      decode: decodeDrivetrainStatus,
    });

    // Forwarded rather than inherited: the generic watcher has no notion of a
    // gear event, and composing keeps its event map free of drivetrain terms.
    this.watcher.events.on("reading", (reading) => {
      this.events.emit("reading", reading);

      if (reading.gearRear !== undefined && reading.gearRear !== this.lastGear) {
        const previous = this.lastGear;
        this.lastGear = reading.gearRear;
        this.events.emit("gear", { gear: reading.gearRear, previous, reading });
      }
    });
    this.watcher.events.on("status", (event) => this.events.emit("status", event));
    this.watcher.events.on("warning", (event) => this.events.emit("warning", event));
  }

  /** Last decoded rear gear, or null if nothing has decoded yet. */
  get currentGear(): number | null {
    return this.lastGear;
  }

  /** Begin connecting and reading. Safe to call once; further calls are ignored. */
  start(): void {
    this.watcher.start();
  }

  /** Stop reading and disconnect. Safe to call more than once. */
  async stop(): Promise<void> {
    await this.watcher.stop();
  }
}

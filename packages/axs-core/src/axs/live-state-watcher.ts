/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * A self-healing reader for any AXS component's encrypted live state.
 *
 * Everything here was learned on hardware, and none of it is about gears:
 *
 *   - **Components serve one central at a time.** Asking for a second
 *     connection to an already-connected peripheral makes Android close the
 *     first, so a watcher must own its link or borrow one — never both.
 *   - **Idle links get dropped**, within roughly 10-100 seconds, and the
 *     component refuses connections entirely once asleep. Reconnecting with
 *     backoff is the normal case, not the error case.
 *   - **The live-state characteristic notifies a content-free doorbell.** The
 *     payload is a single `0xff` byte announcing that state changed; only a
 *     *read* returns the frame. Subscribing alone yields a steady stream of
 *     unusable one-byte frames and a value that never appears.
 *   - **A slow read must not queue behind itself**, and a read that never
 *     settles must not wedge the loop forever.
 *
 * That is a lot of hard-won behaviour, and it applies unchanged to a dropper
 * post, a suspension unit or anything else SRAM puts on the encrypted channel.
 * So it lives here once, parameterised by what the decrypted plaintext *means*,
 * rather than being copied per component and re-learned wrongly.
 *
 * {@link GearWatcher} is this class with `decode` fixed to the drivetrain
 * message and a gear-change event on top.
 *
 * Reading is strictly read-only: the watcher never writes to the component. It
 * needs a device key, which comes from `createBond` or a previous bond.
 */

import { Emitter } from "../emitter.js";
import {
  DEFAULT_RECONNECT_POLICY,
  nextBackoffDelay,
  type ReconnectPolicy,
} from "../reconnect.js";
import {
  clearIntervalCompat,
  clearTimeoutCompat,
  setIntervalCompat,
  setTimeoutCompat,
  type TimerHandle,
} from "../timers.js";
import type { BleTransport, ConnectedPeripheral } from "../transport.js";
import { uuidEquals } from "../gatt/uuids.js";
import { decodeDrivetrainStatus, type DrivetrainStatus } from "./drivetrain.js";
import { decryptLiveStateFrame, LIVE_STATE_CHARACTERISTIC } from "./srambond.js";

/** Connection state of a watcher. */
export type LiveStateStatus = "connecting" | "connected" | "reconnecting" | "stopped";

/** A decoded reading, with the time it was taken. */
export type LiveReading<T> = T & { timestamp: number };

export interface LiveStateWatcherEvents<T> extends Record<string, unknown> {
  /** A decoded reading. Emitted for every successful decode, not only changes. */
  reading: LiveReading<T>;
  /** Connection lifecycle. `attempt` counts consecutive failures while reconnecting. */
  status: { status: LiveStateStatus; attempt: number; error?: Error };
  /** A non-fatal problem: one failed read, or one frame that would not decrypt. */
  warning: { message: string; error?: Error };
}

export interface LiveStateWatcherOptions<T> {
  /** The component's live-state key, from `createBond`. */
  deviceKey: Uint8Array;
  /**
   * What the decrypted plaintext means for this component.
   *
   * Decryption is shared; interpretation is not. Pass the decoder for the
   * message this component serves — see `messages.ts`.
   */
  decode: (plaintext: Uint8Array) => T;
  /** Characteristic to read. Defaults to the drivetrain live-state channel. */
  characteristic?: string;
  /** How often to re-read, in ms. Default 250 (≈4 Hz). */
  pollIntervalMs?: number;
  /** How reconnection attempts are spaced. */
  reconnectPolicy?: Partial<ReconnectPolicy>;
  /** Connect timeout passed to the transport, in ms. Default 15000. */
  connectTimeoutMs?: number;
  /**
   * Consecutive failed reads tolerated before the link is treated as dead and
   * reconnected. Default 3 — a single failed read is usually a transient.
   */
  maxConsecutiveReadFailures?: number;
}

export class LiveStateWatcher<T> {
  readonly events = new Emitter<LiveStateWatcherEvents<T>>();

  private readonly policy: ReconnectPolicy;
  private readonly pollIntervalMs: number;
  private readonly connectTimeoutMs: number;
  private readonly maxReadFailures: number;
  private readonly characteristic: string;

  private peripheral: ConnectedPeripheral | null = null;
  private timer: TimerHandle = null;
  private running = false;
  private attempt = 0;
  private serviceUuid: string | null = null;
  /** True once a connection has succeeded, so later attempts are reconnections. */
  private hasConnected = false;

  constructor(
    private readonly transport: BleTransport,
    private readonly deviceId: string,
    private readonly options: LiveStateWatcherOptions<T>,
  ) {
    this.policy = { ...DEFAULT_RECONNECT_POLICY, ...options.reconnectPolicy };
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.maxReadFailures = options.maxConsecutiveReadFailures ?? 3;
    this.characteristic = options.characteristic ?? LIVE_STATE_CHARACTERISTIC;
  }

  /** Begin connecting and reading. Safe to call once; further calls are ignored. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    void this.connectLoop();
  }

  /** Stop reading and disconnect. Safe to call more than once. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.clearTimer();

    const peripheral = this.peripheral;
    this.peripheral = null;
    if (peripheral) {
      try {
        await peripheral.disconnect();
      } catch {
        // Already gone; nothing useful to do.
      }
    }
    this.events.emit("status", { status: "stopped", attempt: 0 });
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeoutCompat(this.timer);
      this.timer = null;
    }
  }

  /** Connect, then poll until the link drops; on failure, back off and retry. */
  private async connectLoop(): Promise<void> {
    while (this.running) {
      this.events.emit("status", {
        // Only the very first attempt is a plain connect; everything after a
        // successful link — including a clean idle drop — is a reconnection.
        status: this.hasConnected || this.attempt > 0 ? "reconnecting" : "connecting",
        attempt: this.attempt,
      });

      try {
        await this.connectAndRead();
        // connectAndRead only returns when the link ended. If the watcher is
        // still running that was an unexpected drop, so retry from scratch.
        if (!this.running) return;
        this.attempt = 0;
      } catch (error) {
        if (!this.running) return;
        const err = error instanceof Error ? error : new Error(String(error));
        this.attempt++;
        this.events.emit("status", {
          status: "reconnecting",
          attempt: this.attempt,
          error: err,
        });

        if (this.attempt >= this.policy.maxAttempts) {
          this.running = false;
          this.events.emit("status", { status: "stopped", attempt: this.attempt, error: err });
          return;
        }
      }

      if (!this.running) return;
      // A drop with no error still counts as an attempt for pacing purposes.
      const delay = nextBackoffDelay(Math.max(1, this.attempt), this.policy);
      await this.sleep(delay);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timer = setTimeoutCompat(() => {
        this.timer = null;
        resolve();
      }, ms);
    });
  }

  /** One connection: discover, then poll until it drops or the watcher stops. */
  private async connectAndRead(): Promise<void> {
    const peripheral = await this.transport.connect(this.deviceId, {
      timeoutMs: this.connectTimeoutMs,
    });
    this.peripheral = peripheral;

    let dropped = false;
    const offDisconnect = peripheral.onDisconnected(() => {
      dropped = true;
    });

    try {
      const services = await peripheral.discoverServices();
      const service = services.find((s) =>
        s.characteristics.some((ch) => uuidEquals(ch.uuid, this.characteristic)),
      );
      if (!service) {
        throw new Error(
          `${this.deviceId} does not expose the live-state characteristic ` +
            `(${this.characteristic}); is this an AXS primary component?`,
        );
      }
      this.serviceUuid = service.uuid;

      this.attempt = 0;
      this.hasConnected = true;
      this.events.emit("status", { status: "connected", attempt: 0 });

      let readFailures = 0;
      while (this.running && !dropped) {
        try {
          const frame = await peripheral.read(this.serviceUuid, this.characteristic);
          readFailures = 0;
          this.handleFrame(frame);
        } catch (error) {
          readFailures++;
          const err = error instanceof Error ? error : new Error(String(error));
          this.events.emit("warning", {
            message: `read failed (${readFailures}/${this.maxReadFailures})`,
            error: err,
          });
          if (readFailures >= this.maxReadFailures) throw err;
        }
        if (!this.running || dropped) break;
        await this.sleep(this.pollIntervalMs);
      }
    } finally {
      offDisconnect();
      this.peripheral = null;
      try {
        await peripheral.disconnect();
      } catch {
        // Expected when the component dropped the link itself.
      }
    }
  }

  /** Decrypt and decode one frame. Bad frames warn rather than throw. */
  private handleFrame(frame: Uint8Array): void {
    let value: T;
    try {
      value = this.options.decode(decryptLiveStateFrame(this.options.deviceKey, frame));
    } catch (error) {
      this.events.emit("warning", {
        message: "frame did not decrypt — wrong key, or the component re-bonded",
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    this.events.emit("reading", { ...value, timestamp: Date.now() });
  }
}

export interface WatchLiveStateOptions<T = DrivetrainStatus> {
  /** The component's SRAMBond key, from `createBond` or a stored bond. */
  deviceKey: Uint8Array;
  /** What the decrypted plaintext means. Defaults to the drivetrain message. */
  decode?: (plaintext: Uint8Array) => T;
  /** Characteristic to read. Defaults to the drivetrain live-state channel. */
  characteristic?: string;
  /** How often to read, in ms (default 250). */
  pollIntervalMs?: number;
  /** Called for every successful decode, not only on change. */
  onState: (state: T) => void;
  /** Called when a read or decode fails. Polling continues regardless. */
  onError?: (error: Error) => void;
}

/**
 * Poll a component's live state over a connection that someone else owns.
 *
 * Use this inside an existing session; use {@link LiveStateWatcher} (or
 * `GearWatcher`) when nothing else holds the link. The distinction matters: an
 * AXS component serves one central at a time, so asking for a second
 * connection to a peripheral that is already connected makes Android close the
 * first — a watcher started inside a live session would tear that session down.
 * This touches only the link it is handed, and never closes it.
 *
 * ## Why polling, when the characteristic notifies
 *
 * `d905000b` does notify, but the notification payload is a single `0xff` byte
 * — a doorbell announcing that state changed, not the state itself. The frame
 * only materialises on a read. Subscribing alone therefore produces a steady
 * stream of unusable one-byte frames and a value that never appears, which is
 * exactly what bench testing against an RD-GX-E-B1 showed.
 */
export function watchLiveState(
  peripheral: ConnectedPeripheral,
  options: WatchLiveStateOptions<DrivetrainStatus>,
): () => void;
export function watchLiveState<T>(
  peripheral: ConnectedPeripheral,
  options: WatchLiveStateOptions<T> & { decode: (plaintext: Uint8Array) => T },
): () => void;
export function watchLiveState<T>(
  peripheral: ConnectedPeripheral,
  options: WatchLiveStateOptions<T>,
): () => void {
  const intervalMs = options.pollIntervalMs ?? 250;
  const characteristic = options.characteristic ?? LIVE_STATE_CHARACTERISTIC;
  // Sound because the only overload that omits `decode` fixes T to
  // DrivetrainStatus; the generic overload requires the caller to supply one.
  const decode = options.decode ?? (decodeDrivetrainStatus as (plaintext: Uint8Array) => T);

  let stopped = false;
  let inFlight = false;
  let serviceUuid: string | null = null;

  const fail = (error: unknown): void => {
    if (!stopped) options.onError?.(error instanceof Error ? error : new Error(String(error)));
  };

  const tick = async (): Promise<void> => {
    // A slow read must not queue up behind itself.
    if (stopped || inFlight) return;
    inFlight = true;

    try {
      if (serviceUuid === null) {
        const services = await peripheral.discoverServices();
        const owner = services.find((service) =>
          service.characteristics.some((ch) => uuidEquals(ch.uuid, characteristic)),
        );
        if (!owner) {
          throw new Error(
            `No service exposes the live-state characteristic ` +
              `(${characteristic}); is this an AXS primary component?`,
          );
        }
        serviceUuid = owner.uuid;
      }

      const frame = await peripheral.read(serviceUuid, characteristic);
      if (!stopped) options.onState(decode(decryptLiveStateFrame(options.deviceKey, frame)));
    } catch (error) {
      fail(error);
    } finally {
      inFlight = false;
    }
  };

  void tick();
  const timer = setIntervalCompat(() => void tick(), intervalMs);

  return () => {
    stopped = true;
    clearIntervalCompat(timer);
  };
}

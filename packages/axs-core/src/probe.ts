/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * The probe — connect to a component and pull everything observable out of it.
 *
 * Read-only by design. The probe never writes to a characteristic. Nordic's
 * buttonless DFU control point sits in the GATT tree of most nRF-based products
 * and writing to it reboots the device into its bootloader, so "enumerate and
 * poke" is not a safe default on hardware bolted to a bicycle.
 */

import { Emitter } from "./emitter.js";
import type { RawFrame, FrameSource } from "./frame.js";
import { identifyDevice, type Identification } from "./identify.js";
import { describeUuid } from "./gatt/uuids.js";
import { ByteChangeTracker } from "./decode/heuristics.js";
import { DecoderRegistry } from "./decode/registry.js";
import {
  clearIntervalCompat,
  clearTimeoutCompat,
  setIntervalCompat,
  setTimeoutCompat,
} from "./timers.js";
import type {
  BleTransport,
  ConnectedPeripheral,
  GattService,
  ScanResult,
  Unsubscribe,
} from "./transport.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: number;
}

export interface DiscoveredDevice {
  result: ScanResult;
  identification: Identification;
  /** How many advertisements have been seen from this device. */
  sightings: number;
}

export interface ProbeOptions {
  /** Read every readable characteristic once on connect. Default true. */
  readAll?: boolean;
  /** Subscribe to every notify/indicate characteristic. Default true. */
  subscribeAll?: boolean;
  connectTimeoutMs?: number;
}

interface SessionEvents extends Record<string, unknown> {
  frame: RawFrame;
  log: LogEntry;
  disconnected: { error: Error | null };
}

/**
 * A live connection to one component.
 *
 * Owns the frame sequence numbering, the per-characteristic change trackers and
 * the active subscriptions.
 */
export class DeviceSession {
  readonly startedAt = Date.now();
  readonly events = new Emitter<SessionEvents>();

  private seq = 0;
  private services: GattService[] = [];
  private subscriptions: Unsubscribe[] = [];
  private trackers = new Map<string, ByteChangeTracker>();
  private closed = false;

  /**
   * Every frame emitted so far.
   *
   * `AxsProbe.probe()` performs its read pass before the caller has any chance
   * to attach a listener, so without a retained history the Device Information
   * reads — firmware, serial, model — would be emitted into the void. Consumers
   * seed themselves from this, and `SessionRecorder` does so automatically.
   */
  private history: RawFrame[] = [];

  constructor(
    private readonly peripheral: ConnectedPeripheral,
    private readonly registry: DecoderRegistry,
    private readonly maxHistory = 100_000,
  ) {
    this.peripheral.onDisconnected((error) => {
      this.closed = true;
      this.events.emit("disconnected", { error });
    });
  }

  get deviceId(): string {
    return this.peripheral.id;
  }

  get deviceName(): string | null {
    return this.peripheral.name;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get gatt(): readonly GattService[] {
    return this.services;
  }

  get mtu(): number | null {
    return this.peripheral.mtu();
  }

  private log(level: LogLevel, message: string): void {
    this.events.emit("log", { level, message, timestamp: Date.now() });
  }

  private pushFrame(
    source: FrameSource,
    serviceUuid: string | null,
    characteristicUuid: string | null,
    data: Uint8Array,
  ): RawFrame {
    const now = Date.now();
    const frame: RawFrame = {
      seq: this.seq++,
      timestamp: now,
      elapsedMs: now - this.startedAt,
      deviceId: this.peripheral.id,
      source,
      serviceUuid,
      characteristicUuid,
      data,
    };

    if (characteristicUuid) {
      const key = characteristicUuid.toLowerCase();
      let tracker = this.trackers.get(key);
      if (!tracker) {
        tracker = new ByteChangeTracker();
        this.trackers.set(key, tracker);
      }
      tracker.add(data);
    }

    this.history.push(frame);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }

    this.events.emit("frame", frame);
    return frame;
  }

  /**
   * Frames emitted so far, including any produced before you subscribed.
   *
   * Seed a late-attached consumer with this, then subscribe to `frame` for the
   * rest. Otherwise you miss the whole connect-time read pass.
   */
  frameHistory(): readonly RawFrame[] {
    return this.history;
  }

  /** Discover the GATT tree and log a categorised summary of it. */
  async discover(): Promise<GattService[]> {
    this.log("info", "Discovering services…");
    this.services = await this.peripheral.discoverServices();

    let vendorCount = 0;
    for (const service of this.services) {
      const info = describeUuid(service.uuid);
      const label = info.name ?? "unknown service";
      this.log(
        "info",
        `Service ${info.short ?? info.uuid} — ${label} (${service.characteristics.length} characteristics)`,
      );

      for (const characteristic of service.characteristics) {
        const charInfo = describeUuid(characteristic.uuid);
        if (charInfo.category === "vendor") vendorCount++;

        const props = Object.entries(characteristic.properties)
          .filter(([, enabled]) => enabled)
          .map(([name]) => name)
          .join(",");
        this.log(
          "debug",
          `  ${charInfo.short ?? charInfo.uuid} — ${charInfo.name ?? "unknown"} [${props || "none"}]`,
        );
      }
    }

    this.log(
      "info",
      `Discovered ${this.services.length} services; ${vendorCount} vendor-defined characteristics to investigate.`,
    );
    return this.services;
  }

  /** Read every readable characteristic once. Failures are logged, not thrown. */
  async readAll(): Promise<void> {
    for (const service of this.services) {
      for (const characteristic of service.characteristics) {
        if (!characteristic.properties.read) continue;

        try {
          const value = await this.peripheral.read(service.uuid, characteristic.uuid);
          const frame = this.pushFrame("read", service.uuid, characteristic.uuid, value);
          const best = this.registry.best(frame);
          if (best) this.log("info", `READ ${describeUuid(characteristic.uuid).short ?? characteristic.uuid}: ${best.summary}`);
        } catch (error) {
          // Encrypted or authenticated characteristics reject reads until the
          // device is bonded. That is itself a finding worth recording.
          this.log(
            "warn",
            `READ ${characteristic.uuid} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }

  /** Subscribe to every notify/indicate characteristic. */
  async subscribeAll(): Promise<void> {
    for (const service of this.services) {
      for (const characteristic of service.characteristics) {
        const { notify, indicate } = characteristic.properties;
        if (!notify && !indicate) continue;

        const source: FrameSource = indicate ? "indication" : "notification";

        try {
          const unsubscribe = await this.peripheral.subscribe(
            service.uuid,
            characteristic.uuid,
            (value) => {
              this.pushFrame(source, service.uuid, characteristic.uuid, value);
            },
            (error) => {
              this.log("warn", `Subscription ${characteristic.uuid} errored: ${error.message}`);
            },
          );

          this.subscriptions.push(unsubscribe);
          this.log("info", `Subscribed to ${describeUuid(characteristic.uuid).short ?? characteristic.uuid}`);
        } catch (error) {
          this.log(
            "warn",
            `Subscribe ${characteristic.uuid} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }

  /**
   * Periodically re-read every readable characteristic.
   *
   * Why this exists: bench capture showed that an AXS derailleur's
   * notifications carry **no payload** — they are single `0xff` bytes, a
   * "something changed, come and look" flag rather than the state itself. The
   * state lives in the readable characteristics, which a subscribe-only probe
   * reads exactly once at connect and then never again.
   *
   * Polling turns those static reads into a time series, which is what the byte
   * tracker needs in order to correlate a field against a physical action.
   *
   * Still strictly read-only. Returns a function that stops polling.
   */
  startPolling(
    intervalMs = 3000,
    filter?: (characteristicUuid: string) => boolean,
    readTimeoutMs = 2000,
  ): Unsubscribe {
    const targets: Array<{ service: string; characteristic: string }> = [];

    for (const service of this.services) {
      for (const characteristic of service.characteristics) {
        if (!characteristic.properties.read) continue;
        if (filter && !filter(characteristic.uuid)) continue;
        targets.push({ service: service.uuid, characteristic: characteristic.uuid });
      }
    }

    this.log("info", `Polling ${targets.length} readable characteristics every ${intervalMs}ms`);

    let stopped = false;
    let inFlight = false;
    let consecutiveFailures = 0;
    let rounds = 0;

    /**
     * A GATT read that never settles would wedge the loop forever behind the
     * `inFlight` guard. That is not hypothetical — it silently killed a 150 s
     * bench capture 23 s in, while the connection stayed up and the log stayed
     * clean. Every read now settles, one way or another.
     */
    const readWithTimeout = (service: string, characteristic: string): Promise<Uint8Array> =>
      new Promise<Uint8Array>((resolve, reject) => {
        let settled = false;

        const timer = setTimeoutCompat(() => {
          if (settled) return;
          settled = true;
          reject(new Error(`read timed out after ${readTimeoutMs}ms`));
        }, readTimeoutMs);

        this.peripheral.read(service, characteristic).then(
          (value) => {
            if (settled) return;
            settled = true;
            clearTimeoutCompat(timer);
            resolve(value);
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeoutCompat(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      });

    const tick = async () => {
      // Skip rather than queue: a slow round must not pile up requests and
      // swamp the connection, which is a good way to get dropped.
      if (stopped || inFlight) return;
      inFlight = true;
      rounds++;

      let failures = 0;
      try {
        for (const target of targets) {
          if (stopped || this.closed) break;
          try {
            const value = await readWithTimeout(target.service, target.characteristic);
            this.pushFrame("read", target.service, target.characteristic, value);
          } catch {
            failures++;
          }
        }
      } finally {
        inFlight = false;
      }

      // Report a stall rather than dying quietly — silence was what made the
      // original failure so hard to spot.
      if (failures === targets.length) {
        consecutiveFailures++;
        if (consecutiveFailures === 3) {
          this.log("warn", `Polling: ${consecutiveFailures} rounds with every read failing.`);
        }
      } else {
        consecutiveFailures = 0;
      }

      if (rounds % 25 === 0) {
        this.log("debug", `Polling healthy: ${rounds} rounds completed.`);
      }
    };

    const timer = setIntervalCompat(() => void tick(), intervalMs);
    void tick();

    const stop = () => {
      stopped = true;
      clearIntervalCompat(timer);
    };

    this.subscriptions.push(stop);
    return stop;
  }

  /** Byte-volatility report for one characteristic, or null if never seen. */
  tracker(characteristicUuid: string): ByteChangeTracker | null {
    return this.trackers.get(characteristicUuid.toLowerCase()) ?? null;
  }

  /** All characteristics that have frames. */
  trackedCharacteristics(): string[] {
    return [...this.trackers.keys()];
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions = [];

    if (!this.closed) {
      this.closed = true;
      await this.peripheral.disconnect().catch(() => {
        // Already gone; nothing useful to do.
      });
    }
  }
}

interface ProbeEvents extends Record<string, unknown> {
  device: DiscoveredDevice;
  log: LogEntry;
}

/**
 * Top-level entry point. Wraps a {@link BleTransport} with scanning,
 * identification and session management.
 */
export class AxsProbe {
  readonly events = new Emitter<ProbeEvents>();
  readonly registry: DecoderRegistry;

  private discovered = new Map<string, DiscoveredDevice>();
  private stopScan: Unsubscribe | null = null;

  constructor(
    private readonly transport: BleTransport,
    registry: DecoderRegistry = new DecoderRegistry(),
  ) {
    this.registry = registry;
  }

  private log(level: LogLevel, message: string): void {
    this.events.emit("log", { level, message, timestamp: Date.now() });
  }

  /**
   * Start scanning.
   *
   * Scans unfiltered rather than filtering on SRAM's company ID, because an AXS
   * component that is asleep or advertising something unexpected would be
   * invisible under a filter — and "the device is not showing up" is exactly
   * the situation this tool exists to debug.
   */
  async startScan(): Promise<Unsubscribe> {
    await this.transport.ready();
    this.log("info", "Scanning…");

    this.stopScan = await this.transport.startScan((result) => {
      const existing = this.discovered.get(result.id);
      const device: DiscoveredDevice = {
        result,
        identification: identifyDevice(result),
        sightings: (existing?.sightings ?? 0) + 1,
      };

      this.discovered.set(result.id, device);
      this.events.emit("device", device);
    });

    return this.stopScan;
  }

  stopScanning(): void {
    this.stopScan?.();
    this.stopScan = null;
    this.log("info", "Scan stopped.");
  }

  /** Everything seen so far, SRAM devices first, then by signal strength. */
  devices(): DiscoveredDevice[] {
    return [...this.discovered.values()].sort((a, b) => {
      if (a.identification.isSram !== b.identification.isSram) {
        return a.identification.isSram ? -1 : 1;
      }
      return (b.result.rssi ?? -999) - (a.result.rssi ?? -999);
    });
  }

  clearDevices(): void {
    this.discovered.clear();
  }

  /**
   * Connect to a device and run the full read-only reconnaissance pass.
   *
   * The returned session stays live — subscriptions keep delivering frames
   * until you call `close()`.
   */
  async probe(deviceId: string, options: ProbeOptions = {}): Promise<DeviceSession> {
    const { readAll = true, subscribeAll = true, connectTimeoutMs = 15_000 } = options;

    this.log("info", `Connecting to ${deviceId}…`);
    const peripheral = await this.transport.connect(deviceId, { timeoutMs: connectTimeoutMs });

    const session = new DeviceSession(peripheral, this.registry);
    session.events.on("log", (entry) => this.events.emit("log", entry));

    await session.discover();
    if (readAll) await session.readAll();
    if (subscribeAll) await session.subscribeAll();

    this.log("info", "Probe complete; streaming notifications.");
    return session;
  }
}

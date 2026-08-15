/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * An in-memory BLE transport.
 *
 * Two jobs:
 *  1. Unit tests — deterministic, no hardware, no timers unless asked for.
 *  2. Simulator mode in the demo app — iOS Simulator has no Bluetooth, so
 *     without this you cannot open the UI without a physical phone and a bike.
 *
 * The simulated derailleur mirrors the real AXS BLE shapes: SRAM vendor
 * characteristics, a plaintext usage record, and an AES-EAX encrypted live-state
 * channel carrying `drivetrain_status`. It exercises the whole pipeline —
 * decrypt included — without hardware.
 */

import { AXS_USAGE_RECORD_OFFSETS } from "../axs/device-info.js";
import { LIVE_STATE_CHARACTERISTIC } from "../axs/srambond.js";
import {
  SRAMBOND_FINALIZE,
  SRAMBOND_GENERATOR,
  SRAMBOND_INIT,
  SRAMBOND_MODULUS,
  SRAMBOND_V1_CHARACTERISTIC,
  SRAMBOND_V1_SERVICE,
} from "../axs/srambond-bond.js";
import { eaxEncrypt } from "../crypto/aes-eax.js";
import { bigIntToBytes, bytesToBigInt, modPow } from "../crypto/dh.js";
import { SRAM_COMPANY_ID } from "../identify.js";
import {
  clearIntervalCompat,
  setIntervalCompat,
  setTimeoutCompat,
  type TimerHandle,
} from "../timers.js";
import type {
  BleTransport,
  ConnectedPeripheral,
  GattService,
  ScanResult,
  Unsubscribe,
} from "../transport.js";

export interface FakeCharacteristicSpec {
  uuid: string;
  properties?: Partial<{
    read: boolean;
    write: boolean;
    writeWithoutResponse: boolean;
    notify: boolean;
    indicate: boolean;
  }>;
  /** Value returned by reads. */
  value?: Uint8Array;
  /**
   * Produces a fresh value for each read. Real components serve current state
   * on every read, so anything time-varying should use this rather than a fixed
   * `value`. Takes precedence over `value`.
   */
  readGenerator?: () => Uint8Array;
  /** When set, notifications are emitted at this interval once subscribed. */
  notifyIntervalMs?: number;
  /** Produces successive notification payloads. */
  notifyGenerator?: (tick: number) => Uint8Array;
  /** Make reads reject, mimicking a characteristic that requires bonding. */
  readFails?: boolean;
  /** Make reads never settle, mimicking a wedged GATT read. */
  readHangs?: boolean;
  /**
   * Called on every write, with a `notify` callback that pushes a value to
   * whoever is currently subscribed. This is how request/response
   * characteristics behave — the answer to a write arrives as a notification,
   * not as a readable value.
   */
  onWrite?: (value: Uint8Array, notify: (payload: Uint8Array) => void) => void;
}

export interface FakeServiceSpec {
  uuid: string;
  characteristics: FakeCharacteristicSpec[];
}

export interface FakeDeviceSpec {
  id: string;
  name: string | null;
  rssi?: number;
  manufacturerData?: Uint8Array;
  services: FakeServiceSpec[];
  mtu?: number;
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0x7f;
  return out;
}

/** Build a well-formed SRAM manufacturer-data blob (company ID + payload). */
export function sramManufacturerData(payload: number[] = []): Uint8Array {
  return Uint8Array.from([SRAM_COMPANY_ID & 0xff, (SRAM_COMPANY_ID >> 8) & 0xff, ...payload]);
}

/**
 * The AES key the simulated derailleur uses for its encrypted live-state
 * channel. A real component mints its own during pairing; the simulator publishes
 * a fixed one so tests and the demo app can decrypt without a bond:
 *
 * ```ts
 * probe.registry.add(createSrambondDecoder(SIMULATOR_DEVICE_KEY));
 * ```
 */
export const SIMULATOR_DEVICE_KEY = Uint8Array.from([
  0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
]);

/** Length of every SRAMBond key: DH keys, the shared secret, the device key. */
const KEY_LENGTH = 16;

/**
 * The simulated component's Diffie-Hellman private key.
 *
 * Fixed rather than random so a captured simulator session replays identically.
 * A real component generates a fresh one per bond; nothing here is a secret,
 * since the simulator's device key is published above anyway.
 */
const bondPrivateKey = 0x0f1e2d3c4b5a69788796a5b4c3d2e1f0n;

/** Encode a protobuf `uint32` field (wire type 0). */
function protobufUint32(fieldNumber: number, value: number): number[] {
  const out: number[] = [];
  let tag = fieldNumber << 3;
  do {
    const byte = tag & 0x7f;
    tag >>>= 7;
    out.push(tag ? byte | 0x80 : byte);
  } while (tag);
  let v = value;
  do {
    const byte = v & 0x7f;
    v >>>= 7;
    out.push(v ? byte | 0x80 : byte);
  } while (v);
  return out;
}

/** Wrap a plaintext message as a SRAMBond frame: nonce(16) ‖ ciphertext ‖ tag(16). */
function srambondFrame(plaintext: Uint8Array, nonceSeed: number): Uint8Array {
  const nonce = new Uint8Array(16);
  // Deterministic per-message nonce, so captures replay identically.
  for (let i = 0; i < 16; i++) nonce[i] = (nonceSeed * 31 + i * 7) & 0xff;
  const sealed = eaxEncrypt(SIMULATOR_DEVICE_KEY, nonce, plaintext, { tagLength: 16 });
  const frame = new Uint8Array(nonce.length + sealed.length);
  frame.set(nonce);
  frame.set(sealed, nonce.length);
  return frame;
}

/**
 * A simulated GX Eagle Transmission derailleur that speaks the real AXS BLE
 * shapes: SRAM vendor characteristics, a plaintext usage record carrying the
 * cumulative shift counter and uptime, and an AES-EAX encrypted live-state
 * channel carrying `drivetrain_status`.
 *
 * The gear walks up and down the cassette so the dashboard has something to
 * show. Decrypting requires {@link SIMULATOR_DEVICE_KEY}, exactly as a real
 * component requires the key from its bond.
 */
export function simulatedDerailleur(id = "sim-rd-0001"): FakeDeviceSpec {
  let gear = 1;
  let direction = 1;
  let shiftCounter = 0;
  let uptime = 0;
  let tick = 0;

  /** Advance the simulated drivetrain one tick; a shift lands every 8 ticks. */
  const advance = (): void => {
    if (tick > 0 && tick % 8 === 0) {
      gear += direction;
      if (gear >= 12) direction = -1;
      if (gear <= 1) direction = 1;
      shiftCounter = (shiftCounter + 1) % 256;
    }
    uptime = (uptime + 1) % 0x10000;
    tick++;
  };

  /** An encrypted `drivetrain_status` frame carrying the current gear. */
  const drivetrainStatusFrame = (nonceSeed: number): Uint8Array =>
    srambondFrame(
      Uint8Array.from([
        ...protobufUint32(20, 1), // fd_position
        ...protobufUint32(21, gear), // rd_position — the gear
        ...protobufUint32(22, 12), // rd_trim
      ]),
      nonceSeed,
    );

  // --- SRAMBond pairing, device side ----------------------------------------
  // Mirrors what a component does during create-bond: take the client's
  // Diffie-Hellman public key, answer with its own, then hand back its
  // live-state key wrapped under the shared secret. Modelling this means the
  // demo app can exercise the whole pairing flow — including the notify-only
  // response path that tripped up the first hardware attempt — with no bike.
  let bondStage: "idle" | "initialised" | "bonded" = "idle";

  const equals = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);

  const handleBondWrite = (
    value: Uint8Array,
    notify: (payload: Uint8Array) => void,
  ): void => {
    if (equals(value, SRAMBOND_INIT)) {
      bondStage = "initialised";
      return;
    }

    if (equals(value, SRAMBOND_FINALIZE)) {
      if (bondStage === "initialised") bondStage = "bonded";
      return;
    }

    // A component ignores a public key it was not primed for with INIT.
    if (bondStage !== "initialised" || value.length !== KEY_LENGTH) return;

    const devicePublic = bigIntToBytes(
      modPow(SRAMBOND_GENERATOR, bondPrivateKey, SRAMBOND_MODULUS),
      KEY_LENGTH,
      "be",
    );
    const shared = bigIntToBytes(
      modPow(bytesToBigInt(value, "be"), bondPrivateKey, SRAMBOND_MODULUS),
      KEY_LENGTH,
      "be",
    );

    // Key transport: nonce(16) ‖ ciphertext(16) ‖ tag(16), sealed under the
    // shared secret. The key handed over is the same one the live-state channel
    // uses, so pairing in the simulator yields a key that really decrypts gear.
    const nonce = new Uint8Array(KEY_LENGTH);
    for (let i = 0; i < nonce.length; i++) nonce[i] = (i * 37 + 11) & 0xff;
    const sealed = eaxEncrypt(shared, nonce, SIMULATOR_DEVICE_KEY, { tagLength: 16 });

    const blob = new Uint8Array(nonce.length + sealed.length);
    blob.set(nonce);
    blob.set(sealed, nonce.length);

    notify(devicePublic);
    notify(blob);
  };

  /** The plaintext `d9050003` usage record: 54 bytes, mostly static. */
  const usageRecord = (): Uint8Array => {
    const record = new Uint8Array(54);
    record[0] = 0x01; // record type — constant
    record[AXS_USAGE_RECORD_OFFSETS.shiftLinked] = 60 + (gear % 5);
    record[AXS_USAGE_RECORD_OFFSETS.unknownSensor] = (tick * 3) & 0xff;
    record[AXS_USAGE_RECORD_OFFSETS.uptime] = uptime & 0xff;
    record[AXS_USAGE_RECORD_OFFSETS.uptime + 1] = (uptime >> 8) & 0xff;
    record[AXS_USAGE_RECORD_OFFSETS.shiftCount] = shiftCounter;
    return record;
  };

  return {
    id,
    name: "SIM GX Eagle RD",
    rssi: -58,
    manufacturerData: sramManufacturerData([0x02, 0x11, 0x00]),
    mtu: 247,
    services: [
      {
        uuid: "180a",
        characteristics: [
          { uuid: "2a29", value: ascii("SRAM"), properties: { read: true } },
          { uuid: "2a24", value: ascii("RD-GX-E-B1"), properties: { read: true } },
          { uuid: "2a25", value: ascii("SIM00000001"), properties: { read: true } },
          { uuid: "2a26", value: ascii("1.28.0"), properties: { read: true } },
          { uuid: "2a27", value: ascii("B1"), properties: { read: true } },
        ],
      },
      {
        uuid: "180f",
        characteristics: [
          {
            uuid: "2a19",
            value: Uint8Array.from([87]),
            properties: { read: true, notify: true },
            notifyIntervalMs: 5000,
            notifyGenerator: () => Uint8Array.from([87]),
          },
        ],
      },
      {
        // The real SRAM vendor service family.
        uuid: "d9050001-90aa-4c7c-b036-1e01fb8eb7ee",
        characteristics: [
          // Plaintext usage record: cumulative shift counter and uptime.
          {
            uuid: "d9050003-90aa-4c7c-b036-1e01fb8eb7ee",
            properties: { read: true, notify: true },
            value: usageRecord(),
            notifyIntervalMs: 250,
            notifyGenerator: () => {
              advance();
              return usageRecord();
            },
          },
          // Encrypted live state: drivetrain_status, the gear source.
          {
            uuid: LIVE_STATE_CHARACTERISTIC,
            properties: { read: true, notify: true },
            notifyIntervalMs: 250,
            notifyGenerator: (n) => drivetrainStatusFrame(n),
            // A read returns current state, exactly as the component does.
            readGenerator: () => {
              advance();
              return drivetrainStatusFrame(tick);
            },
          },
          // Encrypted drivetrain_config: how many cogs the cassette has.
          {
            uuid: "d9050025-90aa-4c7c-b036-1e01fb8eb7ee",
            properties: { read: true },
            value: srambondFrame(
              Uint8Array.from([
                ...protobufUint32(23, 1), // fd_num_gears
                ...protobufUint32(24, 12), // rd_num_gears
                ...protobufUint32(25, 5), // rd_num_trim
              ]),
              1,
            ),
          },
          // Stands in for a characteristic that refuses reads without a bond.
          {
            uuid: "d90500f1-90aa-4c7c-b036-1e01fb8eb7ee",
            properties: { read: true },
            readFails: true,
          },
        ],
      },
      {
        // SRAMBond v1 — the pairing service. Write-and-notify with no read
        // property, matching real hardware, where reading this characteristic
        // is rejected outright.
        uuid: SRAMBOND_V1_SERVICE,
        characteristics: [
          {
            uuid: SRAMBOND_V1_CHARACTERISTIC,
            properties: { write: true, notify: true },
            onWrite: handleBondWrite,
          },
        ],
      },
    ],
  };
}

class FakePeripheral implements ConnectedPeripheral {
  private disconnectHandlers = new Set<(error: Error | null) => void>();
  private timers = new Set<TimerHandle>();
  private subscribers = new Map<FakeCharacteristicSpec, Set<(value: Uint8Array) => void>>();
  private connected = true;

  constructor(private readonly spec: FakeDeviceSpec) {}

  get id(): string {
    return this.spec.id;
  }

  get name(): string | null {
    return this.spec.name;
  }

  private find(serviceUuid: string, characteristicUuid: string): FakeCharacteristicSpec {
    const service = this.spec.services.find(
      (s) => s.uuid.toLowerCase() === serviceUuid.toLowerCase(),
    );
    if (!service) throw new Error(`No such service: ${serviceUuid}`);

    const characteristic = service.characteristics.find(
      (c) => c.uuid.toLowerCase() === characteristicUuid.toLowerCase(),
    );
    if (!characteristic) throw new Error(`No such characteristic: ${characteristicUuid}`);

    return characteristic;
  }

  async discoverServices(): Promise<GattService[]> {
    return this.spec.services.map((service) => ({
      uuid: service.uuid,
      characteristics: service.characteristics.map((c) => ({
        uuid: c.uuid,
        serviceUuid: service.uuid,
        properties: {
          read: c.properties?.read ?? false,
          write: c.properties?.write ?? false,
          writeWithoutResponse: c.properties?.writeWithoutResponse ?? false,
          notify: c.properties?.notify ?? false,
          indicate: c.properties?.indicate ?? false,
        },
      })),
    }));
  }

  async read(serviceUuid: string, characteristicUuid: string): Promise<Uint8Array> {
    const characteristic = this.find(serviceUuid, characteristicUuid);
    if (characteristic.readFails) {
      throw new Error("Read not permitted (simulated authentication requirement)");
    }
    if (characteristic.readHangs) {
      // Never settles. Real BLE stacks do this; the poll loop must survive it.
      return new Promise<Uint8Array>(() => {});
    }
    if (characteristic.readGenerator) return characteristic.readGenerator();
    return characteristic.value ?? new Uint8Array(0);
  }

  async write(
    serviceUuid: string,
    characteristicUuid: string,
    value: Uint8Array,
  ): Promise<void> {
    const characteristic = this.find(serviceUuid, characteristicUuid);
    characteristic.value = value;

    if (characteristic.onWrite) {
      const listeners = this.subscribers.get(characteristic);
      characteristic.onWrite(value, (payload) => {
        for (const listener of listeners ?? []) listener(payload);
      });
    }
  }

  async subscribe(
    serviceUuid: string,
    characteristicUuid: string,
    onValue: (value: Uint8Array) => void,
  ): Promise<Unsubscribe> {
    const characteristic = this.find(serviceUuid, characteristicUuid);

    // Register first, so a write-driven response reaches this subscriber even
    // if the characteristic emits nothing on its own.
    let listeners = this.subscribers.get(characteristic);
    if (!listeners) {
      listeners = new Set();
      this.subscribers.set(characteristic, listeners);
    }
    const registered = listeners;
    registered.add(onValue);

    let timer: TimerHandle = null;
    if (characteristic.notifyGenerator && characteristic.notifyIntervalMs) {
      let tick = 0;
      timer = setIntervalCompat(() => {
        onValue(characteristic.notifyGenerator!(tick++));
      }, characteristic.notifyIntervalMs);
      this.timers.add(timer);
    }

    return () => {
      registered.delete(onValue);
      if (timer) {
        clearIntervalCompat(timer);
        this.timers.delete(timer);
      }
    };
  }

  mtu(): number | null {
    return this.spec.mtu ?? null;
  }

  onDisconnected(handler: (error: Error | null) => void): Unsubscribe {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;

    for (const timer of this.timers) clearIntervalCompat(timer);
    this.timers.clear();

    for (const handler of this.disconnectHandlers) handler(null);
  }

  /** Test helper: simulate the bike rolling out of range. */
  simulateDisconnect(error: Error): void {
    this.connected = false;
    for (const timer of this.timers) clearIntervalCompat(timer);
    this.timers.clear();
    for (const handler of this.disconnectHandlers) handler(error);
  }
}

export class FakeTransport implements BleTransport {
  // TimerHandle is platform-opaque (`unknown`), so null needs no union.
  private scanTimer: TimerHandle = null;
  readonly peripherals = new Map<string, FakePeripheral>();

  constructor(
    private readonly devices: FakeDeviceSpec[] = [simulatedDerailleur()],
    private readonly options: { advertiseIntervalMs?: number; readyDelayMs?: number } = {},
  ) {}

  async ready(): Promise<void> {
    const delay = this.options.readyDelayMs ?? 0;
    if (delay > 0) await new Promise<void>((resolve) => setTimeoutCompat(() => resolve(), delay));
  }

  private advertisement(spec: FakeDeviceSpec): ScanResult {
    return {
      id: spec.id,
      name: spec.name,
      // Jitter the RSSI so the UI looks alive.
      rssi: (spec.rssi ?? -60) + Math.round((Math.random() - 0.5) * 6),
      manufacturerData: spec.manufacturerData ?? null,
      serviceUuids: spec.services.map((s) => s.uuid),
      serviceData: {},
      timestamp: Date.now(),
    };
  }

  async startScan(onResult: (result: ScanResult) => void): Promise<Unsubscribe> {
    // Emit one round immediately so tests do not need fake timers.
    for (const spec of this.devices) onResult(this.advertisement(spec));

    const interval = this.options.advertiseIntervalMs ?? 0;
    if (interval > 0) {
      this.scanTimer = setIntervalCompat(() => {
        for (const spec of this.devices) onResult(this.advertisement(spec));
      }, interval);
    }

    return () => {
      if (this.scanTimer) clearIntervalCompat(this.scanTimer);
      this.scanTimer = null;
    };
  }

  async connect(id: string): Promise<ConnectedPeripheral> {
    const spec = this.devices.find((d) => d.id === id);
    if (!spec) throw new Error(`No such device: ${id}`);

    const peripheral = new FakePeripheral(spec);
    this.peripherals.set(id, peripheral);
    return peripheral;
  }

  /** Test helper: force-disconnect a connected peripheral. */
  disconnectDevice(id: string, error = new Error("Connection lost")): void {
    this.peripherals.get(id)?.simulateDisconnect(error);
  }
}


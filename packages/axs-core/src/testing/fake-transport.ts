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
import { eaxEncrypt } from "../crypto/aes-eax.js";
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
    ],
  };
}

class FakePeripheral implements ConnectedPeripheral {
  private disconnectHandlers = new Set<(error: Error | null) => void>();
  private timers = new Set<TimerHandle>();
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
  }

  async subscribe(
    serviceUuid: string,
    characteristicUuid: string,
    onValue: (value: Uint8Array) => void,
  ): Promise<Unsubscribe> {
    const characteristic = this.find(serviceUuid, characteristicUuid);

    if (!characteristic.notifyGenerator || !characteristic.notifyIntervalMs) {
      // Subscribable but silent — a real and common situation.
      return () => {};
    }

    let tick = 0;
    const timer = setIntervalCompat(() => {
      onValue(characteristic.notifyGenerator!(tick++));
    }, characteristic.notifyIntervalMs);

    this.timers.add(timer);

    return () => {
      clearIntervalCompat(timer);
      this.timers.delete(timer);
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


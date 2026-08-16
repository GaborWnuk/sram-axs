/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * `@stoprocent/noble` implementation of the core `BleTransport` contract.
 *
 * Desktop counterpart to the app's `PlxTransport`. Same interface, so every
 * decoder, tracker and recorder above it is byte-for-byte the same code that
 * runs on the phone — which is the point: validate the library here, then ship
 * it to React Native unchanged.
 *
 * On macOS this drives CoreBluetooth via native bindings, giving full GATT
 * discovery and raw advertisement data. (Web Bluetooth cannot do this: Chrome
 * only exposes services you name up front, which is useless when the whole task
 * is finding services you do not know about.)
 */

import noble, {
  type Characteristic,
  type Peripheral,
  type Service,
} from "@stoprocent/noble";
import {
  normalizeUuid,
  type BleTransport,
  type ConnectedPeripheral,
  type GattService,
  type ScanResult,
  type TransportUnsubscribe,
} from "@gaborwnuk/axs-core";

/** Copy a Node Buffer into a plain Uint8Array so nothing downstream sees Buffer. */
function toBytes(buffer: Buffer | null | undefined): Uint8Array {
  if (!buffer) return new Uint8Array(0);
  return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

class NoblePeripheral implements ConnectedPeripheral {
  private services: Service[] = [];
  private disconnectHandlers = new Set<(error: Error | null) => void>();

  constructor(private readonly peripheral: Peripheral) {
    this.peripheral.once("disconnect", (reason) => {
      const error =
        reason === undefined || reason === null || reason === "" || reason === 0
          ? null
          : new Error(`Disconnected: ${String(reason)}`);
      for (const handler of this.disconnectHandlers) handler(error);
    });
  }

  get id(): string {
    return this.peripheral.id;
  }

  get name(): string | null {
    return this.peripheral.advertisement?.localName || null;
  }

  async discoverServices(): Promise<GattService[]> {
    const { services } = await this.peripheral.discoverAllServicesAndCharacteristicsAsync();
    this.services = services;

    return services.map((service) => ({
      uuid: normalizeUuid(service.uuid),
      characteristics: (service.characteristics ?? []).map((c) => ({
        uuid: normalizeUuid(c.uuid),
        serviceUuid: normalizeUuid(service.uuid),
        properties: {
          read: c.properties.includes("read"),
          write: c.properties.includes("write"),
          writeWithoutResponse: c.properties.includes("writeWithoutResponse"),
          notify: c.properties.includes("notify"),
          indicate: c.properties.includes("indicate"),
        },
      })),
    }));
  }

  /** Locate a discovered characteristic. noble reports UUIDs undashed. */
  private find(serviceUuid: string, characteristicUuid: string): Characteristic {
    const wantService = normalizeUuid(serviceUuid);
    const wantCharacteristic = normalizeUuid(characteristicUuid);

    const service = this.services.find((s) => normalizeUuid(s.uuid) === wantService);
    if (!service) throw new Error(`Service not discovered: ${serviceUuid}`);

    const characteristic = (service.characteristics ?? []).find(
      (c) => normalizeUuid(c.uuid) === wantCharacteristic,
    );
    if (!characteristic) throw new Error(`Characteristic not discovered: ${characteristicUuid}`);

    return characteristic;
  }

  async read(serviceUuid: string, characteristicUuid: string): Promise<Uint8Array> {
    return toBytes(await this.find(serviceUuid, characteristicUuid).readAsync());
  }

  async write(
    serviceUuid: string,
    characteristicUuid: string,
    value: Uint8Array,
    withResponse = true,
  ): Promise<void> {
    await this.find(serviceUuid, characteristicUuid).writeAsync(
      Buffer.from(value),
      !withResponse,
    );
  }

  async subscribe(
    serviceUuid: string,
    characteristicUuid: string,
    onValue: (value: Uint8Array) => void,
    onError?: (error: Error) => void,
  ): Promise<TransportUnsubscribe> {
    const characteristic = this.find(serviceUuid, characteristicUuid);

    const listener = (data: Buffer) => onValue(toBytes(data));
    characteristic.on("data", listener);

    try {
      await characteristic.subscribeAsync();
    } catch (error) {
      characteristic.removeListener("data", listener);
      throw error;
    }

    return () => {
      characteristic.removeListener("data", listener);
      characteristic.unsubscribeAsync().catch((error: Error) => onError?.(error));
    };
  }

  mtu(): number | null {
    return this.peripheral.mtu ?? null;
  }

  onDisconnected(handler: (error: Error | null) => void): TransportUnsubscribe {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  async disconnect(): Promise<void> {
    try {
      await this.peripheral.disconnectAsync();
    } catch {
      // Already gone.
    }
  }
}

export class NobleTransport implements BleTransport {
  /** Peripherals seen while scanning, so `connect` can reuse the handle. */
  private discovered = new Map<string, Peripheral>();
  private scanning = false;

  constructor() {
    // A real AXS component exposes 13+ notifiable characteristics, and noble
    // registers an internal disconnect listener per subscription. The default
    // ceiling of 10 trips a spurious MaxListenersExceededWarning that looks
    // like a leak but is just a fully-enumerated device.
    noble.setMaxListeners(128);
  }

  async ready(): Promise<void> {
    if (noble.state === "poweredOn") return;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Bluetooth adapter did not power on (state: ${noble.state}). ` +
              "On macOS, grant your terminal Bluetooth access in " +
              "System Settings > Privacy & Security > Bluetooth.",
          ),
        );
      }, 10_000);

      const onState = (state: string) => {
        if (state === "poweredOn") {
          clearTimeout(timer);
          noble.removeListener("stateChange", onState);
          resolve();
        } else if (state === "unauthorized") {
          clearTimeout(timer);
          noble.removeListener("stateChange", onState);
          reject(
            new Error(
              "Bluetooth access denied. Grant your terminal Bluetooth access in " +
                "System Settings > Privacy & Security > Bluetooth, then retry.",
            ),
          );
        } else if (state === "unsupported") {
          clearTimeout(timer);
          noble.removeListener("stateChange", onState);
          reject(new Error("No Bluetooth LE adapter available."));
        }
      };

      noble.on("stateChange", onState);
    });
  }

  async startScan(
    onResult: (result: ScanResult) => void,
    options?: { serviceUuids?: string[] },
  ): Promise<TransportUnsubscribe> {
    const onDiscover = (peripheral: Peripheral) => {
      this.discovered.set(peripheral.id, peripheral);

      const advertisement = peripheral.advertisement ?? {};
      const serviceData: Record<string, Uint8Array> = {};
      for (const entry of advertisement.serviceData ?? []) {
        serviceData[normalizeUuid(entry.uuid)] = toBytes(entry.data);
      }

      onResult({
        id: peripheral.id,
        name: advertisement.localName || null,
        rssi: typeof peripheral.rssi === "number" ? peripheral.rssi : null,
        manufacturerData: advertisement.manufacturerData
          ? toBytes(advertisement.manufacturerData)
          : null,
        serviceUuids: (advertisement.serviceUuids ?? []).map(normalizeUuid),
        serviceData,
        timestamp: Date.now(),
      });
    };

    noble.on("discover", onDiscover);

    // allowDuplicates keeps RSSI and changing manufacturer data flowing, both
    // of which are useful reconnaissance signals in their own right.
    await noble.startScanningAsync(options?.serviceUuids?.map(normalizeUuid) ?? [], true);
    this.scanning = true;

    return () => {
      noble.removeListener("discover", onDiscover);
      if (this.scanning) {
        this.scanning = false;
        void noble.stopScanningAsync();
      }
    };
  }

  async connect(id: string, options?: { timeoutMs?: number }): Promise<ConnectedPeripheral> {
    // Scanning during a connect makes connects unreliable on some adapters.
    if (this.scanning) {
      this.scanning = false;
      await noble.stopScanningAsync();
    }

    const known = this.discovered.get(id);
    const timeoutMs = options?.timeoutMs ?? 15_000;

    if (known) {
      await withTimeout(known.connectAsync(), timeoutMs, `Timed out connecting to ${id}`);
      return new NoblePeripheral(known);
    }

    const peripheral = await withTimeout(
      noble.connectAsync(id),
      timeoutMs,
      `Timed out connecting to ${id}`,
    );
    return new NoblePeripheral(peripheral);
  }

  /** Release the adapter so the process can exit cleanly. */
  stop(): void {
    try {
      noble.stop();
    } catch {
      // Nothing useful to do during teardown.
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

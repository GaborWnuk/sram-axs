/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * `react-native-ble-plx` implementation of the core `BleTransport` contract.
 *
 * This is the only file in the app that knows a BLE stack exists. Swap it for a
 * different library (or the core's `FakeTransport`) and everything above keeps
 * working unchanged.
 *
 * Two details worth knowing:
 *  - ble-plx exchanges characteristic values as **base64 strings**. The core's
 *    `fromBase64`/`toBase64` handle that, because Hermes has no `Buffer`.
 *  - ble-plx wants service and characteristic UUIDs in canonical 128-bit
 *    lower-case form, so everything is passed through `normalizeUuid`.
 */

import {
  BleManager,
  State,
  type Characteristic,
  type Device,
  type Subscription,
} from "react-native-ble-plx";
import {
  fromBase64,
  normalizeUuid,
  toBase64,
  type BleTransport,
  type ConnectedPeripheral,
  type GattService,
  type ScanResult,
  type TransportUnsubscribe,
} from "@gaborwnuk/axs-core";

/** Convert ble-plx's `{ [id]: base64 }` service-data map into bytes. */
function decodeServiceData(
  serviceData: Record<string, string> | null,
): Record<string, Uint8Array> {
  if (!serviceData) return {};

  const out: Record<string, Uint8Array> = {};
  for (const [uuid, value] of Object.entries(serviceData)) {
    out[normalizeUuid(uuid)] = fromBase64(value);
  }
  return out;
}

class PlxPeripheral implements ConnectedPeripheral {
  private subscriptions = new Set<Subscription>();
  private negotiatedMtu: number | null = null;

  constructor(private device: Device) {
    this.negotiatedMtu = device.mtu ?? null;
  }

  get id(): string {
    return this.device.id;
  }

  get name(): string | null {
    return this.device.name ?? this.device.localName ?? null;
  }

  async discoverServices(): Promise<GattService[]> {
    this.device = await this.device.discoverAllServicesAndCharacteristics();
    this.negotiatedMtu = this.device.mtu ?? this.negotiatedMtu;

    const services = await this.device.services();

    return Promise.all(
      services.map(async (service) => {
        const characteristics = await service.characteristics();
        return {
          uuid: normalizeUuid(service.uuid),
          characteristics: characteristics.map((c: Characteristic) => ({
            uuid: normalizeUuid(c.uuid),
            serviceUuid: normalizeUuid(service.uuid),
            properties: {
              read: c.isReadable,
              write: c.isWritableWithResponse,
              writeWithoutResponse: c.isWritableWithoutResponse,
              notify: c.isNotifiable,
              indicate: c.isIndicatable,
            },
          })),
        };
      }),
    );
  }

  async read(serviceUuid: string, characteristicUuid: string): Promise<Uint8Array> {
    const characteristic = await this.device.readCharacteristicForService(
      normalizeUuid(serviceUuid),
      normalizeUuid(characteristicUuid),
    );
    return characteristic.value ? fromBase64(characteristic.value) : new Uint8Array(0);
  }

  async write(
    serviceUuid: string,
    characteristicUuid: string,
    value: Uint8Array,
    withResponse = true,
  ): Promise<void> {
    const service = normalizeUuid(serviceUuid);
    const characteristic = normalizeUuid(characteristicUuid);
    const encoded = toBase64(value);

    if (withResponse) {
      await this.device.writeCharacteristicWithResponseForService(
        service,
        characteristic,
        encoded,
      );
    } else {
      await this.device.writeCharacteristicWithoutResponseForService(
        service,
        characteristic,
        encoded,
      );
    }
  }

  async subscribe(
    serviceUuid: string,
    characteristicUuid: string,
    onValue: (value: Uint8Array) => void,
    onError?: (error: Error) => void,
  ): Promise<TransportUnsubscribe> {
    const subscription = this.device.monitorCharacteristicForService(
      normalizeUuid(serviceUuid),
      normalizeUuid(characteristicUuid),
      (error, characteristic) => {
        if (error) {
          // A cancelled monitor during teardown is expected, not a failure.
          if (error.errorCode !== 2 /* OperationCancelled */) {
            onError?.(new Error(error.message));
          }
          return;
        }
        if (characteristic?.value) onValue(fromBase64(characteristic.value));
      },
    );

    this.subscriptions.add(subscription);

    return () => {
      subscription.remove();
      this.subscriptions.delete(subscription);
    };
  }

  mtu(): number | null {
    return this.negotiatedMtu;
  }

  onDisconnected(handler: (error: Error | null) => void): TransportUnsubscribe {
    const subscription = this.device.onDisconnected((error) => {
      handler(error ? new Error(error.message) : null);
    });

    return () => subscription.remove();
  }

  async disconnect(): Promise<void> {
    for (const subscription of this.subscriptions) subscription.remove();
    this.subscriptions.clear();

    try {
      await this.device.cancelConnection();
    } catch {
      // Already disconnected.
    }
  }
}

export class PlxTransport implements BleTransport {
  readonly manager: BleManager;

  constructor(manager?: BleManager) {
    this.manager = manager ?? new BleManager();
  }

  /** Resolve once the adapter reports PoweredOn, or reject with a clear reason. */
  async ready(): Promise<void> {
    const state = await this.manager.state();
    if (state === State.PoweredOn) return;

    return new Promise((resolve, reject) => {
      const subscription = this.manager.onStateChange((next) => {
        if (next === State.PoweredOn) {
          subscription.remove();
          resolve();
        } else if (next === State.Unauthorized) {
          subscription.remove();
          reject(new Error("Bluetooth permission denied. Grant it in system settings."));
        } else if (next === State.Unsupported) {
          subscription.remove();
          reject(new Error("This device has no Bluetooth LE support."));
        }
      }, true);
    });
  }

  async startScan(
    onResult: (result: ScanResult) => void,
    options?: { serviceUuids?: string[] },
  ): Promise<TransportUnsubscribe> {
    const serviceUuids = options?.serviceUuids?.map(normalizeUuid) ?? null;

    void this.manager.startDeviceScan(serviceUuids, { allowDuplicates: true }, (error, device) => {
      if (error || !device) return;

      onResult({
        id: device.id,
        name: device.name ?? device.localName ?? null,
        rssi: device.rssi ?? null,
        manufacturerData: device.manufacturerData
          ? fromBase64(device.manufacturerData)
          : null,
        serviceUuids: (device.serviceUUIDs ?? []).map(normalizeUuid),
        serviceData: decodeServiceData(device.serviceData),
        timestamp: Date.now(),
      });
    });

    return () => {
      void this.manager.stopDeviceScan();
    };
  }

  async connect(
    id: string,
    options?: { timeoutMs?: number },
  ): Promise<ConnectedPeripheral> {
    // Scanning while connecting causes flaky connects on Android.
    void this.manager.stopDeviceScan();

    const device = await this.manager.connectToDevice(id, {
      timeout: options?.timeoutMs ?? 15_000,
      // A larger MTU means vendor frames arrive whole rather than fragmented.
      requestMTU: 247,
    });

    return new PlxPeripheral(device);
  }

  destroy(): void {
    void this.manager.destroy();
  }
}

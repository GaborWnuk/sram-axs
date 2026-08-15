/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * Transport abstraction.
 *
 * The core library never imports a BLE stack. Callers supply an implementation
 * of {@link BleTransport} — `react-native-ble-plx` in the demo app, an
 * in-memory fake in the unit tests, a recorded session in replay mode.
 *
 * This is what makes the decoding logic testable in plain Node and keeps the
 * package free of native dependencies.
 */

/** Characteristic capability flags, as reported by the GATT server. */
export interface CharacteristicProperties {
  read: boolean;
  write: boolean;
  writeWithoutResponse: boolean;
  notify: boolean;
  indicate: boolean;
}

/** A single GATT characteristic. */
export interface GattCharacteristic {
  uuid: string;
  serviceUuid: string;
  properties: CharacteristicProperties;
}

/** A GATT service and its characteristics. */
export interface GattService {
  uuid: string;
  characteristics: GattCharacteristic[];
}

/** Result of a BLE advertisement observation. */
export interface ScanResult {
  /** Platform-specific handle. On iOS this is a UUID, on Android a MAC. */
  id: string;
  /** Advertised local name, when present. */
  name: string | null;
  /** Received signal strength in dBm, when the platform reports it. */
  rssi: number | null;
  /**
   * Raw manufacturer-specific advertisement data, including the leading
   * little-endian company identifier. Null when the device advertises none.
   */
  manufacturerData: Uint8Array | null;
  /** Service UUIDs present in the advertisement. */
  serviceUuids: string[];
  /** Service data blobs keyed by service UUID. */
  serviceData: Record<string, Uint8Array>;
  /** Milliseconds since epoch when this advertisement was observed. */
  timestamp: number;
}

/** Unsubscribe handle returned by subscription methods. */
export type Unsubscribe = () => void;

/** A connected peripheral. */
export interface ConnectedPeripheral {
  readonly id: string;
  readonly name: string | null;

  /** Discover and return the full GATT tree. */
  discoverServices(): Promise<GattService[]>;

  /** Read a characteristic's current value. */
  read(serviceUuid: string, characteristicUuid: string): Promise<Uint8Array>;

  /** Write a characteristic, with or without a response. */
  write(
    serviceUuid: string,
    characteristicUuid: string,
    value: Uint8Array,
    withResponse?: boolean,
  ): Promise<void>;

  /** Subscribe to notifications or indications. */
  subscribe(
    serviceUuid: string,
    characteristicUuid: string,
    onValue: (value: Uint8Array) => void,
    onError?: (error: Error) => void,
  ): Promise<Unsubscribe>;

  /** Negotiated ATT MTU, when the platform exposes it. */
  mtu(): number | null;

  /** Fires when the peripheral disconnects for any reason. */
  onDisconnected(handler: (error: Error | null) => void): Unsubscribe;

  disconnect(): Promise<void>;
}

/** The BLE stack. */
export interface BleTransport {
  /**
   * Resolve once the adapter is powered on and usable. Implementations should
   * reject if the user has denied permission or Bluetooth is off.
   */
  ready(): Promise<void>;

  /**
   * Start scanning. Every advertisement — including repeat sightings of the
   * same device — is delivered to `onResult`, because RSSI trends and changing
   * manufacturer data are themselves useful reconnaissance signals.
   */
  startScan(
    onResult: (result: ScanResult) => void,
    options?: { serviceUuids?: string[] },
  ): Promise<Unsubscribe>;

  connect(id: string, options?: { timeoutMs?: number }): Promise<ConnectedPeripheral>;
}

/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * The public API surface, pinned.
 *
 * This package is published, so removing or renaming an export is a breaking
 * change for somebody. During a refactor that is easy to do by accident — a
 * symbol moves between modules, the barrel file is updated by hand, and one
 * name silently disappears. Nothing else in the suite would notice: every unit
 * test imports from the module that defines a symbol, never from the barrel.
 *
 * So the surface is written out in full below. Any addition, removal or rename
 * fails here and has to be made deliberately, in a diff a human reads.
 *
 * Two halves, because they fail in different ways:
 *
 *   - `RUNTIME_EXPORTS` catches value exports, at test time.
 *   - `PublicTypes` catches type-only exports, at `tsc --noEmit` time — a
 *     deleted type cannot be detected at runtime, since it does not exist there.
 */

import { describe, expect, it } from "vitest";

import * as api from "./index.js";

/**
 * Every value the package exports, sorted.
 *
 * Adding an export? Add it here. Removing one? Removing it here is you
 * confirming the break is intended.
 */
const RUNTIME_EXPORTS = [
  "AXS_DECODERS",
  "AXS_MESSAGES",
  "AXS_MODELS",
  "AXS_USAGE_RECORD_OFFSETS",
  "AxsProbe",
  "BATTERY_LEVEL_CHARACTERISTIC",
  "BATTERY_SERVICE",
  "ByteChangeTracker",
  "DEFAULT_DECODERS",
  "DEFAULT_RECONNECT_POLICY",
  "DEVICE_INFORMATION_SERVICE",
  "DIS_CHARACTERISTICS",
  "DecoderRegistry",
  "DeviceSession",
  "Emitter",
  "FakeTransport",
  "GearWatcher",
  "LIVE_STATE_CHARACTERISTIC",
  "LiveStateWatcher",
  "SIMULATOR_DEVICE_KEY",
  "SRAMBOND_FINALIZE",
  "SRAMBOND_GENERATOR",
  "SRAMBOND_INIT",
  "SRAMBOND_MODULUS",
  "SRAMBOND_NONCE_LENGTH",
  "SRAMBOND_TAG_LENGTH",
  "SRAMBOND_V1_CHARACTERISTIC",
  "SRAMBOND_V1_SERVICE",
  "SRAM_COMPANY_ID",
  "SRAM_UUID_SUFFIX",
  "SessionRecorder",
  "StateAggregator",
  "analyzeBytes",
  "axsDeviceRecordDecoder",
  "axsMicroAdjustDecoder",
  "axsModelDecoder",
  "axsModelKind",
  "axsModelName",
  "axsSerialDecoder",
  "axsUsageRecordDecoder",
  "batteryLevelDecoder",
  "bigIntToBytes",
  "bytesEqual",
  "bytesToBigInt",
  "cmac",
  "computePublicKey",
  "computeSharedSecret",
  "createBond",
  "createSrambondDecoder",
  "decodeAxsFirmware",
  "decodeDrivetrainConfig",
  "decodeDrivetrainStatus",
  "decodeMicroAdjust",
  "decodeSrambondState",
  "decodeUsageRecord",
  "decryptLiveStateFrame",
  "decryptTransportedKey",
  "defineMessage",
  "describeUuid",
  "deserializeFrame",
  "disStringDecoder",
  "drivetrainConfigMessage",
  "drivetrainStatusMessage",
  "eaxDecrypt",
  "eaxEncrypt",
  "flattenProtobuf",
  "formatProtobuf",
  "fromBase64",
  "fromHex",
  "heuristicDecoder",
  "hexDump",
  "identifyDevice",
  "integerCandidates",
  "isInterestingUuid",
  "loadSession",
  "looksLikeProtobuf",
  "modPow",
  "nextBackoffDelay",
  "normalizeUuid",
  "parseManufacturerData",
  "parseProtobuf",
  "protobufDecoder",
  "publicKey",
  "replaySession",
  "routeMessage",
  "serializeFrame",
  "shannonEntropy",
  "sharedSecret",
  "shortUuid",
  "simulatedDerailleur",
  "sramManufacturerData",
  "summarizeScanResult",
  "toBase64",
  "toHex",
  "toPrintableAscii",
  "toUtf8",
  "u16be",
  "u16le",
  "u24le",
  "u32be",
  "u32le",
  "unmappedMessage",
  "uuidEquals",
  "vendorCharacteristicDecoder",
  "watchLiveState",
] as const;

/**
 * Every type the package exports.
 *
 * This is not run — it is checked. `tsc --noEmit` covers `src`, so deleting or
 * renaming any exported type breaks the build here, which is the only way to
 * catch it: types leave no trace at runtime for a test to inspect.
 */
export type PublicTypes = {
  AnnotatedFrame: api.AnnotatedFrame;
  AnyMessageProfile: api.AnyMessageProfile;
  AxsDeviceKind: api.AxsDeviceKind;
  AxsDeviceState: api.AxsDeviceState;
  AxsFirmwareVersion: api.AxsFirmwareVersion;
  AxsMicroAdjust: api.AxsMicroAdjust;
  AxsModelInfo: api.AxsModelInfo;
  AxsUsageRecord: api.AxsUsageRecord;
  BleTransport: api.BleTransport;
  ByteAnalysis: api.ByteAnalysis;
  ByteOrder: api.ByteOrder;
  ByteStats: api.ByteStats;
  CharacteristicProperties: api.CharacteristicProperties;
  ConnectedPeripheral: api.ConnectedPeripheral;
  CreateBondOptions: api.CreateBondOptions;
  DecodedResult: api.DecodedResult;
  Decoder: api.Decoder;
  DhGroup: api.DhGroup;
  DiscoveredDevice: api.DiscoveredDevice;
  DrivetrainConfig: api.DrivetrainConfig;
  DrivetrainStatus: api.DrivetrainStatus;
  EaxOptions: api.EaxOptions;
  Evidence: api.Evidence;
  FakeCharacteristicSpec: api.FakeCharacteristicSpec;
  FakeDeviceSpec: api.FakeDeviceSpec;
  FakeServiceSpec: api.FakeServiceSpec;
  FrameSource: api.FrameSource;
  GattCharacteristic: api.GattCharacteristic;
  GattService: api.GattService;
  GearReading: api.GearReading;
  GearWatcherOptions: api.GearWatcherOptions;
  GearWatcherStatus: api.GearWatcherStatus;
  Identification: api.Identification;
  IntegerCandidate: api.IntegerCandidate;
  Listener: api.Listener<number>;
  LiveReading: api.LiveReading<{ a: 1 }>;
  LiveStateStatus: api.LiveStateStatus;
  LiveStateWatcherEvents: api.LiveStateWatcherEvents<{ a: 1 }>;
  LiveStateWatcherOptions: api.LiveStateWatcherOptions<{ a: 1 }>;
  LogEntry: api.LogEntry;
  LogLevel: api.LogLevel;
  ManufacturerData: api.ManufacturerData;
  MessageProfile: api.MessageProfile<number>;
  ProbeOptions: api.ProbeOptions;
  ProtobufField: api.ProtobufField;
  ProtobufMessage: api.ProtobufMessage;
  RawFrame: api.RawFrame;
  ReconnectPolicy: api.ReconnectPolicy;
  RoutedMessage: api.RoutedMessage;
  ScanResult: api.ScanResult;
  SerializedFrame: api.SerializedFrame;
  SessionDocument: api.SessionDocument;
  TransportUnsubscribe: api.TransportUnsubscribe;
  Unsubscribe: api.Unsubscribe;
  UuidCategory: api.UuidCategory;
  UuidInfo: api.UuidInfo;
  ValueSource: api.ValueSource<number>;
  WatchLiveStateOptions: api.WatchLiveStateOptions;
  WireType: api.WireType;
};

describe("public API surface", () => {
  it("exports exactly the documented set of values", () => {
    expect(Object.keys(api).sort()).toEqual([...RUNTIME_EXPORTS]);
  });

  it("resolves the entry point the published package advertises", () => {
    // The same two shapes CI smoke-tests against the built bundle. Checking a
    // class and a plain function catches the common packaging failure where
    // only one export kind survives bundling.
    expect(typeof api.AxsProbe).toBe("function");
    expect(typeof api.decodeDrivetrainStatus).toBe("function");
  });
});

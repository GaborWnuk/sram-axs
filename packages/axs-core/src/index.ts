/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * @gaborwnuk/axs-core — reconnaissance and decoding for SRAM AXS components.
 *
 * See README.md for the workflow. Short version:
 *
 * ```ts
 * const probe = new AxsProbe(transport);
 * await probe.startScan();
 * const session = await probe.probe(deviceId);   // read-only enumeration
 * const recorder = new SessionRecorder(session);
 * recorder.start();
 * ```
 */

// Byte primitives
export {
  fromBase64,
  toBase64,
  toHex,
  fromHex,
  toPrintableAscii,
  toUtf8,
  u16le,
  u16be,
  u24le,
  u32le,
  u32be,
  bytesEqual,
  hexDump,
} from "./bytes.js";

// Transport contract
export type {
  BleTransport,
  ConnectedPeripheral,
  GattService,
  GattCharacteristic,
  CharacteristicProperties,
  ScanResult,
  Unsubscribe as TransportUnsubscribe,
} from "./transport.js";

// Frames and decoding
export type {
  RawFrame,
  AnnotatedFrame,
  DecodedResult,
  Decoder,
  FrameSource,
} from "./frame.js";

export {
  DecoderRegistry,
  DEFAULT_DECODERS,
  disStringDecoder,
  batteryLevelDecoder,
  protobufDecoder,
  vendorCharacteristicDecoder,
  heuristicDecoder,
} from "./decode/registry.js";

export {
  AXS_DECODERS,
  AXS_MODELS,
  axsModelName,
  axsModelKind,
  axsSerialDecoder,
  axsModelDecoder,
  axsDeviceRecordDecoder,
  axsMicroAdjustDecoder,
  axsUsageRecordDecoder,
  AXS_USAGE_RECORD_OFFSETS,
  decodeUsageRecord,
  decodeAxsFirmware,
  decodeMicroAdjust,
} from "./axs/device-info.js";
export type {
  AxsFirmwareVersion,
  AxsMicroAdjust,
  AxsModelInfo,
  AxsUsageRecord,
} from "./axs/device-info.js";

// AXS drivetrain live state (decrypted) + SRAMBond decryption
export { decodeDrivetrainStatus, decodeDrivetrainConfig } from "./axs/drivetrain.js";
export type { DrivetrainStatus, DrivetrainConfig } from "./axs/drivetrain.js";
export {
  createSrambondDecoder,
  decodeSrambondState,
  decryptLiveStateFrame,
  LIVE_STATE_CHARACTERISTIC,
  SRAMBOND_NONCE_LENGTH,
  SRAMBOND_TAG_LENGTH,
} from "./axs/srambond.js";

// Self-healing live gear reading (auto-reconnect)
export { GearWatcher, watchLiveState } from "./axs/gear-watcher.js";
export type {
  GearWatcherOptions,
  GearWatcherStatus,
  GearReading,
  WatchLiveStateOptions,
} from "./axs/gear-watcher.js";
export {
  DEFAULT_RECONNECT_POLICY,
  nextBackoffDelay,
} from "./reconnect.js";
export type { ReconnectPolicy } from "./reconnect.js";

// SRAMBond offline create-bond (self-pairing over BLE, no cloud)
export {
  createBond,
  computePublicKey,
  computeSharedSecret,
  decryptTransportedKey,
  SRAMBOND_V1_SERVICE,
  SRAMBOND_V1_CHARACTERISTIC,
  SRAMBOND_MODULUS,
  SRAMBOND_GENERATOR,
  SRAMBOND_INIT,
  SRAMBOND_FINALIZE,
} from "./axs/srambond-bond.js";
export type { CreateBondOptions } from "./axs/srambond-bond.js";

// Crypto primitives (pure TS, Hermes-safe)
export { eaxEncrypt, eaxDecrypt, cmac } from "./crypto/aes-eax.js";
export type { EaxOptions } from "./crypto/aes-eax.js";
export { modPow, publicKey, sharedSecret, bytesToBigInt, bigIntToBytes } from "./crypto/dh.js";
export type { DhGroup, ByteOrder } from "./crypto/dh.js";

export {
  parseProtobuf,
  looksLikeProtobuf,
  formatProtobuf,
  flattenProtobuf,
} from "./decode/protobuf.js";
export type { ProtobufField, ProtobufMessage, WireType } from "./decode/protobuf.js";

export {
  analyzeBytes,
  integerCandidates,
  shannonEntropy,
  ByteChangeTracker,
} from "./decode/heuristics.js";
export type { ByteAnalysis, ByteStats, IntegerCandidate } from "./decode/heuristics.js";

// GATT knowledge base
export {
  normalizeUuid,
  shortUuid,
  uuidEquals,
  describeUuid,
  isInterestingUuid,
  DEVICE_INFORMATION_SERVICE,
  BATTERY_SERVICE,
  BATTERY_LEVEL_CHARACTERISTIC,
  DIS_CHARACTERISTICS,
  SRAM_UUID_SUFFIX,
} from "./gatt/uuids.js";
export type { UuidInfo, UuidCategory } from "./gatt/uuids.js";

// Identification
export {
  SRAM_COMPANY_ID,
  parseManufacturerData,
  identifyDevice,
  summarizeScanResult,
} from "./identify.js";
export type {
  AxsDeviceKind,
  Evidence,
  Identification,
  ManufacturerData,
} from "./identify.js";

// Probe
export { AxsProbe, DeviceSession } from "./probe.js";
export type { DiscoveredDevice, ProbeOptions, LogEntry, LogLevel } from "./probe.js";

// Recording
export {
  SessionRecorder,
  loadSession,
  replaySession,
  serializeFrame,
  deserializeFrame,
} from "./recorder.js";
export type { SessionDocument, SerializedFrame } from "./recorder.js";

// State aggregation
export { StateAggregator } from "./state.js";
export type { AxsDeviceState, ValueSource } from "./state.js";

// Utilities
export { Emitter } from "./emitter.js";
export type { Listener, Unsubscribe } from "./emitter.js";

// Testing / simulator support
export {
  FakeTransport,
  simulatedDerailleur,
  sramManufacturerData,
  SIMULATOR_DEVICE_KEY,
} from "./testing/fake-transport.js";
export type { FakeDeviceSpec, FakeServiceSpec, FakeCharacteristicSpec } from "./testing/fake-transport.js";

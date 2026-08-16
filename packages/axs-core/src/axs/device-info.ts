/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * Confirmed AXS vendor decoders.
 *
 * Everything here was verified on a real SRAM GX Eagle Transmission
 * (`RD-GX-E-B1`, firmware 2.55.6) by capturing the raw GATT
 * reads and cross-checking each value against what the official SRAM AXS app
 * displayed for the same component at the same moment.
 *
 * That cross-check is what separates these from the speculative decoders: each
 * one has an independent ground truth, so they carry high confidence.
 */

import { toPrintableAscii, u16le, u32le } from "../bytes.js";
import { normalizeUuid } from "../gatt/uuids.js";
import { parseProtobuf } from "../decode/protobuf.js";
import type { Decoder, DecodedResult, RawFrame } from "../frame.js";
import type { AxsDeviceKind } from "../identify.js";

const SERIAL_CHARACTERISTIC = normalizeUuid("d905fe54-90aa-4c7c-b036-1e01fb8eb7ee");
const MODEL_CHARACTERISTIC = normalizeUuid("d905fe56-90aa-4c7c-b036-1e01fb8eb7ee");
const DEVICE_RECORD_CHARACTERISTIC = normalizeUuid("d905fe58-90aa-4c7c-b036-1e01fb8eb7ee");
const MICROADJUST_CHARACTERISTIC = normalizeUuid("d905000a-90aa-4c7c-b036-1e01fb8eb7ee");

/** What a model identifier says the component is. */
export interface AxsModelInfo {
  /** SRAM model code, or the product name where no code is known. */
  name: string;
  /** Component family. */
  kind: AxsDeviceKind;
  /**
   * True when this mapping has been confirmed against physical hardware.
   *
   * `false` means the identifier is documented by the AXS platform itself but
   * has not been seen on a bench here, so treat the name as indicative. The
   * protocol is shared across the AXS range, so an unverified component is
   * expected to work — it just has not been proven.
   */
  verified: boolean;
}

/**
 * Product identifiers read from `d905fe56` (little-endian uint16).
 *
 * SRAM AXS is one platform with one BLE protocol, so this library is not tied to
 * any single component. This table exists to put a human-readable name on
 * whatever you connect to; an unknown identifier is not an error, and every
 * decoder in this package works from the protocol, not from the model.
 */
export const AXS_MODELS: Record<number, AxsModelInfo> = {
  7: { name: "Quarq DZero power meter", kind: "power-meter", verified: false },
  1000: { name: "Rear derailleur (eTap AXS)", kind: "rear-derailleur", verified: false },
  1002: { name: "Front derailleur (eTap AXS)", kind: "front-derailleur", verified: false },
  1004: { name: "Drop-bar shifter, right", kind: "shifter-pod", verified: false },
  1005: { name: "Drop-bar shifter, left", kind: "shifter-pod", verified: false },
  1015: { name: "AXS Controller, right", kind: "shifter-pod", verified: false },
  1016: { name: "AXS Controller", kind: "shifter-pod", verified: true },
  1018: { name: "Reverb AXS seatpost", kind: "dropper-post", verified: false },
  1038: { name: "Flight Attendant fork", kind: "suspension", verified: false },
  1039: { name: "Flight Attendant rear shock", kind: "suspension", verified: false },
  1044: { name: "AXS Controller, left", kind: "shifter-pod", verified: false },
  1052: { name: "Quarq DUB spindle power meter", kind: "power-meter", verified: false },
  1075: { name: "RD-GX-E-B1", kind: "rear-derailleur", verified: true },
  1119: { name: "TyreWiz 2", kind: "tire-pressure", verified: false },
};

/** Model identifier to model name, or null when the identifier is unknown. */
export function axsModelName(modelId: number): string | null {
  return AXS_MODELS[modelId]?.name ?? null;
}

/** Model identifier to component family, or `"unknown"`. */
export function axsModelKind(modelId: number): AxsDeviceKind {
  return AXS_MODELS[modelId]?.kind ?? "unknown";
}

/**
 * Device serial number.
 *
 * CONFIRMED: little-endian uint32. Independently corroborated three ways — the
 * AXS app's "Serial: 1234567890", the advertised local name `SRAM 1234567890`,
 * and a protobuf copy in `d905fff2` field 25.22.
 */
export const axsSerialDecoder: Decoder = {
  name: "axs/serial",
  decode(frame: RawFrame): DecodedResult | null {
    if (!frame.characteristicUuid) return null;
    if (normalizeUuid(frame.characteristicUuid) !== SERIAL_CHARACTERISTIC) return null;
    if (frame.data.length !== 4) return null;

    const serial = u32le(frame.data, 0);
    return {
      decoder: this.name,
      confidence: 0.97,
      summary: `Serial: ${serial}`,
      fields: { serialNumber: String(serial), axsSerial: serial },
    };
  },
};

/**
 * Product / model identifier.
 *
 * CONFIRMED: little-endian uint16. `1075` was read from a component the AXS app
 * simultaneously reported as `RD-GX-E-B1`.
 */
export const axsModelDecoder: Decoder = {
  name: "axs/model",
  decode(frame: RawFrame): DecodedResult | null {
    if (!frame.characteristicUuid) return null;
    if (normalizeUuid(frame.characteristicUuid) !== MODEL_CHARACTERISTIC) return null;
    if (frame.data.length !== 2) return null;

    const modelId = u16le(frame.data, 0);
    const name = axsModelName(modelId);

    return {
      decoder: this.name,
      // Certain about the integer; the id -> name table is only as complete as
      // the components seen so far, so an unmapped id is scored lower.
      confidence: name ? 0.95 : 0.6,
      summary: name ? `Model: ${name} (id ${modelId})` : `Model id: ${modelId} (unmapped)`,
      fields: name
        ? { modelNumber: name, axsModelId: modelId }
        : { axsModelId: modelId },
    };
  },
};

/** Firmware version as reported by the device record. */
export interface AxsFirmwareVersion {
  major: number;
  minor: number;
  patch: number;
  /** Rendered as SRAM displays it, e.g. "2.55.6". */
  text: string;
}

/**
 * Decode the firmware triplet stored at offset 5 of `d905fe58`.
 *
 * CONFIRMED: bytes `06 37 02` on a component the AXS app reported as firmware
 * `2.55.6`. Note the ordering — patch, minor, major — which is the reverse of
 * how it is displayed.
 */
export function decodeAxsFirmware(record: Uint8Array, offset = 5): AxsFirmwareVersion | null {
  if (record.length < offset + 3) return null;

  const patch = record[offset] as number;
  const minor = record[offset + 1] as number;
  const major = record[offset + 2] as number;

  return { major, minor, patch, text: `${major}.${minor}.${patch}` };
}

/**
 * Device record: firmware version plus an ASCII build identifier.
 *
 * The tail of `d905fe58` carries a git-describe style string such as
 * `g313caa0ed6.dir` — the firmware build commit, with `.dir` marking a dirty
 * tree at build time.
 */
export const axsDeviceRecordDecoder: Decoder = {
  name: "axs/device-record",
  decode(frame: RawFrame): DecodedResult | null {
    if (!frame.characteristicUuid) return null;
    if (normalizeUuid(frame.characteristicUuid) !== DEVICE_RECORD_CHARACTERISTIC) return null;

    const firmware = decodeAxsFirmware(frame.data);
    if (!firmware) return null;

    // Recover the trailing printable run, which holds the build identifier.
    const printable = toPrintableAscii(frame.data, "\0");
    const buildMatch = /[ -~]{6,}/.exec(printable);
    const buildId = buildMatch ? buildMatch[0].replace(/\0+$/, "") : null;

    const fields: Record<string, unknown> = {
      firmwareRevision: firmware.text,
      axsFirmwareMajor: firmware.major,
      axsFirmwareMinor: firmware.minor,
      axsFirmwarePatch: firmware.patch,
    };
    if (buildId) fields.axsBuildId = buildId;

    return {
      decoder: this.name,
      confidence: 0.95,
      summary: `Firmware ${firmware.text}${buildId ? ` (build ${buildId})` : ""}`,
      fields,
    };
  },
};

/** MicroAdjust state, as shown on the app's "Micro Adjust Rear Derailleur" screen. */
export interface AxsMicroAdjust {
  min: number;
  current: number;
  max: number;
}

/**
 * MicroAdjust position from `d905000a`.
 *
 * CONFIRMED: protobuf varint fields 23/24/25 read `1 / 12 / 23` at the same
 * moment the AXS app's MicroAdjust screen displayed `1  12  23` for min,
 * current and max.
 *
 * Worth recording how this was nearly got wrong: field 24 reading `12` on a
 * 12-speed drivetrain looked exactly like a cassette cog count, and was
 * initially written down as one. The app screenshot disproved it. Coincidental
 * agreement is the main hazard in schema-less reversing — always corroborate.
 */
export function decodeMicroAdjust(payload: Uint8Array): AxsMicroAdjust | null {
  const message = parseProtobuf(payload);
  if (!message.complete) return null;

  const byField = new Map<number, bigint>();
  for (const field of message.fields) {
    if (field.wireType === 0 && field.value !== undefined) {
      byField.set(field.fieldNumber, field.value);
    }
  }

  const min = byField.get(23);
  const current = byField.get(24);
  const max = byField.get(25);
  if (min === undefined || current === undefined || max === undefined) return null;

  return { min: Number(min), current: Number(current), max: Number(max) };
}

export const axsMicroAdjustDecoder: Decoder = {
  name: "axs/microadjust",
  decode(frame: RawFrame): DecodedResult | null {
    if (!frame.characteristicUuid) return null;
    if (normalizeUuid(frame.characteristicUuid) !== MICROADJUST_CHARACTERISTIC) return null;

    const adjust = decodeMicroAdjust(frame.data);
    if (!adjust) return null;

    return {
      decoder: this.name,
      confidence: 0.92,
      summary: `MicroAdjust ${adjust.current} (range ${adjust.min}–${adjust.max})`,
      fields: {
        microAdjustCurrent: adjust.current,
        microAdjustMin: adjust.min,
        microAdjustMax: adjust.max,
      },
    };
  },
};


// --- Live state characteristic (d9050003) ----------------------------------
//
// Bench finding, 2026-08-02: of 29 readable characteristics on a GX Eagle
// Transmission, `d9050003` (54 bytes) is the *only* one whose contents change
// during use. Exactly four byte offsets vary; the other 50 are static.
//
// Established by polling at 1 Hz through a full 1→12→1 cassette sweep:
//
//   offset 50  shift counter   advanced exactly +22 across 22 shifts
//   offset 14  shift-linked    0 changes at rest, 16 during a sweep — NOT gear
//   offset 46  uptime          16-bit LE at 46..47, increments ~1/second
//   offset 38  unknown sensor  varies constantly, including at rest
//
// Note what is NOT here: a gear ordinal. No offset carries a 1..12 index.

const USAGE_RECORD_CHARACTERISTIC = normalizeUuid("d9050003-90aa-4c7c-b036-1e01fb8eb7ee");

/** Byte offsets within the `d9050003` live-state record. */
export const AXS_USAGE_RECORD_OFFSETS = {
  /** Shift-linked analog value. Not a gear index — see `decodeUsageRecord`. */
  shiftLinked: 14,
  /** Continuously varying; unidentified. */
  unknownSensor: 38,
  /** Uptime counter, 16-bit little-endian at 46..47, ~1 Hz. */
  uptime: 46,
  /** Cumulative shift counter (low byte). */
  shiftCount: 50,
} as const;

export interface AxsUsageRecord {
  /**
   * Cumulative shift count, low byte.
   *
   * CONFIRMED TWICE: advanced by exactly 22 over a 1→12→1 sweep (11 shifts each
   * way), on two independent runs — 171→193 and 193→215. Wraps at 256, so track
   * deltas rather than absolute values.
   */
  shiftCount: number;
  /**
   * A value that moves only while shifting and is rock-stable at rest.
   *
   * **Definitively NOT a gear number.** A 12-gear park-and-hold calibration
   * (8 s settled per gear, segmented by the shift counter) falsified it twice
   * over:
   *
   *   - Not monotonic. Gears 1..12 read 63 65 65 67 69 69 71 70 67 67 67 67 —
   *     it rises to a peak around gear 7 and comes back down. A derailleur
   *     position across a cassette cannot do that.
   *   - Not reproducible. The same gear reads differently in different
   *     sessions: gear 1 gave 83 then 63; gear 11 gave 57 then 67. The two
   *     series cross over entirely.
   *
   * An earlier static snapshot (gear 1 = 83 vs gear 11 = 57) looked like clean
   * evidence of a position value. It was a confound: the gear-1 sample was
   * taken after ~70 s idle and the gear-11 sample straight after two minutes of
   * heavy shifting, so recent motor activity — not gear — explained the gap.
   *
   * Best remaining guess is a thermal or supply-voltage reading: responds to
   * motor work, settles to equilibrium at rest, carries no absolute position.
   * Exposed raw, deliberately not dressed up as a gear.
   */
  shiftLinkedValue: number;
  /** Uptime counter, 16-bit little-endian, roughly 1 Hz. */
  uptime: number;
  /** Unidentified, varies continuously even at rest. */
  unknownSensor: number;
}

export function decodeUsageRecord(payload: Uint8Array): AxsUsageRecord | null {
  if (payload.length < 54) return null;

  return {
    shiftCount: payload[AXS_USAGE_RECORD_OFFSETS.shiftCount] as number,
    shiftLinkedValue: payload[AXS_USAGE_RECORD_OFFSETS.shiftLinked] as number,
    uptime: u16le(payload, AXS_USAGE_RECORD_OFFSETS.uptime),
    unknownSensor: payload[AXS_USAGE_RECORD_OFFSETS.unknownSensor] as number,
  };
}

export const axsUsageRecordDecoder: Decoder = {
  name: "axs/live-state",
  decode(frame: RawFrame): DecodedResult | null {
    if (!frame.characteristicUuid) return null;
    if (normalizeUuid(frame.characteristicUuid) !== USAGE_RECORD_CHARACTERISTIC) return null;

    const state = decodeUsageRecord(frame.data);
    if (!state) return null;

    return {
      decoder: this.name,
      // The shift counter is solid; the rest of the record is unmapped, so this
      // sits below the fully-corroborated decoders.
      confidence: 0.85,
      summary: `shifts ${state.shiftCount} · shift-linked ${state.shiftLinkedValue} · uptime ${state.uptime}`,
      fields: {
        axsShiftCount: state.shiftCount,
        axsShiftLinkedValue: state.shiftLinkedValue,
        axsUptime: state.uptime,
        axsUnknownSensor: state.unknownSensor,
      },
    };
  },
};

/** All confirmed AXS vendor decoders. */
export const AXS_DECODERS: Decoder[] = [
  axsSerialDecoder,
  axsModelDecoder,
  axsDeviceRecordDecoder,
  axsMicroAdjustDecoder,
  axsUsageRecordDecoder,
];

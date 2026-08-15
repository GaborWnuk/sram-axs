/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * Aggregated component state.
 *
 * Frames arrive piecemeal — a firmware string here, a battery level there, a
 * gear index four seconds later. This folds them into one object the UI can
 * render, and records *where each value came from* so a dashboard can show a
 * confirmed reading differently from a speculative one.
 */

import { Emitter } from "./emitter.js";
import type { DecodedResult, RawFrame } from "./frame.js";
import type { DecoderRegistry } from "./decode/registry.js";

/** Provenance of a single state value. */
export interface ValueSource<T> {
  value: T;
  /** Decoder that produced it. */
  decoder: string;
  /** 0..1, carried through from the decoder. */
  confidence: number;
  /** When it was last updated, ms since epoch. */
  updatedAt: number;
}

export interface AxsDeviceState {
  deviceId: string;
  deviceName: string | null;

  manufacturerName: ValueSource<string> | null;
  modelNumber: ValueSource<string> | null;
  serialNumber: ValueSource<string> | null;
  hardwareRevision: ValueSource<string> | null;
  firmwareRevision: ValueSource<string> | null;
  softwareRevision: ValueSource<string> | null;

  /** Standard BLE battery service percentage. */
  batteryPercent: ValueSource<number> | null;
  /** Battery volts, when a decoder reports one. */
  batteryVolts: ValueSource<number> | null;

  /** Current rear gear index. Null until something decodes one. */
  gearRear: ValueSource<number> | null;
  gearFront: ValueSource<number> | null;
  totalRear: ValueSource<number> | null;
  totalFront: ValueSource<number> | null;

  /** Cumulative shift count: gear transitions plus the component's own counter. */
  shiftCount: number;

  /** Total frames folded into this state. */
  frameCount: number;
  lastUpdateAt: number | null;
}

function emptyState(deviceId: string, deviceName: string | null): AxsDeviceState {
  return {
    deviceId,
    deviceName,
    manufacturerName: null,
    modelNumber: null,
    serialNumber: null,
    hardwareRevision: null,
    firmwareRevision: null,
    softwareRevision: null,
    batteryPercent: null,
    batteryVolts: null,
    gearRear: null,
    gearFront: null,
    totalRear: null,
    totalFront: null,
    shiftCount: 0,
    frameCount: 0,
    lastUpdateAt: null,
  };
}

interface StateEvents extends Record<string, unknown> {
  change: AxsDeviceState;
  shift: { from: number | null; to: number | null; totalShifts: number };
}

/** String state keys that map directly from a decoded field of the same name. */
const STRING_FIELDS = [
  "manufacturerName",
  "modelNumber",
  "serialNumber",
  "hardwareRevision",
  "firmwareRevision",
  "softwareRevision",
] as const;

/**
 * Folds decoded frames into an {@link AxsDeviceState}.
 *
 * A value is only overwritten by a decoding of equal or higher confidence, so a
 * speculative heuristic reading can never clobber a confirmed GATT string.
 */
export class StateAggregator {
  readonly events = new Emitter<StateEvents>();

  private state: AxsDeviceState;
  private lastShiftCounter: number | null = null;

  constructor(
    deviceId: string,
    deviceName: string | null,
    private readonly registry: DecoderRegistry,
  ) {
    this.state = emptyState(deviceId, deviceName);
  }

  current(): AxsDeviceState {
    return this.state;
  }

  reset(): void {
    this.state = emptyState(this.state.deviceId, this.state.deviceName);
    this.lastShiftCounter = null;
    this.events.emit("change", this.state);
  }

  /** Only accept a value when it is at least as trustworthy as the one held. */
  private shouldReplace<T>(existing: ValueSource<T> | null, confidence: number): boolean {
    return existing === null || confidence >= existing.confidence;
  }

  /**
   * Store a value, returning whether it represents a *semantic* change.
   *
   * Re-storing an identical value refreshes provenance (so staleness checks
   * stay accurate) but reports no change. Without this, a 4 Hz rebroadcast of
   * an unchanged gear would emit a change event four times a second and force
   * the UI to re-render continuously.
   */
  private set<K extends keyof AxsDeviceState>(
    key: K,
    value: AxsDeviceState[K] extends ValueSource<infer T> | null ? T : never,
    decoding: DecodedResult,
    now: number,
  ): boolean {
    const existing = this.state[key] as ValueSource<unknown> | null;
    if (!this.shouldReplace(existing, decoding.confidence)) return false;

    const isSameValue = existing !== null && existing.value === value;

    (this.state[key] as unknown) = {
      value,
      decoder: decoding.decoder,
      confidence: decoding.confidence,
      updatedAt: now,
    } satisfies ValueSource<unknown>;

    return !isSameValue;
  }

  /** Fold one frame in. Decodes it if decodings are not supplied. */
  ingest(frame: RawFrame, decodings?: DecodedResult[]): AxsDeviceState {
    const results = decodings ?? this.registry.decode(frame);
    const now = frame.timestamp;
    let changed = false;

    this.state.frameCount++;

    for (const decoding of results) {
      const fields = decoding.fields;

      for (const key of STRING_FIELDS) {
        const value = fields[key];
        if (typeof value === "string" && this.set(key, value, decoding, now)) changed = true;
      }

      if (typeof fields.batteryPercent === "number") {
        if (this.set("batteryPercent", fields.batteryPercent, decoding, now)) changed = true;
      }
      if (typeof fields.voltage === "number") {
        if (this.set("batteryVolts", fields.voltage, decoding, now)) changed = true;
      }

      if (typeof fields.totalRear === "number") {
        if (this.set("totalRear", fields.totalRear, decoding, now)) changed = true;
      }
      if (typeof fields.totalFront === "number") {
        if (this.set("totalFront", fields.totalFront, decoding, now)) changed = true;
      }

      // Gear. A shift is reported when the decrypted drivetrain_status shows a
      // different rear position than the one held; re-reads of an unchanged
      // frame must not register as a shift.
      if ("gearRear" in fields) {
        const previous = this.state.gearRear?.value ?? null;
        const gear = fields.gearRear;

        if (typeof gear === "number" && this.set("gearRear", gear, decoding, now)) {
          changed = true;
          if (previous !== null && previous !== gear) {
            this.state.shiftCount += 1;
            this.events.emit("shift", {
              from: previous,
              to: gear,
              totalShifts: this.state.shiftCount,
            });
          }
        }
      }

      // The component also keeps its own cumulative shift counter in the
      // plaintext usage record (`d9050003`). When present it is authoritative —
      // it counts shifts made while disconnected, and survives gaps in
      // polling that gear-change detection alone would miss. It wraps at 256.
      if (typeof fields.axsShiftCount === "number") {
        const counter = fields.axsShiftCount;
        if (this.lastShiftCounter !== null && counter !== this.lastShiftCounter) {
          const delta = (counter - this.lastShiftCounter + 256) % 256;
          this.state.shiftCount += delta;
          this.events.emit("shift", {
            from: this.state.gearRear?.value ?? null,
            to: this.state.gearRear?.value ?? null,
            totalShifts: this.state.shiftCount,
          });
          changed = true;
        }
        this.lastShiftCounter = counter;
      }

      if (typeof fields.gearFront === "number") {
        if (this.set("gearFront", fields.gearFront, decoding, now)) changed = true;
      }
    }

    // Always advance the heartbeat — "when was the device last heard from"
    // is a different question from "when did a value last change", and a
    // staleness indicator needs the former.
    this.state.lastUpdateAt = now;

    if (changed) this.events.emit("change", this.state);

    return this.state;
  }
}

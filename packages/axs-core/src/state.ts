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
 *
 * The shape has two halves, and the split is the point. Identity, firmware and
 * battery are flat, because every AXS component has them. Everything
 * component-specific lives under `domains`, contributed by a
 * {@link DomainReducer}, and a domain is present only if the component actually
 * reports it — so a dropper post carries no empty drivetrain, and "what does
 * this component do" is a question the state can answer.
 *
 * This module knows nothing about gears. That knowledge is in
 * `axs/drivetrain-domain.ts`.
 */

import { drivetrainDomain, type DrivetrainDomain } from "./axs/drivetrain-domain.js";
import {
  type AnyDomainReducer,
  type DomainContext,
  type DomainEvents,
  type StoredValue,
  type ValueSource,
} from "./domain.js";
import { Emitter } from "./emitter.js";
import type { DecodedResult, RawFrame } from "./frame.js";
import type { DecoderRegistry } from "./decode/registry.js";

export type { ValueSource } from "./domain.js";

/**
 * Component-specific state, keyed by domain.
 *
 * Known domains are named so they type properly; the index signature keeps
 * reducers this build has never heard of readable. Adding a component family
 * adds one line here and a reducer module — no change to the aggregator.
 */
export interface AxsDomains {
  drivetrain?: DrivetrainDomain;
  [domain: string]: unknown;
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

  /** Component-specific state. Only domains this component reports appear. */
  domains: AxsDomains;

  /** Total frames folded into this state. */
  frameCount: number;
  lastUpdateAt: number | null;
}

/** The reducers enabled by default. */
export const DEFAULT_DOMAIN_REDUCERS: readonly AnyDomainReducer[] = [drivetrainDomain];

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
    domains: {},
    frameCount: 0,
    lastUpdateAt: null,
  };
}

interface StateEvents extends DomainEvents {
  change: AxsDeviceState;
}

/** Universal string values, mapped straight from a decoded field of the same name. */
const STRING_FIELDS = [
  "manufacturerName",
  "modelNumber",
  "serialNumber",
  "hardwareRevision",
  "firmwareRevision",
  "softwareRevision",
] as const;

/** Universal numeric values, and the decoded field each comes from. */
const NUMBER_FIELDS = [
  ["batteryPercent", "batteryPercent"],
  ["batteryVolts", "voltage"],
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

  constructor(
    deviceId: string,
    deviceName: string | null,
    private readonly registry: DecoderRegistry,
    private readonly reducers: readonly AnyDomainReducer[] = DEFAULT_DOMAIN_REDUCERS,
  ) {
    this.state = emptyState(deviceId, deviceName);
  }

  current(): AxsDeviceState {
    return this.state;
  }

  reset(): void {
    this.state = emptyState(this.state.deviceId, this.state.deviceName);
    this.events.emit("change", this.state);
  }

  /** Arbitrate a new value against the one held. Null when the held one wins. */
  private arbitrate<T>(
    existing: ValueSource<T> | null,
    value: T,
    decoding: DecodedResult,
    now: number,
  ): StoredValue<T> | null {
    if (existing !== null && decoding.confidence < existing.confidence) return null;

    return {
      value: {
        value,
        decoder: decoding.decoder,
        confidence: decoding.confidence,
        updatedAt: now,
      },
      changed: existing === null || existing.value !== value,
    };
  }

  /** Store a universal value, returning whether it semantically changed. */
  private set<K extends keyof AxsDeviceState>(
    key: K,
    value: AxsDeviceState[K] extends ValueSource<infer T> | null ? T : never,
    decoding: DecodedResult,
    now: number,
  ): boolean {
    const existing = this.state[key] as ValueSource<unknown> | null;
    const stored = this.arbitrate(existing, value, decoding, now);
    if (stored === null) return false;

    (this.state[key] as unknown) = stored.value;
    return stored.changed;
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

      for (const [key, field] of NUMBER_FIELDS) {
        const value = fields[field];
        if (typeof value === "number" && this.set(key, value, decoding, now)) changed = true;
      }

      if (this.runReducers(decoding, now)) changed = true;
    }

    // Always advance the heartbeat — "when was the device last heard from"
    // is a different question from "when did a value last change", and a
    // staleness indicator needs the former.
    this.state.lastUpdateAt = now;

    if (changed) this.events.emit("change", this.state);

    return this.state;
  }

  /** Offer one decoding to every reducer that cares about it. */
  private runReducers(decoding: DecodedResult, now: number): boolean {
    let changed = false;

    const context: DomainContext = {
      fields: decoding.fields,
      decoder: decoding.decoder,
      confidence: decoding.confidence,
      timestamp: now,
      store: (existing, value) => this.arbitrate(existing, value, decoding, now),
      number: (field) => {
        const value = decoding.fields[field];
        return typeof value === "number" ? value : undefined;
      },
      emit: (event, payload) => this.events.emit(event, payload),
    };

    for (const reducer of this.reducers) {
      // Skipping here is what keeps a domain absent until the component
      // actually reports one, rather than every device carrying every domain.
      if (!reducer.consumes.some((field) => field in decoding.fields)) continue;

      const existing = this.state.domains[reducer.domain] ?? reducer.create();
      this.state.domains[reducer.domain] = existing;

      if (reducer.ingest(existing, context)) changed = true;
    }

    return changed;
  }
}

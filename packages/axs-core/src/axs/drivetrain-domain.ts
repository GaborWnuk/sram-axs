/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * Drivetrain state: gear, cassette, trim, MicroAdjust and shift counting.
 *
 * This is where drivetrain knowledge lives now. `StateAggregator` folds
 * identity and battery — things every AXS component has — and hands anything
 * component-specific to a reducer like this one.
 */

import { defineDomain, type ValueSource } from "../domain.js";

export interface DrivetrainDomain {
  /** Current rear gear, from `rd_position`. */
  gearRear: ValueSource<number> | null;
  /** Front derailleur position. Absent on a 1x system. */
  gearFront: ValueSource<number> | null;
  /** Rear trim offset. */
  trimRear: ValueSource<number> | null;
  /** Number of rear cogs, from `drivetrain_config`. */
  totalRear: ValueSource<number> | null;
  /** Number of chainrings. */
  totalFront: ValueSource<number> | null;

  /** MicroAdjust position, as the AXS app's MicroAdjust screen shows it. */
  microAdjustCurrent: ValueSource<number> | null;
  microAdjustMin: ValueSource<number> | null;
  microAdjustMax: ValueSource<number> | null;

  /**
   * The component's own cumulative shift counter, from the plaintext usage
   * record. Wraps at 256, so it is the deltas that carry meaning.
   */
  deviceShiftCounter: ValueSource<number> | null;

  /**
   * Shifts observed: gear transitions seen live, plus the deltas from the
   * component's own counter, which covers shifts made while disconnected.
   */
  shiftCount: number;
}

/** Slots holding a plain number, which is all of them bar `shiftCount`. */
type NumericSlot = Exclude<keyof DrivetrainDomain, "shiftCount">;

export const drivetrainDomain = defineDomain<DrivetrainDomain>({
  domain: "drivetrain",

  consumes: [
    "gearRear",
    "gearFront",
    "trimRear",
    "totalRear",
    "totalFront",
    "microAdjustCurrent",
    "microAdjustMin",
    "microAdjustMax",
    "axsShiftCount",
  ],

  create: () => ({
    gearRear: null,
    gearFront: null,
    trimRear: null,
    totalRear: null,
    totalFront: null,
    microAdjustCurrent: null,
    microAdjustMin: null,
    microAdjustMax: null,
    deviceShiftCounter: null,
    shiftCount: 0,
  }),

  ingest(state, ctx) {
    let changed = false;

    /** Store a numeric field into a slot, if the decoding carried one. */
    const assign = (slot: NumericSlot, field: string): boolean => {
      const value = ctx.number(field);
      if (value === undefined) return false;

      const stored = ctx.store(state[slot], value);
      if (stored === null) return false;

      state[slot] = stored.value;
      return stored.changed;
    };

    for (const slot of [
      "gearFront",
      "trimRear",
      "totalRear",
      "totalFront",
      "microAdjustCurrent",
      "microAdjustMin",
      "microAdjustMax",
    ] as const) {
      if (assign(slot, slot)) changed = true;
    }

    // Gear, and the shift it implies. A shift is a *change* in rd_position;
    // re-reading an unchanged frame at 4 Hz must not register as shifting.
    const previousGear = state.gearRear?.value ?? null;
    if (assign("gearRear", "gearRear")) {
      changed = true;
      const gear = state.gearRear?.value ?? null;
      if (previousGear !== null && gear !== null && previousGear !== gear) {
        state.shiftCount += 1;
        ctx.emit("shift", { from: previousGear, to: gear, totalShifts: state.shiftCount });
      }
    }

    // The component keeps its own counter in the plaintext usage record. Where
    // present it is authoritative: it counts shifts made while disconnected and
    // survives gaps in polling that live gear-change detection cannot see.
    const counter = ctx.number("axsShiftCount");
    if (counter !== undefined) {
      const previous = state.deviceShiftCounter?.value ?? null;
      if (assign("deviceShiftCounter", "axsShiftCount")) changed = true;

      if (previous !== null && counter !== previous) {
        state.shiftCount += (counter - previous + 256) % 256;
        const gear = state.gearRear?.value ?? null;
        ctx.emit("shift", { from: gear, to: gear, totalShifts: state.shiftCount });
        changed = true;
      }
    }

    return changed;
  },
});

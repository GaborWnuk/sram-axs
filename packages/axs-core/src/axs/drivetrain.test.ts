/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

import { describe, expect, it } from "vitest";

import { decodeDrivetrainConfig, decodeDrivetrainStatus } from "./drivetrain.js";

/**
 * Build a protobuf uint32 field: tag = (fieldNumber << 3) | 0, then the varint.
 * Field numbers 20-25 are two-byte tags, which exercises the multi-byte tag path.
 */
function u32Field(fieldNumber: number, value: number): number[] {
  const out: number[] = [];
  let tag = fieldNumber << 3; // wire type 0
  do {
    let b = tag & 0x7f;
    tag >>>= 7;
    if (tag) b |= 0x80;
    out.push(b);
  } while (tag);
  let v = value;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}

describe("drivetrain_status decode", () => {
  it("reads rd_position (field 21) as the current rear gear", () => {
    const payload = Uint8Array.from([...u32Field(20, 0), ...u32Field(21, 7), ...u32Field(22, 2)]);
    const status = decodeDrivetrainStatus(payload);
    expect(status.gearRear).toBe(7);
    expect(status.gearFront).toBe(0);
    expect(status.trimRear).toBe(2);
  });

  it("handles a 1x payload with only rd_position present", () => {
    const payload = Uint8Array.from(u32Field(21, 11));
    const status = decodeDrivetrainStatus(payload);
    expect(status.gearRear).toBe(11);
    expect(status.gearFront).toBeUndefined();
  });

  it("reads every gear across a full sweep", () => {
    for (let gear = 1; gear <= 12; gear++) {
      const payload = Uint8Array.from(u32Field(21, gear));
      expect(decodeDrivetrainStatus(payload).gearRear).toBe(gear);
    }
  });

  it("returns an empty status for garbage rather than throwing", () => {
    expect(decodeDrivetrainStatus(Uint8Array.from([0xff, 0xff, 0xff]))).toEqual({});
  });
});

describe("drivetrain_config decode", () => {
  it("reads rd_num_gears (field 24) as the total rear gears", () => {
    const payload = Uint8Array.from([...u32Field(23, 2), ...u32Field(24, 12), ...u32Field(25, 5)]);
    const config = decodeDrivetrainConfig(payload);
    expect(config.totalRear).toBe(12);
    expect(config.totalFront).toBe(2);
    expect(config.trimCount).toBe(5);
  });
});

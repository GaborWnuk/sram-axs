/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * Decoders for the AXS drivetrain live-state and configuration messages.
 *
 * These operate on the **decrypted** payload of the live-state channel. The
 * channel itself is protected by the SRAMBond session (see `../crypto/`), so
 * these functions take plaintext bytes: the raw characteristic value only
 * becomes decodable once a session key is established and the AES-EAX layer is
 * peeled off.
 *
 * Field numbers were recovered from the message schema and confirmed against the
 * component:
 *
 *   drivetrain_status { 20 = fd_position, 21 = rd_position, 22 = rd_trim }
 *   drivetrain_config { 23 = fd_num_gears, 24 = rd_num_gears, 25 = rd_num_trim }
 *
 * `rd_position` is the current rear gear — the number the ride dashboard shows.
 * All fields are protobuf `uint32` varints (wire type 0).
 */

import { parseProtobuf } from "../decode/protobuf.js";

export interface DrivetrainStatus {
  /** Current rear gear (1..rd_num_gears), from `rd_position`. */
  gearRear?: number;
  /** Front derailleur position, from `fd_position`. Absent on a 1x system. */
  gearFront?: number;
  /** Rear trim offset, from `rd_trim`. */
  trimRear?: number;
}

export interface DrivetrainConfig {
  /** Number of rear gears (e.g. 12 on Eagle), from `rd_num_gears`. */
  totalRear?: number;
  /** Number of front gears, from `fd_num_gears`. */
  totalFront?: number;
  /** Number of rear trim steps, from `rd_num_trim`. */
  trimCount?: number;
}

/** Read a top-level `uint32` varint field by number, or undefined if absent. */
function readUint32Field(bytes: Uint8Array, fieldNumber: number): number | undefined {
  const message = parseProtobuf(bytes);
  const field = message.fields.find((f) => f.fieldNumber === fieldNumber && f.wireType === 0);
  if (field?.value === undefined) return undefined;
  return Number(field.value);
}

/** Decode a `drivetrain_status` payload. `gearRear` is the current gear. */
export function decodeDrivetrainStatus(plaintext: Uint8Array): DrivetrainStatus {
  const status: DrivetrainStatus = {};
  const fd = readUint32Field(plaintext, 20);
  const rd = readUint32Field(plaintext, 21);
  const trim = readUint32Field(plaintext, 22);
  if (fd !== undefined) status.gearFront = fd;
  if (rd !== undefined) status.gearRear = rd;
  if (trim !== undefined) status.trimRear = trim;
  return status;
}

/** Decode a `drivetrain_config` payload. `totalRear` renders the "x / 12". */
export function decodeDrivetrainConfig(plaintext: Uint8Array): DrivetrainConfig {
  const config: DrivetrainConfig = {};
  const fdNum = readUint32Field(plaintext, 23);
  const rdNum = readUint32Field(plaintext, 24);
  const trimNum = readUint32Field(plaintext, 25);
  if (fdNum !== undefined) config.totalFront = fdNum;
  if (rdNum !== undefined) config.totalRear = rdNum;
  if (trimNum !== undefined) config.trimCount = trimNum;
  return config;
}

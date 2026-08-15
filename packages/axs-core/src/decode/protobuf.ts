/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * A tolerant protobuf wire-format reader.
 *
 * ## Why this is here
 *
 * Bench capture from a real AXS component (`SRAM 1503603158`) showed that
 * several vendor characteristics carry **protobuf-encoded** payloads. Two
 * independent confirmations:
 *
 *   - `d905fe54` reads `d6 29 9f 59` — LE uint32 `1503603158`, exactly the
 *     number in the advertised device name `SRAM 1503603158`.
 *   - `d905fff2` reads `ca 01 0a b0 01 d6 d3 fc cc 05 b8 01 01`, which parses
 *     as protobuf field 25 (nested) containing field 22 = `1503603158` — the
 *     same serial, arrived at by a completely different route.
 *
 * A coincidence that survives two independent derivations is not a coincidence.
 *
 * ## Why hand-rolled rather than protobufjs
 *
 * There is no `.proto` schema, and never will be without SRAM publishing one. This
 * reader recovers *structure* — field numbers, wire types, nesting — from bytes
 * alone, which is exactly what schema-less reverse engineering needs. It is
 * also ~150 lines with no dependencies, keeping the package installable in a
 * React Native app without a bundler fight.
 *
 * Numbers are returned as `bigint` because protobuf varints are up to 64 bits
 * and silently losing precision in a debugging tool would be unforgivable.
 */

import { toHex } from "../bytes.js";

export type WireType = 0 | 1 | 2 | 5;

export interface ProtobufField {
  fieldNumber: number;
  wireType: WireType;
  /** Varint (0), fixed64 (1) and fixed32 (5) values. */
  value?: bigint;
  /** Raw bytes for length-delimited (wire type 2) fields. */
  bytes?: Uint8Array;
  /**
   * Sub-fields, when a length-delimited payload itself parses as valid
   * protobuf. Nested messages and byte strings are indistinguishable on the
   * wire, so this is a best-effort reading, not a certainty.
   */
  nested?: ProtobufField[];
  /** Printable interpretation of `bytes`, when it looks like text. */
  text?: string;
}

export interface ProtobufMessage {
  fields: ProtobufField[];
  /** True when the whole buffer was consumed as well-formed protobuf. */
  complete: boolean;
  /** Bytes left over after parsing stopped, if any. */
  trailingBytes: number;
}

/** Read a base-128 varint. Returns null when the buffer runs out mid-value. */
function readVarint(
  bytes: Uint8Array,
  start: number,
): { value: bigint; next: number } | null {
  let value = 0n;
  let shift = 0n;
  let i = start;

  while (i < bytes.length) {
    const byte = bytes[i] as number;
    value |= BigInt(byte & 0x7f) << shift;
    i++;

    if ((byte & 0x80) === 0) return { value, next: i };

    shift += 7n;
    // Protobuf varints are at most 10 bytes; beyond that the data is not a varint.
    if (shift > 63n) return null;
  }

  return null;
}

function isPrintable(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    if (b !== 0x09 && b !== 0x0a && b !== 0x0d && (b < 0x20 || b > 0x7e)) return false;
  }
  return true;
}

/**
 * Parse a protobuf message.
 *
 * Never throws. On malformed input it returns whatever it managed to read with
 * `complete: false` — partial structure is still useful when reversing.
 */
export function parseProtobuf(bytes: Uint8Array, depth = 0): ProtobufMessage {
  const fields: ProtobufField[] = [];
  let i = 0;

  while (i < bytes.length) {
    const key = readVarint(bytes, i);
    if (!key) break;

    const fieldNumber = Number(key.value >> 3n);
    const wireType = Number(key.value & 7n);

    // Field 0 is illegal, and wire types 3/4 (deprecated groups) and 6/7 are
    // not valid — any of these means this is not protobuf.
    if (fieldNumber === 0 || wireType === 3 || wireType === 4 || wireType > 5) break;

    i = key.next;

    if (wireType === 0) {
      const varint = readVarint(bytes, i);
      if (!varint) break;
      fields.push({ fieldNumber, wireType: 0, value: varint.value });
      i = varint.next;
      continue;
    }

    if (wireType === 5) {
      if (i + 4 > bytes.length) break;
      let value = 0n;
      for (let b = 3; b >= 0; b--) value = (value << 8n) | BigInt(bytes[i + b] as number);
      fields.push({ fieldNumber, wireType: 5, value });
      i += 4;
      continue;
    }

    if (wireType === 1) {
      if (i + 8 > bytes.length) break;
      let value = 0n;
      for (let b = 7; b >= 0; b--) value = (value << 8n) | BigInt(bytes[i + b] as number);
      fields.push({ fieldNumber, wireType: 1, value });
      i += 8;
      continue;
    }

    // wireType === 2, length-delimited
    const length = readVarint(bytes, i);
    if (!length) break;

    const size = Number(length.value);
    if (size < 0 || length.next + size > bytes.length) break;

    const payload = bytes.subarray(length.next, length.next + size);
    const field: ProtobufField = { fieldNumber, wireType: 2, bytes: payload };

    if (isPrintable(payload)) {
      let text = "";
      for (let k = 0; k < payload.length; k++) text += String.fromCharCode(payload[k] as number);
      field.text = text;
    } else if (payload.length > 0 && depth < 6) {
      // Only treat it as a nested message when it parses cleanly end to end;
      // a partial parse is far more likely to be an opaque byte string.
      const inner = parseProtobuf(payload, depth + 1);
      if (inner.complete && inner.fields.length > 0) field.nested = inner.fields;
    }

    fields.push(field);
    i = length.next + size;
  }

  return { fields, complete: i === bytes.length && fields.length > 0, trailingBytes: bytes.length - i };
}

/**
 * Whether a payload is plausibly protobuf.
 *
 * Deliberately strict: it must parse completely, carry at least one field, and
 * use sane field numbers. Loose criteria would flag half the random blobs on
 * the device, which would be worse than no signal at all.
 */
export function looksLikeProtobuf(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;

  const message = parseProtobuf(bytes);
  if (!message.complete) return false;

  // Field numbers above ~2000 in a real schema are vanishingly rare and are a
  // reliable tell that noise has been parsed into plausible-looking structure.
  return message.fields.every((f) => f.fieldNumber > 0 && f.fieldNumber < 2048);
}

/** Render a parsed message as indented text for logs and the UI. */
export function formatProtobuf(fields: ProtobufField[], indent = 0): string {
  const pad = "  ".repeat(indent);

  return fields
    .map((field) => {
      const head = `${pad}${field.fieldNumber}`;

      if (field.wireType === 0) return `${head}: ${field.value} (varint)`;
      if (field.wireType === 1) return `${head}: ${field.value} (fixed64)`;
      if (field.wireType === 5) return `${head}: ${field.value} (fixed32)`;

      if (field.text !== undefined) return `${head}: "${field.text}"`;
      if (field.nested) {
        return `${head}: {\n${formatProtobuf(field.nested, indent + 1)}\n${pad}}`;
      }
      return `${head}: ${toHex(field.bytes ?? new Uint8Array(0))} (${field.bytes?.length ?? 0} bytes)`;
    })
    .join("\n");
}

/** Flatten to `path -> value` pairs, e.g. `25.22 -> 1503603158`. */
export function flattenProtobuf(
  fields: ProtobufField[],
  prefix = "",
): Array<{ path: string; value: string }> {
  const out: Array<{ path: string; value: string }> = [];

  for (const field of fields) {
    const path = prefix ? `${prefix}.${field.fieldNumber}` : String(field.fieldNumber);

    if (field.nested) {
      out.push(...flattenProtobuf(field.nested, path));
    } else if (field.text !== undefined) {
      out.push({ path, value: field.text });
    } else if (field.value !== undefined) {
      out.push({ path, value: field.value.toString() });
    } else if (field.bytes) {
      out.push({ path, value: toHex(field.bytes) });
    }
  }

  return out;
}

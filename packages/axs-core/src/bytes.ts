/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * Byte primitives.
 *
 * Everything here works on `Uint8Array` and deliberately avoids Node built-ins
 * (`Buffer`, `TextDecoder`) so the package runs unmodified under Hermes in a
 * React Native app.
 *
 * `react-native-ble-plx` returns characteristic values as base64 strings, so
 * base64 <-> bytes conversion lives here rather than in the transport adapter.
 */

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Reverse lookup table for base64 decoding; -1 marks a non-alphabet byte. */
const B64_LOOKUP: number[] = (() => {
  const table = new Array<number>(256).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) {
    table[B64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/**
 * Decode a base64 string into bytes.
 *
 * Whitespace and padding are tolerated. Characters outside the base64 alphabet
 * are skipped rather than throwing, because BLE stacks occasionally hand back
 * padded or newline-wrapped values.
 */
export function fromBase64(input: string): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < input.length; i++) {
    const value = B64_LOOKUP[input.charCodeAt(i)] ?? -1;
    if (value < 0) continue; // '=' padding, whitespace, stray characters

    buffer = (buffer << 6) | value;
    bits += 6;

    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }

  return Uint8Array.from(out);
}

/** Encode bytes as a base64 string. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";

  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    const remaining = bytes.length - i;

    out += B64_ALPHABET[(triple >> 18) & 0x3f];
    out += B64_ALPHABET[(triple >> 12) & 0x3f];
    out += remaining > 1 ? B64_ALPHABET[(triple >> 6) & 0x3f] : "=";
    out += remaining > 2 ? B64_ALPHABET[triple & 0x3f] : "=";
  }

  return out;
}

/** Lower-case hex, space separated by default: `01 a2 ff`. */
export function toHex(bytes: Uint8Array, separator = " "): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    parts.push((bytes[i] as number).toString(16).padStart(2, "0"));
  }
  return parts.join(separator);
}

/** Parse a hex string. Ignores whitespace, `0x` prefixes, colons and dashes. */
export function fromHex(input: string): Uint8Array {
  const cleaned = input.replace(/0x/gi, "").replace(/[^0-9a-f]/gi, "");
  if (cleaned.length % 2 !== 0) {
    throw new Error(`Hex string has an odd number of digits: "${input}"`);
  }

  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.substr(i * 2, 2), 16);
  }
  return out;
}

/**
 * Render bytes as printable ASCII, substituting `.` for control and non-ASCII
 * bytes. Used by the hex-dump view and by the string heuristic decoder.
 */
export function toPrintableAscii(bytes: Uint8Array, placeholder = "."): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    out += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : placeholder;
  }
  return out;
}

/**
 * Decode bytes as a UTF-8 string. Hand-rolled because `TextDecoder` is not
 * guaranteed across every Hermes build this may run on.
 */
export function toUtf8(bytes: Uint8Array): string {
  let out = "";
  let i = 0;

  while (i < bytes.length) {
    const b0 = bytes[i] as number;

    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
    } else if (b0 >= 0xc0 && b0 < 0xe0 && i + 1 < bytes.length) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | ((bytes[i + 1] as number) & 0x3f));
      i += 2;
    } else if (b0 >= 0xe0 && b0 < 0xf0 && i + 2 < bytes.length) {
      out += String.fromCharCode(
        ((b0 & 0x0f) << 12) |
          (((bytes[i + 1] as number) & 0x3f) << 6) |
          ((bytes[i + 2] as number) & 0x3f),
      );
      i += 3;
    } else if (b0 >= 0xf0 && i + 3 < bytes.length) {
      // Astral plane -> surrogate pair
      const cp =
        ((b0 & 0x07) << 18) |
        (((bytes[i + 1] as number) & 0x3f) << 12) |
        (((bytes[i + 2] as number) & 0x3f) << 6) |
        ((bytes[i + 3] as number) & 0x3f);
      const adjusted = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff));
      i += 4;
    } else {
      // Malformed sequence: emit replacement and resynchronise.
      out += "�";
      i += 1;
    }
  }

  return out;
}

/** Read an unsigned 16-bit little-endian integer. */
export function u16le(bytes: Uint8Array, offset = 0): number {
  return (bytes[offset] as number) | ((bytes[offset + 1] as number) << 8);
}

/** Read an unsigned 16-bit big-endian integer. */
export function u16be(bytes: Uint8Array, offset = 0): number {
  return ((bytes[offset] as number) << 8) | (bytes[offset + 1] as number);
}

/** Read an unsigned 32-bit little-endian integer. */
export function u32le(bytes: Uint8Array, offset = 0): number {
  return (
    ((bytes[offset] as number) |
      ((bytes[offset + 1] as number) << 8) |
      ((bytes[offset + 2] as number) << 16) |
      ((bytes[offset + 3] as number) << 24)) >>>
    0
  );
}

/** Read an unsigned 32-bit big-endian integer. */
export function u32be(bytes: Uint8Array, offset = 0): number {
  return (
    (((bytes[offset] as number) << 24) |
      ((bytes[offset + 1] as number) << 16) |
      ((bytes[offset + 2] as number) << 8) |
      (bytes[offset + 3] as number)) >>>
    0
  );
}

/** Read a 24-bit little-endian integer. */
export function u24le(bytes: Uint8Array, offset = 0): number {
  return (
    (bytes[offset] as number) |
    ((bytes[offset + 1] as number) << 8) |
    ((bytes[offset + 2] as number) << 16)
  );
}

/** True when both arrays have identical length and contents. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Classic `hexdump -C` style output. This is the workhorse of the raw logger —
 * when you do not know what a frame means, you stare at this.
 */
export function hexDump(bytes: Uint8Array, bytesPerRow = 16): string {
  const rows: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += bytesPerRow) {
    const slice = bytes.subarray(offset, offset + bytesPerRow);
    const hex = toHex(slice).padEnd(bytesPerRow * 3 - 1, " ");
    const ascii = toPrintableAscii(slice);
    rows.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }

  return rows.join("\n");
}

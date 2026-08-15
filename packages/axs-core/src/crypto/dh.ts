/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * Finite-field Diffie–Hellman over fixed-width byte strings, Hermes-safe.
 *
 * The SRAMBond session establishes a shared secret with classic modular-
 * exponentiation Diffie–Hellman: each side sends `g^secret mod p`, and both
 * compute `other^secret mod p`. Keys are 16-byte fixed-width values.
 *
 * The group parameters (`p`, `g`) and the exact byte order used on the wire are
 * supplied by the caller — they are pinned in the SRAMBond module (see
 * `axs/srambond-bond.ts` and PROTOCOL.md §5.2), not hardcoded here, so this file
 * stays a clean, testable primitive.
 *
 * Uses native BigInt (available in Hermes and Node); no bignum dependency.
 */

export type ByteOrder = "be" | "le";

export function bytesToBigInt(bytes: Uint8Array, order: ByteOrder): bigint {
  let value = 0n;
  if (order === "be") {
    for (let i = 0; i < bytes.length; i++) value = (value << 8n) | BigInt(bytes[i]!);
  } else {
    for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]!);
  }
  return value;
}

export function bigIntToBytes(value: bigint, length: number, order: ByteOrder): Uint8Array {
  const out = new Uint8Array(length);
  let v = value;
  if (order === "be") {
    for (let i = length - 1; i >= 0; i--) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
  } else {
    for (let i = 0; i < length; i++) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
  }
  return out;
}

/** Modular exponentiation: base^exp mod modulus. */
export function modPow(base: bigint, exp: bigint, modulus: bigint): bigint {
  if (modulus === 1n) return 0n;
  let result = 1n;
  let b = base % modulus;
  if (b < 0n) b += modulus;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    e >>= 1n;
    b = (b * b) % modulus;
  }
  return result;
}

/** Diffie–Hellman group parameters and byte width. */
export interface DhGroup {
  /** Prime modulus p. */
  modulus: bigint;
  /** Generator g. */
  generator: bigint;
  /** Fixed key width in bytes (16 for SRAMBond). */
  keyLength: number;
  /** Byte order used when converting keys to/from the wire. */
  order: ByteOrder;
}

/** Compute the public key `g^secret mod p` as fixed-width wire bytes. */
export function publicKey(group: DhGroup, secret: Uint8Array): Uint8Array {
  const s = bytesToBigInt(secret, group.order);
  const pub = modPow(group.generator, s, group.modulus);
  return bigIntToBytes(pub, group.keyLength, group.order);
}

/** Compute the shared secret `otherPublic^secret mod p` as fixed-width wire bytes. */
export function sharedSecret(
  group: DhGroup,
  secret: Uint8Array,
  otherPublic: Uint8Array,
): Uint8Array {
  const s = bytesToBigInt(secret, group.order);
  const other = bytesToBigInt(otherPublic, group.order);
  const shared = modPow(other, s, group.modulus);
  return bigIntToBytes(shared, group.keyLength, group.order);
}

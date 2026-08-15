/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * AES-EAX authenticated encryption — pure TypeScript, Hermes-safe.
 *
 * The AXS live-state channel is protected with AES in EAX mode (an OMAC/CMAC +
 * CTR construction). This module implements exactly that, with no dependency on
 * Node `crypto` or WebCrypto, so it runs unchanged in a React Native (Hermes)
 * app and in Node.
 *
 * Only the forward AES direction is implemented: EAX uses AES-encrypt for both
 * CTR keystream and the OMAC (CMAC) tag, never AES-decrypt.
 *
 * EAX (Bellare–Rogaway–Wagner):
 *   OMAC^t_K(X) = CMAC_K( [t]_16 || X )      where [t]_16 is t as a 16-byte BE int
 *   N' = OMAC^0_K(nonce)
 *   H' = OMAC^1_K(header/AAD)
 *   C  = CTR_K(start=N', message)
 *   C' = OMAC^2_K(C)
 *   tag = N' XOR C' XOR H'
 *   sealed = C || tag
 *
 * The exact framing SRAM uses on the wire (how nonce/header/tag are laid out in
 * a characteristic payload) is applied by the caller; this module is the raw
 * primitive, validated against the published EAX test vectors.
 */

// --- AES (encryption direction) ---------------------------------------------

// prettier-ignore
const SBOX = Uint8Array.from([
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
]);

const RCON = Uint8Array.from([0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c, 0xd8, 0xab, 0x4d]);

function xtime(a: number): number {
  return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
}

function mul(a: number, b: number): number {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p & 0xff;
}

/** An expanded AES key schedule, ready for repeated block encryption. */
export class AesKey {
  private readonly roundKeys: Uint8Array; // (rounds+1) * 16 bytes
  readonly rounds: number;

  constructor(key: Uint8Array) {
    if (key.length !== 16 && key.length !== 24 && key.length !== 32) {
      throw new Error(`AES key must be 16, 24 or 32 bytes, got ${key.length}`);
    }
    const Nk = key.length / 4;
    this.rounds = Nk + 6;
    const Nb = 4;
    const total = Nb * (this.rounds + 1); // number of 4-byte words
    const w = new Uint8Array(total * 4);
    w.set(key);

    for (let i = Nk; i < total; i++) {
      const prev = (i - 1) * 4;
      let t0 = w[prev]!;
      let t1 = w[prev + 1]!;
      let t2 = w[prev + 2]!;
      let t3 = w[prev + 3]!;

      if (i % Nk === 0) {
        // RotWord + SubWord + Rcon
        const r0 = t0;
        t0 = SBOX[t1]! ^ RCON[i / Nk - 1]!;
        t1 = SBOX[t2]!;
        t2 = SBOX[t3]!;
        t3 = SBOX[r0]!;
      } else if (Nk > 6 && i % Nk === 4) {
        t0 = SBOX[t0]!;
        t1 = SBOX[t1]!;
        t2 = SBOX[t2]!;
        t3 = SBOX[t3]!;
      }

      const base = i * 4;
      const pk = (i - Nk) * 4;
      w[base] = w[pk]! ^ t0;
      w[base + 1] = w[pk + 1]! ^ t1;
      w[base + 2] = w[pk + 2]! ^ t2;
      w[base + 3] = w[pk + 3]! ^ t3;
    }
    this.roundKeys = w;
  }

  /** Encrypt one 16-byte block in place-free fashion, returning a new block. */
  encryptBlock(input: Uint8Array): Uint8Array {
    const s = new Uint8Array(16);
    s.set(input.subarray(0, 16));
    const rk = this.roundKeys;

    addRoundKey(s, rk, 0);
    for (let round = 1; round < this.rounds; round++) {
      subBytes(s);
      shiftRows(s);
      mixColumns(s);
      addRoundKey(s, rk, round * 16);
    }
    subBytes(s);
    shiftRows(s);
    addRoundKey(s, rk, this.rounds * 16);
    return s;
  }
}

function addRoundKey(s: Uint8Array, rk: Uint8Array, off: number): void {
  for (let i = 0; i < 16; i++) s[i]! ^= rk[off + i]!;
}

function subBytes(s: Uint8Array): void {
  for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]!]!;
}

function shiftRows(s: Uint8Array): void {
  // State is column-major: byte at row r, col c is s[c*4 + r].
  let t = s[1]!; s[1] = s[5]!; s[5] = s[9]!; s[9] = s[13]!; s[13] = t;
  t = s[2]!; s[2] = s[10]!; s[10] = t; t = s[6]!; s[6] = s[14]!; s[14] = t;
  t = s[15]!; s[15] = s[11]!; s[11] = s[7]!; s[7] = s[3]!; s[3] = t;
}

function mixColumns(s: Uint8Array): void {
  for (let c = 0; c < 4; c++) {
    const i = c * 4;
    const a0 = s[i]!, a1 = s[i + 1]!, a2 = s[i + 2]!, a3 = s[i + 3]!;
    s[i] = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3;
    s[i + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3;
    s[i + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3);
    s[i + 3] = (xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3);
  }
}

// --- CMAC (OMAC1) -----------------------------------------------------------

function shiftLeft1(block: Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  let carry = 0;
  for (let i = 15; i >= 0; i--) {
    const b = block[i]!;
    out[i] = ((b << 1) | carry) & 0xff;
    carry = (b >> 7) & 1;
  }
  return out;
}

function xorInto(a: Uint8Array, b: Uint8Array): void {
  for (let i = 0; i < 16; i++) a[i]! ^= b[i]!;
}

function cmacSubkeys(key: AesKey): { k1: Uint8Array; k2: Uint8Array } {
  const l = key.encryptBlock(new Uint8Array(16));
  const k1 = shiftLeft1(l);
  if (l[0]! & 0x80) k1[15]! ^= 0x87;
  const k2 = shiftLeft1(k1);
  if (k1[0]! & 0x80) k2[15]! ^= 0x87;
  return { k1, k2 };
}

/** AES-CMAC (NIST SP 800-38B) over an arbitrary-length message. */
export function cmac(key: AesKey, message: Uint8Array): Uint8Array {
  const { k1, k2 } = cmacSubkeys(key);
  const n = Math.ceil(message.length / 16) || 1;
  const complete = message.length > 0 && message.length % 16 === 0;

  let x: Uint8Array = new Uint8Array(16);
  for (let i = 0; i < n - 1; i++) {
    const block = message.subarray(i * 16, i * 16 + 16);
    xorInto(x, block);
    x = key.encryptBlock(x);
  }

  const last = new Uint8Array(16);
  const rem = message.subarray((n - 1) * 16);
  last.set(rem);
  if (complete) {
    xorInto(last, k1);
  } else {
    last[rem.length] = 0x80; // padding
    xorInto(last, k2);
  }
  xorInto(x, last);
  return key.encryptBlock(x);
}

// --- EAX --------------------------------------------------------------------

function omac(key: AesKey, t: number, data: Uint8Array): Uint8Array {
  // [t]_16 || data, then CMAC.
  const buf = new Uint8Array(16 + data.length);
  buf[15] = t; // t is small (0,1,2); big-endian 16-byte encoding
  buf.set(data, 16);
  return cmac(key, buf);
}

function ctr(key: AesKey, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  const counter = iv.slice(0, 16);
  for (let off = 0; off < data.length; off += 16) {
    const ks = key.encryptBlock(counter);
    const n = Math.min(16, data.length - off);
    for (let i = 0; i < n; i++) out[off + i] = data[off + i]! ^ ks[i]!;
    // increment 128-bit big-endian counter
    for (let i = 15; i >= 0; i--) {
      counter[i] = (counter[i]! + 1) & 0xff;
      if (counter[i] !== 0) break;
    }
  }
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export interface EaxOptions {
  /** Additional authenticated data (EAX "header"). Default: empty. */
  header?: Uint8Array;
  /** Tag length in bytes (1..16). Default: 16 (full). */
  tagLength?: number;
}

/**
 * EAX seal: returns ciphertext followed by the authentication tag.
 * `key` may be 16/24/32 bytes; `nonce` is arbitrary length.
 */
export function eaxEncrypt(
  keyBytes: Uint8Array,
  nonce: Uint8Array,
  message: Uint8Array,
  opts: EaxOptions = {},
): Uint8Array {
  const key = new AesKey(keyBytes);
  const header = opts.header ?? new Uint8Array(0);
  const tagLen = opts.tagLength ?? 16;

  const nPrime = omac(key, 0, nonce);
  const hPrime = omac(key, 1, header);
  const ciphertext = ctr(key, nPrime, message);
  const cPrime = omac(key, 2, ciphertext);

  const tag = new Uint8Array(16);
  for (let i = 0; i < 16; i++) tag[i] = nPrime[i]! ^ cPrime[i]! ^ hPrime[i]!;

  const out = new Uint8Array(ciphertext.length + tagLen);
  out.set(ciphertext);
  out.set(tag.subarray(0, tagLen), ciphertext.length);
  return out;
}

/**
 * EAX open: verifies the tag and returns the plaintext, or throws on a bad tag.
 * `sealed` is ciphertext||tag.
 */
export function eaxDecrypt(
  keyBytes: Uint8Array,
  nonce: Uint8Array,
  sealed: Uint8Array,
  opts: EaxOptions = {},
): Uint8Array {
  const key = new AesKey(keyBytes);
  const header = opts.header ?? new Uint8Array(0);
  const tagLen = opts.tagLength ?? 16;
  if (sealed.length < tagLen) throw new Error("ciphertext shorter than tag");

  const ciphertext = sealed.subarray(0, sealed.length - tagLen);
  const receivedTag = sealed.subarray(sealed.length - tagLen);

  const nPrime = omac(key, 0, nonce);
  const hPrime = omac(key, 1, header);
  const cPrime = omac(key, 2, ciphertext);

  const tag = new Uint8Array(16);
  for (let i = 0; i < 16; i++) tag[i] = nPrime[i]! ^ cPrime[i]! ^ hPrime[i]!;

  if (!timingSafeEqual(tag.subarray(0, tagLen), receivedTag)) {
    throw new Error("EAX tag mismatch — wrong key, nonce, header, or corrupt data");
  }
  return ctr(key, nPrime, ciphertext);
}

/** Exposed for testing against AES known-answer vectors. */
export const _internal = { AesKey, cmac, mul };

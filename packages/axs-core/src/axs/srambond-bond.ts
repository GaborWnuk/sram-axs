/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * SRAMBond offline create-bond — establish a session with an AXS component
 * with no cloud and no pre-shared key, by performing the pairing handshake the
 * official app runs in "Off The Grid / Bluetooth Access" mode.
 *
 * Bench-verified against a real RD-GX-E-B1 under airplane mode with the app's
 * local key cache wiped: the handshake completes fully offline. The captured
 * wire sequence and every cryptographic value are reproduced byte-for-byte by
 * the pure functions below (see srambond-bond.test.ts).
 *
 * ## The handshake (SRAMBond v1, on characteristic d905ee52)
 *
 *   1. write INIT (`00 01 02 … 0e 0f`)            — enter the exchange
 *   2. write the client DH public key (16 bytes)   — g^priv mod p, big-endian
 *   3. read the component's DH public key (16 B)
 *   4. shared secret = devPublic^priv mod p        — the transport key
 *   5. read the 48-byte key-transport blob         — nonce16 ‖ ct16 ‖ tag16
 *   6. deviceKey = AES-EAX-decrypt(shared, blob)   — the live-state key
 *   7. write FINALIZE (`73`)                        — commit
 *
 * The component only accepts a new bond while it is physically in pairing mode
 * (hold the AXS button until it blinks). That physical gate is SRAM's
 * anti-theft measure — you cannot bond to a component you cannot touch — and is
 * why this handshake is not a remote attack surface.
 *
 * `deviceKey` then decrypts the live-state channel (see `srambond.ts`):
 * `decodeSrambondState(deviceKey, d905000bFrame)` → current gear.
 *
 * Note: each create-bond makes the component mint a fresh live-state key, so
 * bonding re-keys the diagnostics link. It does not touch shifting (that is the
 * separate AIREA radio); the official app transparently re-bonds next connect.
 */

import { fromHex } from "../bytes.js";
import { clearIntervalCompat, setIntervalCompat, setTimeoutCompat } from "../timers.js";
import { eaxDecrypt } from "../crypto/aes-eax.js";
import { bigIntToBytes, bytesToBigInt, modPow } from "../crypto/dh.js";
import { DEVICE_INFORMATION_SERVICE, DIS_CHARACTERISTICS } from "../gatt/uuids.js";
import type { ConnectedPeripheral } from "../transport.js";

/** SRAMBond v1 GATT surface. */
export const SRAMBOND_V1_SERVICE = "d905ee51-90aa-4c7c-b036-1e01fb8eb7ee";
export const SRAMBOND_V1_CHARACTERISTIC = "d905ee52-90aa-4c7c-b036-1e01fb8eb7ee";

/** Finite-field Diffie–Hellman group used by SRAMBond: g = 5, p = 2^128 − 713. */
export const SRAMBOND_MODULUS = (1n << 128n) - 713n; // 0xfffffffffffffffffffffffffffffd37
export const SRAMBOND_GENERATOR = 5n;

/** First write of the handshake — a fixed 16-byte sequence. */
export const SRAMBOND_INIT = fromHex("000102030405060708090a0b0c0d0e0f");
/** Final write of the handshake — commit. */
export const SRAMBOND_FINALIZE = Uint8Array.from([0x73]);

const KEY_LENGTH = 16;
/** The key-transport blob: nonce ‖ ciphertext ‖ tag, one key width each. */
const TRANSPORT_BLOB_LENGTH = KEY_LENGTH * 3;

/**
 * The client DH public key from a 16-byte private key, in wire form.
 * `public = g^priv mod p`, serialised big-endian (the private key bytes are
 * interpreted little-endian, matching the reference implementation).
 */
/**
 * Every value on the wire is exactly one key wide. Getting a short or
 * fragmented notification here is not a rounding error — it silently changes
 * the integer, and therefore the shared secret, and the failure only surfaces
 * later as a tag mismatch that points at the wrong layer.
 */
function assertKeyLength(value: Uint8Array, what: string): void {
  if (value.length !== KEY_LENGTH) {
    throw new Error(`SRAMBond ${what} must be ${KEY_LENGTH} bytes, got ${value.length}`);
  }
}

export function computePublicKey(privateKey: Uint8Array): Uint8Array {
  assertKeyLength(privateKey, "private key");
  const priv = bytesToBigInt(privateKey, "le");
  return bigIntToBytes(modPow(SRAMBOND_GENERATOR, priv, SRAMBOND_MODULUS), KEY_LENGTH, "be");
}

/**
 * The shared secret from the client private key and the component's public key.
 * `shared = devicePublic^priv mod p`. This is the AES-EAX key that unwraps the
 * transported device key.
 */
export function computeSharedSecret(privateKey: Uint8Array, devicePublicKey: Uint8Array): Uint8Array {
  assertKeyLength(privateKey, "private key");
  assertKeyLength(devicePublicKey, "device public key");

  const dev = bytesToBigInt(devicePublicKey, "be");
  // 0 and 1 raise to themselves for any exponent, and p-1 collapses to ±1, so
  // a peer sending one of them fixes the "shared" secret to a value it chose.
  // Values at or above the modulus are simply not group elements.
  if (dev <= 1n || dev >= SRAMBOND_MODULUS - 1n) {
    throw new Error("SRAMBond device public key is degenerate or out of range");
  }

  const priv = bytesToBigInt(privateKey, "le");
  return bigIntToBytes(modPow(dev, priv, SRAMBOND_MODULUS), KEY_LENGTH, "be");
}

/**
 * Unwrap the component's live-state key from the 48-byte transport blob
 * (`nonce16 ‖ ciphertext16 ‖ tag16`) using the DH shared secret.
 */
export function decryptTransportedKey(sharedSecret: Uint8Array, transportBlob: Uint8Array): Uint8Array {
  // nonce(16) ‖ ciphertext(16) ‖ tag(16). Accepting anything shorter lets a
  // 32-byte blob through as nonce+tag with an empty ciphertext, which decrypts
  // to a zero-length "key" and reports success.
  if (transportBlob.length !== TRANSPORT_BLOB_LENGTH) {
    throw new Error(
      `SRAMBond transport blob must be ${TRANSPORT_BLOB_LENGTH} bytes, got ${transportBlob.length}`,
    );
  }
  const nonce = transportBlob.subarray(0, 16);
  const ciphertextAndTag = transportBlob.subarray(16);
  return eaxDecrypt(sharedSecret, nonce, ciphertextAndTag, { tagLength: 16 });
}

export interface CreateBondOptions {
  /** Supplies 16 cryptographically-random bytes for the ephemeral private key. */
  randomBytes: (length: number) => Uint8Array;
  /**
   * Called once the handshake is ready to proceed but the component must be in
   * pairing mode. Implementations should prompt the rider to hold the AXS button
   * until it blinks, and resolve when they confirm. Optional; if omitted the
   * caller is assumed to have already put the component into pairing mode.
   */
  waitForPairingMode?: () => Promise<void>;
  /** Progress callback for logging each step. */
  onStep?: (step: string) => void;
  /** Per-operation timeout in ms (default 5000). */
  timeoutMs?: number;
  /**
   * How often to touch the link while waiting for pairing mode, in ms
   * (default 10000). Set to 0 to disable.
   */
  keepAliveIntervalMs?: number;
}

/**
 * Perform the offline create-bond against a connected component and return its
 * live-state key. The component must be (or be put) in pairing mode.
 *
 * This writes to the SRAMBond service only — never the firmware/DFU path.
 */
export async function createBond(
  peripheral: ConnectedPeripheral,
  options: CreateBondOptions,
): Promise<Uint8Array> {
  const svc = SRAMBOND_V1_SERVICE;
  const chr = SRAMBOND_V1_CHARACTERISTIC;
  const step = options.onStep ?? (() => {});

  // The component answers on the same characteristic it is written to. On real
  // hardware that characteristic is **notify-only** — reading it is rejected
  // with "Reading is not permitted" — so responses must be awaited as
  // notifications. A read is only attempted as a last resort, for stacks or
  // components that do expose it.
  const inbox: Uint8Array[] = [];
  let deliver: ((value: Uint8Array) => void) | null = null;

  const unsubscribe = await peripheral.subscribe(svc, chr, (value) => {
    if (deliver) {
      const resolve = deliver;
      deliver = null;
      resolve(value);
    } else {
      inbox.push(value);
    }
  });

  const timeoutMs = options.timeoutMs ?? 5000;

  /** Next value from the component: a queued notification, the next one, or a read. */
  const readValue = async (): Promise<Uint8Array> => {
    const queued = inbox.shift();
    if (queued) return queued;

    const notified = await new Promise<Uint8Array | null>((resolve) => {
      deliver = resolve;
      setTimeoutCompat(() => {
        if (deliver === resolve) {
          deliver = null;
          resolve(null);
        }
      }, timeoutMs);
    });
    if (notified) return notified;

    // No notification in time. Some components also allow a plain read.
    try {
      return await peripheral.read(svc, chr);
    } catch (error) {
      throw new Error(
        `SRAMBond: no response on ${chr} within ${timeoutMs}ms and it is not readable ` +
          `(${error instanceof Error ? error.message : String(error)}). ` +
          `Is the component still in pairing mode?`,
      );
    }
  };

  try {
    if (options.waitForPairingMode) {
      step("waiting for pairing mode (hold the AXS button until it blinks)");

      // A component that has nothing to say goes quiet and then hangs up on an
      // idle link — observed at just over three minutes, as GATT status 19
      // (terminated by peer). A rider walking to the bike and holding a button
      // is easily slower than that, so the wait cannot sit on a silent link.
      // A periodic read of the Manufacturer Name is enough to keep it warm, and
      // is read-only.
      const keepAliveMs = options.keepAliveIntervalMs ?? 10_000;
      const keepAlive =
        keepAliveMs > 0
          ? setIntervalCompat(() => {
              void peripheral
                .read(DEVICE_INFORMATION_SERVICE, DIS_CHARACTERISTICS.manufacturerName)
                .catch(() => {
                  // A failed keepalive is not itself fatal; the handshake below
                  // will report the real problem.
                });
            }, keepAliveMs)
          : null;

      try {
        await options.waitForPairingMode();
      } finally {
        if (keepAlive !== null) clearIntervalCompat(keepAlive);
      }
    }

    step("write init");
    await peripheral.write(svc, chr, SRAMBOND_INIT, true);

    const privateKey = options.randomBytes(KEY_LENGTH);
    if (privateKey.length !== KEY_LENGTH) {
      throw new Error(
        `randomBytes(${KEY_LENGTH}) returned ${privateKey.length} bytes. The private key must be ` +
          `exactly ${KEY_LENGTH} bytes from a CSPRNG.`,
      );
    }
    const publicKey = computePublicKey(privateKey);
    step("write public key");
    await peripheral.write(svc, chr, publicKey, true);

    step("read device public key");
    const devicePublicKey = await readValue();
    const sharedSecret = computeSharedSecret(privateKey, devicePublicKey);

    step("read transported key");
    // The transport blob is 48 bytes; some stacks deliver it as one value,
    // others fragmented — accumulate until at least 48 bytes are present.
    let blob = await readValue();
    while (blob.length < 48) {
      const more = await readValue();
      const merged = new Uint8Array(blob.length + more.length);
      merged.set(blob);
      merged.set(more, blob.length);
      blob = merged;
    }
    const deviceKey = decryptTransportedKey(sharedSecret, blob.subarray(0, 48));

    step("write finalize");
    await peripheral.write(svc, chr, SRAMBOND_FINALIZE, true);

    step("bonded");
    return deviceKey;
  } finally {
    unsubscribe();
  }
}

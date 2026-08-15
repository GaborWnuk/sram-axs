/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * SRAMBond live-state decryption — the piece that turns the encrypted
 * drivetrain characteristic into a readable gear.
 *
 * How this was established (bench-verified against a real RD-GX-E-B1):
 *
 * The live drivetrain state is served on characteristic `d905000b` as a 41-byte
 * frame and protected with **AES-EAX**:
 *
 *     frame = nonce(16) || ciphertext(N) || tag(16)
 *     plaintext = EAX-decrypt(key, nonce, ciphertext || tag, header = <empty>)
 *
 * The plaintext is the `drivetrain_status` protobuf, whose field 21
 * (`rd_position`) is the current rear gear. Decrypting a full 1→12→1 cassette
 * sweep reproduced every gear exactly.
 *
 * The AES key is a **per-device** value: device-generated, not derived from the
 * serial, and not fixed. A client obtains it by performing SRAM's offline pairing
 * handshake — see `srambond-bond.ts` (`createBond`), which does the Diffie–Hellman
 * exchange and decrypts the key the component transports back. Given the key,
 * everything here (the EAX layer and the protobuf decode) is pure, dependency-free
 * TypeScript.
 */

import { toHex } from "../bytes.js";
import { eaxDecrypt } from "../crypto/aes-eax.js";
import type { DecodedResult, Decoder, RawFrame } from "../frame.js";
import {
  decodeDrivetrainConfig,
  decodeDrivetrainStatus,
  type DrivetrainStatus,
} from "./drivetrain.js";

/** Characteristic that serves the encrypted drivetrain live-state frame. */
export const LIVE_STATE_CHARACTERISTIC = "d905000b-90aa-4c7c-b036-1e01fb8eb7ee";

/** Frame layout constants. */
export const SRAMBOND_NONCE_LENGTH = 16;
export const SRAMBOND_TAG_LENGTH = 16;

/**
 * Decrypt a SRAMBond live-state frame (`nonce || ciphertext || tag`) to its
 * plaintext. Throws if the frame is too short or the tag does not verify (wrong
 * key or corrupt data).
 */
export function decryptLiveStateFrame(key: Uint8Array, frame: Uint8Array): Uint8Array {
  if (frame.length < SRAMBOND_NONCE_LENGTH + SRAMBOND_TAG_LENGTH) {
    throw new Error(`SRAMBond frame too short: ${frame.length} bytes`);
  }
  const nonce = frame.subarray(0, SRAMBOND_NONCE_LENGTH);
  const ciphertextAndTag = frame.subarray(SRAMBOND_NONCE_LENGTH);
  return eaxDecrypt(key, nonce, ciphertextAndTag, { tagLength: SRAMBOND_TAG_LENGTH });
}

/**
 * Decrypt and decode a `d905000b` frame into drivetrain state. `gearRear` is the
 * current gear. Throws on a bad key/frame; callers that poll should catch and
 * skip rather than crash.
 */
export function decodeSrambondState(key: Uint8Array, frame: Uint8Array): DrivetrainStatus {
  return decodeDrivetrainStatus(decryptLiveStateFrame(key, frame));
}

/**
 * Build a {@link Decoder} that decrypts SRAMBond frames with a known device key.
 *
 * The decoder registry is deliberately keyless — decoders are pure functions of
 * a frame — so decrypting state has to enter through a decoder you construct
 * once you hold a key (from {@link createBond} or a previous bond). Register it
 * and `StateAggregator`, the log view and the dashboard all start showing gear
 * with no further wiring:
 *
 * ```ts
 * probe.registry.add(createSrambondDecoder(deviceKey));
 * ```
 *
 * Frames that do not authenticate under this key are declined, so registering a
 * decoder for the wrong component is harmless.
 */
export function createSrambondDecoder(key: Uint8Array): Decoder {
  return {
    name: "axs/srambond",
    decode(frame: RawFrame): DecodedResult | null {
      if (frame.data.length < SRAMBOND_NONCE_LENGTH + SRAMBOND_TAG_LENGTH) return null;

      let plaintext: Uint8Array;
      try {
        plaintext = decryptLiveStateFrame(key, frame.data);
      } catch {
        // Wrong key, a different component, or not an encrypted frame at all.
        return null;
      }

      // The same encrypted channel carries several messages. Field numbers tell
      // them apart: 20-22 is drivetrain_status, 23-25 is drivetrain_config.
      const status = decodeDrivetrainStatus(plaintext);
      if (status.gearRear !== undefined) {
        const fields: Record<string, unknown> = { gearRear: status.gearRear };
        if (status.gearFront !== undefined) fields.gearFront = status.gearFront;
        if (status.trimRear !== undefined) fields.trimRear = status.trimRear;
        return {
          decoder: this.name,
          confidence: 0.99,
          summary: `gear ${status.gearRear}`,
          fields,
        };
      }

      const config = decodeDrivetrainConfig(plaintext);
      if (config.totalRear !== undefined) {
        const fields: Record<string, unknown> = { totalRear: config.totalRear };
        if (config.totalFront !== undefined) fields.totalFront = config.totalFront;
        return {
          decoder: this.name,
          confidence: 0.99,
          summary: `drivetrain: ${config.totalRear} rear cogs`,
          fields,
        };
      }

      // Authenticated, but not a modelled message — still worth surfacing.
      return {
        decoder: this.name,
        confidence: 0.9,
        summary: `decrypted ${plaintext.length}B (unmapped message)`,
        fields: { decryptedHex: toHex(plaintext, "") },
      };
    },
  };
}

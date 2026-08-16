/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * The message router for the encrypted live-state channel.
 *
 * A fact about the protocol that is easy to miss: `d905000b` is not "the gear
 * characteristic". It is a **pipe carrying several different messages**, told
 * apart by which protobuf field numbers the plaintext contains. A drivetrain
 * reports `drivetrain_status` (fields 20-22) and `drivetrain_config` (23-25) on
 * the same characteristic, and other AXS components report their own messages
 * on their own field numbers.
 *
 * That distinction used to live inside `createSrambondDecoder` as a chain of
 * ifs, which put the crypto and the message vocabulary in the same function. It
 * meant teaching the library about a dropper post required editing the code
 * that decrypts. Here they are separate: decryption stays in `srambond.ts`, and
 * what a plaintext *means* is a list of profiles that anyone can extend.
 *
 * ## Adding a message
 *
 * Write a profile and register it. Nothing else changes — not the crypto, not
 * the decoder, not the transport:
 *
 * ```ts
 * const dropperStatus: MessageProfile<{ postPosition: number }> = {
 *   name: "dropper_status",
 *   fieldNumbers: [30],
 *   decode: (plaintext) => { ... },
 *   toFields: (value) => ({ postPosition: value.postPosition }),
 *   summarize: (value) => `post ${value.postPosition}`,
 * };
 * ```
 *
 * A profile that cannot make sense of a plaintext returns null and the router
 * moves on, so registering a profile for hardware you do not have is harmless.
 */

import { toHex } from "../bytes.js";
import { parseProtobuf } from "../decode/protobuf.js";
import {
  decodeDrivetrainConfig,
  decodeDrivetrainStatus,
  type DrivetrainConfig,
  type DrivetrainStatus,
} from "./drivetrain.js";

/**
 * How a message is *written*.
 *
 * @typeParam T - the decoded shape this message produces. Each profile decodes
 * to its own type, which is the point: a dropper profile should not have to
 * pretend its position is a `DrivetrainStatus`.
 */
export interface MessageProfile<T> {
  /** Protocol name, used in summaries and in `decodedMessage`. */
  name: string;
  /**
   * Protobuf field numbers that identify this message.
   *
   * Documentation, and a cheap pre-filter: a plaintext carrying none of these
   * cannot be this message, so `decode` is never called for it. Recognition
   * still rests on `decode` returning non-null, because field numbers overlap
   * between messages more often than is comfortable.
   */
  fieldNumbers: readonly number[];
  /** Decode the decrypted plaintext, or return null if this is not that message. */
  decode(plaintext: Uint8Array): T | null;
  /** Flatten into the registry's open field map, for `StateAggregator`. */
  toFields(value: T): Record<string, unknown>;
  /** One-line human summary for the log view. */
  summarize(value: T): string;
}

/**
 * How a message is *held* — the same profile with its decoded type sealed in.
 *
 * A registry is a list of profiles that decode to different types, which no
 * single `MessageProfile<T>` can describe. Rather than erase the difference
 * with a cast, {@link defineMessage} closes over `T` and hands back this: the
 * decode-and-flatten step as one operation, with the intermediate type kept
 * private to the profile that owns it.
 */
export interface AnyMessageProfile {
  name: string;
  fieldNumbers: readonly number[];
  /** Decode and flatten, or return null if this plaintext is not this message. */
  route(plaintext: Uint8Array): { fields: Record<string, unknown>; summary: string } | null;
}

/** What the router made of a plaintext. */
export interface RoutedMessage {
  /** The profile that claimed it. */
  profile: string;
  fields: Record<string, unknown>;
  summary: string;
  /** 0..1, carried into the decoding. */
  confidence: number;
}

/**
 * Seal a profile's decoded type so it can go in a registry alongside others.
 *
 * ```ts
 * export const dropperStatus = defineMessage<DropperStatus>({
 *   name: "dropper_status",
 *   fieldNumbers: [30],
 *   decode: (plaintext) => …,
 *   toFields: (value) => ({ postPosition: value.position }),
 *   summarize: (value) => `post ${value.position}`,
 * });
 * ```
 */
export function defineMessage<T>(profile: MessageProfile<T>): AnyMessageProfile {
  return {
    name: profile.name,
    fieldNumbers: profile.fieldNumbers,
    route(plaintext) {
      const value = profile.decode(plaintext);
      if (value === null) return null;
      return { fields: profile.toFields(value), summary: profile.summarize(value) };
    },
  };
}

/** `drivetrain_status` — fd_position, rd_position (the gear), rd_trim. */
export const drivetrainStatusMessage = defineMessage<DrivetrainStatus>({
  name: "drivetrain_status",
  fieldNumbers: [20, 21, 22],
  decode(plaintext) {
    const status = decodeDrivetrainStatus(plaintext);
    // rd_position is what makes this a status message rather than a config
    // one; without it there is nothing here worth reporting.
    return status.gearRear === undefined ? null : status;
  },
  toFields(status) {
    const fields: Record<string, unknown> = { gearRear: status.gearRear };
    if (status.gearFront !== undefined) fields.gearFront = status.gearFront;
    if (status.trimRear !== undefined) fields.trimRear = status.trimRear;
    return fields;
  },
  summarize: (status) => `gear ${String(status.gearRear)}`,
});

/** `drivetrain_config` — how many cogs and chainrings the drivetrain has. */
export const drivetrainConfigMessage = defineMessage<DrivetrainConfig>({
  name: "drivetrain_config",
  fieldNumbers: [23, 24, 25],
  decode(plaintext) {
    const config = decodeDrivetrainConfig(plaintext);
    return config.totalRear === undefined ? null : config;
  },
  toFields(config) {
    const fields: Record<string, unknown> = { totalRear: config.totalRear };
    if (config.totalFront !== undefined) fields.totalFront = config.totalFront;
    if (config.trimCount !== undefined) fields.trimCount = config.trimCount;
    return fields;
  },
  summarize: (config) => `drivetrain: ${String(config.totalRear)} rear cogs`,
});

/**
 * The messages known on the encrypted channel today.
 *
 * Drivetrain only, because a drivetrain is the only component whose live state
 * has been observed. That is a statement about what has been on the bench, not
 * about what the protocol supports.
 */
export const AXS_MESSAGES: readonly AnyMessageProfile[] = [
  drivetrainStatusMessage,
  drivetrainConfigMessage,
];

/** Top-level field numbers present in a plaintext, for the pre-filter. */
function topLevelFieldNumbers(plaintext: Uint8Array): Set<number> {
  const numbers = new Set<number>();
  for (const field of parseProtobuf(plaintext).fields) numbers.add(field.fieldNumber);
  return numbers;
}

/**
 * Route a decrypted plaintext to the first profile that claims it.
 *
 * Returns null when no profile recognises it. That is not a failure: the
 * plaintext authenticated, so it is a genuine message from the component that
 * this library has not learned to read yet. Callers should surface it as such —
 * an unmapped message with its bytes visible is the single most useful output
 * when reverse engineering a new component.
 */
export function routeMessage(
  plaintext: Uint8Array,
  profiles: readonly AnyMessageProfile[] = AXS_MESSAGES,
): RoutedMessage | null {
  const present = topLevelFieldNumbers(plaintext);

  for (const profile of profiles) {
    if (!profile.fieldNumbers.some((n) => present.has(n))) continue;

    const routed = profile.route(plaintext);
    if (routed === null) continue;

    return {
      profile: profile.name,
      fields: { ...routed.fields, decodedMessage: profile.name },
      summary: routed.summary,
      confidence: 0.99,
    };
  }

  return null;
}

/**
 * What to report for an authenticated plaintext no profile claimed.
 *
 * Kept deliberately informative: the hex is the raw material for working out
 * what the message is, and the confidence sits below a mapped message without
 * dropping to the floor — it decrypted, so it is certainly a real message.
 */
export function unmappedMessage(plaintext: Uint8Array): RoutedMessage {
  return {
    profile: "unmapped",
    fields: {
      decryptedHex: toHex(plaintext, ""),
      decryptedFieldNumbers: [...topLevelFieldNumbers(plaintext)],
    },
    summary: `decrypted ${plaintext.length}B (unmapped message)`,
    confidence: 0.9,
  };
}

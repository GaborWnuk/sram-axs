/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * Reconnection policy.
 *
 * AXS components sleep aggressively and drop an idle connection within roughly
 * 10-100 seconds. For anything long-running — a ride dashboard, a bench capture
 * — a dropped link is the normal case, not an error, so reconnecting has to be
 * automatic and quiet.
 *
 * The backoff is exponential with jitter. Jitter matters here for a practical
 * reason: a component that has gone to sleep rejects connections until it wakes,
 * and retrying on an exact fixed cadence can repeatedly collide with the same
 * radio activity. Spreading the attempts out avoids lock-step retries.
 */

/** How reconnection attempts are spaced. */
export interface ReconnectPolicy {
  /** Delay before the first retry, in ms. */
  initialDelayMs: number;
  /** Ceiling for the delay, in ms. */
  maxDelayMs: number;
  /** Multiplier applied to the delay after each failed attempt. */
  factor: number;
  /** Randomise each delay by ±25 % to avoid lock-step retries. */
  jitter: boolean;
  /** Give up after this many consecutive failures. `Infinity` never gives up. */
  maxAttempts: number;
}

/**
 * Sensible defaults for a component that sleeps: retry quickly at first (the
 * usual case is a brief idle drop while the rider is still there), then back off
 * to a slow poll so a bike left in the garage does not spin the radio.
 */
export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  initialDelayMs: 500,
  maxDelayMs: 15_000,
  factor: 2,
  jitter: true,
  maxAttempts: Number.POSITIVE_INFINITY,
};

/**
 * Delay before retry number `attempt` (1 = the first retry).
 *
 * Pure, so the backoff curve can be unit-tested without timers. Pass `random`
 * to make jitter deterministic in tests.
 */
export function nextBackoffDelay(
  attempt: number,
  policy: ReconnectPolicy = DEFAULT_RECONNECT_POLICY,
  random: () => number = Math.random,
): number {
  const step = Math.max(1, attempt);
  const raw = policy.initialDelayMs * Math.pow(policy.factor, step - 1);
  const capped = Math.min(raw, policy.maxDelayMs);
  if (!policy.jitter) return Math.round(capped);

  // ±25 %, clamped so jitter can never produce a negative or zero delay.
  const spread = capped * 0.25;
  const jittered = capped - spread + random() * spread * 2;
  return Math.max(1, Math.round(jittered));
}

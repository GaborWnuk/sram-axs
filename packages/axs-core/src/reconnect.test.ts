/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_RECONNECT_POLICY, nextBackoffDelay, type ReconnectPolicy } from "./reconnect.js";

const noJitter: ReconnectPolicy = { ...DEFAULT_RECONNECT_POLICY, jitter: false };

describe("nextBackoffDelay", () => {
  it("grows exponentially from the initial delay", () => {
    expect(nextBackoffDelay(1, noJitter)).toBe(500);
    expect(nextBackoffDelay(2, noJitter)).toBe(1000);
    expect(nextBackoffDelay(3, noJitter)).toBe(2000);
    expect(nextBackoffDelay(4, noJitter)).toBe(4000);
  });

  it("never exceeds the ceiling, however many attempts", () => {
    expect(nextBackoffDelay(50, noJitter)).toBe(noJitter.maxDelayMs);
    // A bike left in the garage must not spin the radio forever.
    expect(nextBackoffDelay(1000, noJitter)).toBe(noJitter.maxDelayMs);
  });

  it("treats attempt 0 as the first retry rather than returning nothing", () => {
    expect(nextBackoffDelay(0, noJitter)).toBe(500);
  });

  it("applies +/-25% jitter around the base delay", () => {
    const policy: ReconnectPolicy = { ...noJitter, jitter: true };
    // random() = 0 -> the low end, 1 -> the high end.
    expect(nextBackoffDelay(2, policy, () => 0)).toBe(750);
    expect(nextBackoffDelay(2, policy, () => 1)).toBe(1250);
    expect(nextBackoffDelay(2, policy, () => 0.5)).toBe(1000);
  });

  it("never returns a non-positive delay", () => {
    const tiny: ReconnectPolicy = { ...DEFAULT_RECONNECT_POLICY, initialDelayMs: 1 };
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(nextBackoffDelay(attempt, tiny, () => 0)).toBeGreaterThan(0);
    }
  });
});

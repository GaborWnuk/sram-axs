/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * Timer access without committing to a platform.
 *
 * The package compiles with `types: []` and `lib: ES2020` so nothing DOM- or
 * Node-specific leaks into a React Native consumer's type graph. That also
 * means `setTimeout` and friends are not declared, hence this shim.
 *
 * The globals are resolved *at call time*, not captured at module load. Test
 * runners install fake timers by replacing the globals after modules are
 * imported, so capturing early would silently opt this package out of them.
 */

/** Opaque handle. Node returns an object, browsers and Hermes return a number. */
export type TimerHandle = unknown;

interface TimerGlobals {
  setTimeout(handler: () => void, ms?: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(handler: () => void, ms?: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

function globals(): TimerGlobals {
  // Under `types: []` this file's own program declares no timers at all — the
  // whole reason the shim exists — so the assertion is what makes it compile
  // standalone. `typecheck:lib` fails without it.
  //
  // ESLint disagrees because its type-aware program also contains the test
  // files, and a test importing vitest pulls ambient Node types in, at which
  // point `globalThis` really does satisfy TimerGlobals. That wider view is
  // exactly the borrowed context this shim must not depend on.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return globalThis as unknown as TimerGlobals;
}

export function setTimeoutCompat(handler: () => void, ms: number): TimerHandle {
  return globals().setTimeout(handler, ms);
}

export function clearTimeoutCompat(handle: TimerHandle): void {
  globals().clearTimeout(handle);
}

export function setIntervalCompat(handler: () => void, ms: number): TimerHandle {
  return globals().setInterval(handler, ms);
}

export function clearIntervalCompat(handle: TimerHandle): void {
  globals().clearInterval(handle);
}

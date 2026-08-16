/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * Domain reducers — how component-specific state gets folded in.
 *
 * `StateAggregator` used to know what a gear was. It read `gearRear` out of a
 * decoding, counted shifts, and wrapped the component's own shift counter at
 * 256, all inline. That made it the wrong shape for a platform: teaching the
 * library about a dropper post meant editing the aggregator, which is exactly
 * the coupling the keyless decoder registry was built to avoid.
 *
 * Now the aggregator knows two things only: values carry provenance, and a more
 * confident reading wins. What those values *mean* lives in a reducer, which
 * declares the decoded fields it reacts to and owns one slice of state.
 *
 * ## Adding a domain
 *
 * ```ts
 * export const dropperDomain = defineDomain<DropperDomain>({
 *   domain: "dropper",
 *   consumes: ["postPosition"],
 *   create: () => ({ position: null }),
 *   ingest(state, ctx) { … },
 * });
 * ```
 *
 * A domain appears in `state.domains` only once a reducer has actually folded
 * something into it, so a dropper post never carries an empty drivetrain and a
 * UI can ask which domains a component reports rather than probing for nulls.
 */

/** Provenance of a single state value. */
export interface ValueSource<T> {
  value: T;
  /** Decoder that produced it. */
  decoder: string;
  /** 0..1, carried through from the decoder. */
  confidence: number;
  /** When it was last updated, ms since epoch. */
  updatedAt: number;
}

/** Outcome of arbitrating a new value against the one held. */
export interface StoredValue<T> {
  value: ValueSource<T>;
  /**
   * Whether this is a *semantic* change.
   *
   * Re-storing an identical value refreshes provenance, so staleness checks
   * stay accurate, but reports no change — without which a 4 Hz rebroadcast of
   * an unchanged gear would re-render a UI four times a second.
   */
  changed: boolean;
}

/**
 * Events a reducer may raise.
 *
 * `shift` is here rather than in the drivetrain module because consumers
 * subscribe to it on the aggregator, and moving it would break them for no
 * gain. A component family with its own event adds an entry here; the
 * aggregator still never inspects the payload.
 */
export interface DomainEvents extends Record<string, unknown> {
  shift: { from: number | null; to: number | null; totalShifts: number };
}

/** What a reducer is given for one decoding of one frame. */
export interface DomainContext {
  /** The decoded fields. Open by design — decoders invent their own names. */
  readonly fields: Record<string, unknown>;
  /** Name of the decoder that produced them. */
  readonly decoder: string;
  /** Its confidence, 0..1. */
  readonly confidence: number;
  /** Frame timestamp, ms since epoch. */
  readonly timestamp: number;

  /**
   * Arbitrate a value against the one already held.
   *
   * Returns null when the stored value is more confident, so a speculative
   * heuristic can never overwrite a confirmed reading whatever order they
   * arrive in.
   */
  store<T>(existing: ValueSource<T> | null, value: T): StoredValue<T> | null;

  /** Read a decoded field, when it is a number. */
  number(field: string): number | undefined;

  /** Raise an event on the aggregator. */
  emit<K extends keyof DomainEvents>(event: K, payload: DomainEvents[K]): void;
}

/** How a domain is *written*. */
export interface DomainReducer<S> {
  /** Key this domain occupies in `state.domains`. */
  domain: string;
  /**
   * Decoded field names this reducer reacts to.
   *
   * A cheap filter: a decoding carrying none of them skips the reducer, which
   * is also what stops an empty domain appearing for a component that does not
   * report one.
   */
  consumes: readonly string[];
  /** Empty state for this domain. */
  create(): S;
  /** Fold one decoding in. Return true if anything semantically changed. */
  ingest(state: S, context: DomainContext): boolean;
}

/**
 * How a domain is *held* — the reducer with its state type sealed in.
 *
 * Same reason as `defineMessage`: a list of reducers over different state
 * types cannot be described by one `DomainReducer<S>`, and erasing the
 * difference with a cast at every call site is worse than sealing it once.
 */
export interface AnyDomainReducer {
  domain: string;
  consumes: readonly string[];
  create(): unknown;
  ingest(state: unknown, context: DomainContext): boolean;
}

/** Seal a reducer's state type so it can sit in a registry alongside others. */
export function defineDomain<S>(reducer: DomainReducer<S>): AnyDomainReducer {
  return {
    domain: reducer.domain,
    consumes: reducer.consumes,
    create: () => reducer.create(),
    ingest: (state, context) => reducer.ingest(state as S, context),
  };
}

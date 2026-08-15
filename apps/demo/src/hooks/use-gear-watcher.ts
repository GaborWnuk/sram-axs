/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * React binding for {@link GearWatcher}.
 *
 * The watcher already owns the hard parts — connecting, polling, decrypting and
 * reconnecting — so this hook only has to mirror its events into state and make
 * sure the watcher is stopped when the screen goes away.
 *
 * Rendering note: `reading` fires about four times a second, and re-rendering a
 * screen at that rate to redraw an unchanged number is wasted work. Only the
 * `gear` event (which fires on *change*) drives the gear state; the raw reading
 * is kept in a ref for anything that wants it without forcing a render.
 */

import { useEffect, useRef, useState } from "react";
import {
  GearWatcher,
  type BleTransport,
  type GearReading,
  type GearWatcherStatus,
} from "@axs/core";

import { loadDeviceKey } from "../key-store";

export interface UseGearWatcher {
  /** Current rear gear, or null before the first successful decode. */
  gear: number | null;
  /** Connection state, for a status indicator. */
  status: GearWatcherStatus;
  /** Consecutive reconnect attempts; 0 while connected. */
  attempt: number;
  /** Most recent non-fatal problem, or null. */
  warning: string | null;
  /** Latest full reading, updated without forcing a re-render. */
  latest: () => GearReading | null;
}

/**
 * Watch live gear on a component.
 *
 * Pass `deviceKey: null` while the component is unpaired — the hook simply does
 * nothing until a key arrives, so a screen can render its pairing UI first and
 * start reading the moment bonding completes.
 */
export function useGearWatcher(
  transport: BleTransport | null,
  deviceId: string | null,
  deviceKey: Uint8Array | null,
  options: { pollIntervalMs?: number; enabled?: boolean } = {},
): UseGearWatcher {
  const { pollIntervalMs = 250, enabled = true } = options;

  const [gear, setGear] = useState<number | null>(null);
  const [status, setStatus] = useState<GearWatcherStatus>("stopped");
  const [attempt, setAttempt] = useState(0);
  const [warning, setWarning] = useState<string | null>(null);
  const latestRef = useRef<GearReading | null>(null);

  useEffect(() => {
    if (!transport || !deviceId || !deviceKey || !enabled) return;

    const watcher = new GearWatcher(transport, deviceId, { deviceKey, pollIntervalMs });

    const offGear = watcher.events.on("gear", ({ gear: value }) => setGear(value));
    const offReading = watcher.events.on("reading", (reading) => {
      latestRef.current = reading;
    });
    const offStatus = watcher.events.on("status", (event) => {
      setStatus(event.status);
      setAttempt(event.attempt);
      // A successful connection clears any stale warning from the last drop.
      if (event.status === "connected") setWarning(null);
    });
    const offWarning = watcher.events.on("warning", ({ message }) => setWarning(message));

    watcher.start();

    return () => {
      offGear();
      offReading();
      offStatus();
      offWarning();
      void watcher.stop();
      setStatus("stopped");
      setAttempt(0);
    };
  }, [transport, deviceId, deviceKey, pollIntervalMs, enabled]);

  return {
    gear,
    status,
    attempt,
    warning,
    latest: () => latestRef.current,
  };
}

/**
 * Load a component's stored bond key, if it has been paired on this device.
 *
 * Returns `undefined` while loading and `null` when no key is stored, so a
 * screen can tell "still checking" apart from "not paired".
 */
export function useStoredDeviceKey(deviceId: string | null): Uint8Array | null | undefined {
  const [key, setKey] = useState<Uint8Array | null | undefined>(undefined);

  useEffect(() => {
    if (!deviceId) {
      setKey(null);
      return;
    }
    let cancelled = false;
    void loadDeviceKey(deviceId).then((stored) => {
      if (!cancelled) setKey(stored);
    });
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  return key;
}

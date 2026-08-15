/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * GPS speed via expo-location.
 *
 * Speed comes straight from the location provider's Doppler estimate where
 * available, which is far more stable than differentiating positions. It is
 * reported in m/s and can be null or negative when unavailable, so those cases
 * are normalised away here rather than in the UI.
 */

import { useEffect, useRef, useState } from "react";
import * as Location from "expo-location";

export interface GpsState {
  /** Metres per second, or null when unknown. */
  speedMps: number | null;
  /** Kilometres per hour, or null when unknown. */
  speedKph: number | null;
  accuracyM: number | null;
  latitude: number | null;
  longitude: number | null;
  permissionGranted: boolean | null;
  error: string | null;
}

const INITIAL: GpsState = {
  speedMps: null,
  speedKph: null,
  accuracyM: null,
  latitude: null,
  longitude: null,
  permissionGranted: null,
  error: null,
};

export function useGpsSpeed(enabled = true): GpsState {
  const [state, setState] = useState<GpsState>(INITIAL);
  const subscriptionRef = useRef<Location.LocationSubscription | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    void (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (cancelled) return;

        if (status !== "granted") {
          setState((previous) => ({
            ...previous,
            permissionGranted: false,
            error: "Location permission denied",
          }));
          return;
        }

        setState((previous) => ({ ...previous, permissionGranted: true }));

        subscriptionRef.current = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.BestForNavigation,
            timeInterval: 1000,
            distanceInterval: 0,
          },
          (location) => {
            const raw = location.coords.speed;
            // Providers report -1 (or null) when they have no speed fix.
            const speedMps = raw !== null && raw >= 0 ? raw : null;

            setState({
              speedMps,
              speedKph: speedMps === null ? null : speedMps * 3.6,
              accuracyM: location.coords.accuracy ?? null,
              latitude: location.coords.latitude,
              longitude: location.coords.longitude,
              permissionGranted: true,
              error: null,
            });
          },
        );
      } catch (caught) {
        if (!cancelled) {
          setState((previous) => ({
            ...previous,
            error: caught instanceof Error ? caught.message : String(caught),
          }));
        }
      }
    })();

    return () => {
      cancelled = true;
      subscriptionRef.current?.remove();
      subscriptionRef.current = null;
    };
  }, [enabled]);

  return state;
}

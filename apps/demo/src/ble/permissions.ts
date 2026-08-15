/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * Runtime Bluetooth permissions on Android.
 *
 * Android 12 (API 31) split Bluetooth out of the location permission group:
 * scanning needs `BLUETOOTH_SCAN` and connecting needs `BLUETOOTH_CONNECT`,
 * both granted at runtime. Older releases have neither and gate BLE scanning
 * behind fine location instead.
 *
 * This matters more than it looks: without the grant the radio does not error,
 * it simply never reports a device, which reads as "no AXS component nearby"
 * rather than as a permission problem. Asking up front turns a silent failure
 * into an explicit one.
 *
 * iOS asks for its own permission via the usage description declared in
 * `app.json`, so there is nothing to do there.
 */

import { PermissionsAndroid, Platform, type Permission } from "react-native";

/** `android.permission.BLUETOOTH_SCAN` → `BLUETOOTH_SCAN`, for error messages. */
function shortName(permission: string): string {
  return permission.replace(/^android\.permission\./, "");
}

/**
 * Ensure the permissions BLE needs are granted, prompting if necessary.
 *
 * Resolves when everything needed is granted, and throws with an actionable
 * message when the rider declines. Safe to call before every scan — Android
 * only shows a dialog when something is actually missing.
 */
export async function requestBlePermissions(): Promise<void> {
  if (Platform.OS !== "android") return;

  const required: Permission[] =
    Number(Platform.Version) >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

  const results = await PermissionsAndroid.requestMultiple(required);

  const denied = required.filter(
    (permission) => results[permission] !== PermissionsAndroid.RESULTS.GRANTED,
  );

  if (denied.length > 0) {
    throw new Error(
      `Bluetooth permission denied (${denied.map(shortName).join(", ")}). ` +
        "Grant it in Settings › Apps › AXS Probe › Permissions, then scan again.",
    );
  }
}

/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * Persistent storage for SRAMBond device keys.
 *
 * A bond key is a credential: anyone holding it, within Bluetooth range of the
 * component, can read its live state. It is stored in the platform keychain
 * (Keychain on iOS, EncryptedSharedPreferences on Android) rather than in plain
 * app storage.
 *
 * Keys are worth persisting because bonding is not free: each create-bond makes
 * the component mint a *fresh* key and invalidates the previous one, and it
 * requires the rider to physically hold the AXS button. Pair once, store the
 * key, and every later session is an ordinary read-only connection.
 */

import * as SecureStore from "expo-secure-store";
import { fromHex, toHex } from "@axs/core";

/** SecureStore keys must be alphanumeric plus `.-_`; device ids may not be. */
function storageKey(deviceId: string): string {
  return `axs_key_${deviceId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/** The stored key for a component, or null if it has never been paired here. */
export async function loadDeviceKey(deviceId: string): Promise<Uint8Array | null> {
  try {
    const hex = await SecureStore.getItemAsync(storageKey(deviceId));
    if (!hex) return null;
    const key = fromHex(hex);
    // A truncated or corrupt entry is worse than none: it would fail every
    // decrypt with a confusing "wrong key" error.
    return key.length === 16 ? key : null;
  } catch {
    // Keychain unavailable (for example, a simulator with no entitlements).
    return null;
  }
}

/** Persist the key produced by a successful bond. */
export async function saveDeviceKey(deviceId: string, key: Uint8Array): Promise<void> {
  await SecureStore.setItemAsync(storageKey(deviceId), toHex(key, ""));
}

/** Forget a component's key, so the next connection has to pair again. */
export async function forgetDeviceKey(deviceId: string): Promise<void> {
  await SecureStore.deleteItemAsync(storageKey(deviceId));
}

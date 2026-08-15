/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * SRAMBond pairing, as a screen-friendly state machine.
 *
 * The handshake itself is one call — {@link createBond} — but the UI around it
 * has a human in the loop: the component only accepts a new bond while it is
 * physically in pairing mode, which the rider enters by holding the AXS button
 * until the light blinks. `createBond` supports that directly through
 * `waitForPairingMode`, which this hook resolves when the rider taps "Ready".
 *
 * The resulting key is persisted (see `key-store`), because bonding re-keys the
 * component: pairing a second time silently invalidates the first key.
 */

import { useCallback, useRef, useState } from "react";
import * as Crypto from "expo-crypto";
import { createBond, type BleTransport } from "@axs/core";

import { loadDeviceKey, saveDeviceKey } from "../key-store";

/** Where the pairing flow currently is. */
export type PairingStage =
  | "idle"
  | "connecting"
  /** Waiting for the rider to put the component into pairing mode. */
  | "awaiting-button"
  | "exchanging"
  | "paired"
  | "failed";

export interface UsePairing {
  stage: PairingStage;
  /** Progress line from the handshake, for a detail label. */
  step: string | null;
  error: string | null;
  /** The stored or freshly negotiated key, once known. */
  deviceKey: Uint8Array | null;

  /** Load a previously stored key, if this component has been paired before. */
  restore: (deviceId: string) => Promise<Uint8Array | null>;
  /** Begin pairing. Resolves when the handshake ends, successfully or not. */
  pair: (deviceId: string) => Promise<void>;
  /** Call when the rider confirms the light is blinking. */
  confirmPairingMode: () => void;
  /** Discard state so the screen can offer pairing again. */
  reset: () => void;
}

/**
 * Cryptographically-random bytes for the ephemeral Diffie-Hellman key.
 *
 * `crypto.getRandomValues` does not exist under Hermes, so this uses Expo's
 * native CSPRNG rather than the web API. `Math.random` would be a real
 * vulnerability here — the private key must be unguessable.
 */
function randomBytes(length: number): Uint8Array {
  return Crypto.getRandomBytes(length);
}

export function usePairing(transport: BleTransport | null): UsePairing {
  const [stage, setStage] = useState<PairingStage>("idle");
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deviceKey, setDeviceKey] = useState<Uint8Array | null>(null);

  // Resolver for the "Ready" tap, handed to createBond via waitForPairingMode.
  const buttonConfirmed = useRef<(() => void) | null>(null);

  const restore = useCallback(async (deviceId: string) => {
    const stored = await loadDeviceKey(deviceId);
    if (stored) {
      setDeviceKey(stored);
      setStage("paired");
    }
    return stored;
  }, []);

  const confirmPairingMode = useCallback(() => {
    buttonConfirmed.current?.();
    buttonConfirmed.current = null;
  }, []);

  const pair = useCallback(
    async (deviceId: string) => {
      if (!transport) {
        setError("No Bluetooth transport available.");
        setStage("failed");
        return;
      }

      setError(null);
      setStep(null);
      setStage("connecting");

      let peripheral;
      try {
        peripheral = await transport.connect(deviceId);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        setStage("failed");
        return;
      }

      try {
        const key = await createBond(peripheral, {
          randomBytes,
          waitForPairingMode: () => {
            setStage("awaiting-button");
            return new Promise<void>((resolve) => {
              buttonConfirmed.current = () => {
                setStage("exchanging");
                resolve();
              };
            });
          },
          onStep: setStep,
        });

        await saveDeviceKey(deviceId, key);
        setDeviceKey(key);
        setStage("paired");
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        // By far the most common cause is the component having left pairing
        // mode, so say that rather than surfacing a bare GATT error.
        setError(
          /not permitted|no response|timed out/i.test(message)
            ? `${message}\n\nThe component may have left pairing mode — hold the AXS button until it blinks, then try again.`
            : message,
        );
        setStage("failed");
      } finally {
        buttonConfirmed.current = null;
        // Hand the link back: the gear watcher opens its own connection, and
        // AXS components serve one central at a time.
        try {
          await peripheral.disconnect();
        } catch {
          // Already gone.
        }
      }
    },
    [transport],
  );

  const reset = useCallback(() => {
    buttonConfirmed.current = null;
    setStage("idle");
    setStep(null);
    setError(null);
  }, []);

  return { stage, step, error, deviceKey, restore, pair, confirmPairingMode, reset };
}

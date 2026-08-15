/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

import { describe, expect, it, vi } from "vitest";

import { fromHex, toHex } from "../bytes.js";
import { FakeTransport, SIMULATOR_DEVICE_KEY } from "../testing/fake-transport.js";
import type { ConnectedPeripheral } from "../transport.js";
import { LIVE_STATE_CHARACTERISTIC, decodeSrambondState } from "./srambond.js";
import {
  SRAMBOND_FINALIZE,
  SRAMBOND_INIT,
  SRAMBOND_V1_CHARACTERISTIC,
  SRAMBOND_V1_SERVICE,
  computePublicKey,
  computeSharedSecret,
  createBond,
  decryptTransportedKey,
} from "./srambond-bond.js";

/**
 * Known-answer vectors captured from a real RD-GX-E-B1 during two offline
 * create-bonds (airplane mode, wiped cache). Every value below is exactly what
 * the reference implementation produced — this proves the pure-TS handshake
 * reproduces SRAMBond byte-for-byte.
 */
const VECTORS = [
  {
    name: "run A (gear 12)",
    privateKey: "6418b20cb4e1d4cf4af19b184aff1d2a",
    publicKey: "297ca1db5827261af813875fd09800b0",
    devicePublicKey: "9ac11ad0a4f6c2b99c5559e2d210c410",
    sharedSecret: "55406a336a328156b81019d7ac3d5d24",
    transportBlob:
      "8d7a16ed42128ee445b9864f20324a0e0b9e1982be7a9ad3cf611f453696fa8d2f24f1878c44eb7f77ff5b4a3c616395",
    deviceKey: "b0690781867fde13ac1b9d30bbb4004f",
  },
  {
    name: "run B (gear 7)",
    privateKey: "8a70324e70f985885fd044e4063b8fde",
    publicKey: "3fc4016fb610c262941f3322f3d50a87",
    devicePublicKey: "e2f360ca83473398459754f34ffa9fe4",
    sharedSecret: "26faae0037d2e38fb2e423eaff9b7f87",
    transportBlob:
      "e596006bbf8f0f0409cd214a43bbbaa008df6356f8f4d27d217394da4545a92253bb49b6726846bdacdadb006eaeab1d",
    deviceKey: "2996c00a7361a9a011815e01e46bb354",
  },
];

describe("SRAMBond DH + key transport (real captured handshakes)", () => {
  for (const v of VECTORS) {
    describe(v.name, () => {
      it("derives the client public key: g^priv mod p", () => {
        expect(toHex(computePublicKey(fromHex(v.privateKey)), "")).toBe(v.publicKey);
      });

      it("derives the shared secret: devicePublic^priv mod p", () => {
        expect(toHex(computeSharedSecret(fromHex(v.privateKey), fromHex(v.devicePublicKey)), "")).toBe(
          v.sharedSecret,
        );
      });

      it("unwraps the transported device key with the shared secret", () => {
        const key = decryptTransportedKey(fromHex(v.sharedSecret), fromHex(v.transportBlob));
        expect(toHex(key, "")).toBe(v.deviceKey);
      });
    });
  }
});

describe("createBond orchestration", () => {
  it("runs init → pubkey → notify → transport → finalize and returns the device key", async () => {
    const v = VECTORS[0]!;
    const writes: Array<{ uuid: string; value: string }> = [];

    // Real hardware answers on d905ee52 by **notification** — the characteristic
    // is not readable. The fake mirrors that: each write is answered with the
    // next scripted value, delivered through the subscription.
    const responses = [fromHex(v.devicePublicKey), fromHex(v.transportBlob)];
    let notify: ((value: Uint8Array) => void) | null = null;

    const peripheral = {
      id: "test",
      name: "GX RD",
      discoverServices: vi.fn(),
      read: vi.fn(() => Promise.reject(new Error("Reading is not permitted."))),
      write: vi.fn((_s: string, c: string, value: Uint8Array) => {
        writes.push({ uuid: c, value: toHex(value, "") });
        const next = responses.shift();
        if (next && notify) setTimeout(() => notify?.(next), 0);
        return Promise.resolve();
      }),
      subscribe: vi.fn((_s: string, _c: string, onValue: (v: Uint8Array) => void) => {
        notify = onValue;
        return Promise.resolve(() => {
          notify = null;
        });
      }),
      mtu: () => 23,
      onDisconnected: () => () => {},
      disconnect: vi.fn(),
    } as unknown as ConnectedPeripheral;

    const deviceKey = await createBond(peripheral, {
      // Deterministic "random" so the derived public key matches the vector.
      randomBytes: () => fromHex(v.privateKey),
    });

    expect(toHex(deviceKey, "")).toBe(v.deviceKey);
    // The three writes, in order: init, client public key, finalize.
    expect(writes[0]!.value).toBe(toHex(SRAMBOND_INIT, ""));
    expect(writes[1]!.value).toBe(v.publicKey);
    expect(writes[2]!.value).toBe(toHex(SRAMBOND_FINALIZE, ""));
  });

  it("fails with a clear message when the component never answers", async () => {
    const peripheral = {
      id: "test",
      name: "GX RD",
      discoverServices: vi.fn(),
      read: vi.fn(() => Promise.reject(new Error("Reading is not permitted."))),
      write: vi.fn(() => Promise.resolve()),
      subscribe: vi.fn(() => Promise.resolve(() => {})),
      mtu: () => 23,
      onDisconnected: () => () => {},
      disconnect: vi.fn(),
    } as unknown as ConnectedPeripheral;

    await expect(
      createBond(peripheral, {
        randomBytes: () => fromHex(VECTORS[0]!.privateKey),
        timeoutMs: 10,
      }),
    ).rejects.toThrow(/no response .* not readable/s);
  });
});

/**
 * The simulator implements the component half of the handshake. Running the
 * real client against it end to end proves the two halves agree, and that the
 * key pairing yields is the one the live-state channel is actually encrypted
 * with — which is what makes the demo app's Simulator mode meaningful.
 */
describe("createBond against the simulated component", () => {
  it("completes the handshake and returns the live-state key", async () => {
    const transport = new FakeTransport();
    const peripheral = await transport.connect("sim-rd-0001");

    const deviceKey = await createBond(peripheral, {
      randomBytes: () => fromHex(VECTORS[0]!.privateKey),
      timeoutMs: 1000,
    });

    expect(toHex(deviceKey, "")).toBe(toHex(SIMULATOR_DEVICE_KEY, ""));
  });

  it("decrypts real gear with the key it negotiated", async () => {
    const transport = new FakeTransport();
    const peripheral = await transport.connect("sim-rd-0001");

    const deviceKey = await createBond(peripheral, {
      randomBytes: () => fromHex(VECTORS[1]!.privateKey),
      timeoutMs: 1000,
    });

    const frame = await peripheral.read(
      "d9050001-90aa-4c7c-b036-1e01fb8eb7ee",
      LIVE_STATE_CHARACTERISTIC,
    );
    const state = decodeSrambondState(deviceKey, frame);

    expect(state.gearRear).toBeGreaterThanOrEqual(1);
    expect(state.gearRear).toBeLessThanOrEqual(12);
  });

  it("ignores a public key that was not preceded by init", async () => {
    const transport = new FakeTransport();
    const peripheral = await transport.connect("sim-rd-0001");

    const received: Uint8Array[] = [];
    await peripheral.subscribe(SRAMBOND_V1_SERVICE, SRAMBOND_V1_CHARACTERISTIC, (v) =>
      received.push(v),
    );

    await peripheral.write(
      SRAMBOND_V1_SERVICE,
      SRAMBOND_V1_CHARACTERISTIC,
      fromHex(VECTORS[0]!.publicKey),
      true,
    );

    expect(received).toHaveLength(0);
  });
});

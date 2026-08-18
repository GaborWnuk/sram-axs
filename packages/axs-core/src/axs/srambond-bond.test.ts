/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

import { describe, expect, it, vi } from "vitest";

import { bigIntToBytes } from "../crypto/dh.js";
import { eaxEncrypt } from "../crypto/aes-eax.js";
import { fromHex, toHex } from "../bytes.js";
import { FakeTransport, SIMULATOR_DEVICE_KEY, simulatedDerailleur } from "../testing/fake-transport.js";
import type { FakeCharacteristicSpec, FakeDeviceSpec } from "../testing/fake-transport.js";
import { DEVICE_INFORMATION_SERVICE, DIS_CHARACTERISTICS } from "../gatt/uuids.js";
import type { ConnectedPeripheral } from "../transport.js";
import { LIVE_STATE_CHARACTERISTIC, decodeSrambondState } from "./srambond.js";
import {
  SRAMBOND_FINALIZE,
  SRAMBOND_INIT,
  SRAMBOND_MODULUS,
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

/**
 * Input validation on the one path in this library that writes to hardware.
 *
 * The handshake is unauthenticated by protocol design — the physical AXS-button
 * gate is what actually protects it — so none of this is a break being fixed.
 * It is defence in depth on values that arrive over a radio, plus failing at
 * the point of the fault rather than three steps later as a tag mismatch.
 */
describe("handshake input validation", () => {
  const goodPrivate = new Uint8Array(16).fill(0x33);
  const goodPeer = computePublicKey(new Uint8Array(16).fill(0x44));

  it("rejects a device public key that is not one key wide", () => {
    // A fragmented or truncated notification does not round — it becomes a
    // different integer, and therefore a different (wrong) shared secret.
    for (const wrong of [new Uint8Array(0), new Uint8Array(4), new Uint8Array(15), new Uint8Array(32)]) {
      expect(() => computeSharedSecret(goodPrivate, wrong)).toThrow(/must be 16 bytes/);
    }
  });

  it("rejects degenerate device public keys", () => {
    const of = (n: bigint) => bigIntToBytes(n, 16, "be");
    // 0 and 1 are fixed points under exponentiation; p-1 collapses to ±1. Each
    // lets the peer pin the "shared" secret to a value it already knows.
    for (const degenerate of [0n, 1n, SRAMBOND_MODULUS - 1n]) {
      expect(() => computeSharedSecret(goodPrivate, of(degenerate))).toThrow(/degenerate or out of range/);
    }
    // At or above the modulus is not a group element at all.
    expect(() => computeSharedSecret(goodPrivate, of(SRAMBOND_MODULUS))).toThrow(/degenerate or out of range/);
  });

  it("still derives a secret from a well-formed peer key", () => {
    expect(computeSharedSecret(goodPrivate, goodPeer)).toHaveLength(16);
  });

  it("rejects a private key that is not one key wide", () => {
    expect(() => computePublicKey(new Uint8Array(8))).toThrow(/private key must be 16 bytes/);
    expect(() => computeSharedSecret(new Uint8Array(8), goodPeer)).toThrow(/private key must be 16 bytes/);
  });

  it("rejects a transport blob that is not exactly 48 bytes", () => {
    const secret = new Uint8Array(16).fill(0x11);
    for (const n of [0, 32, 47, 49, 64]) {
      expect(() => decryptTransportedKey(secret, new Uint8Array(n))).toThrow(/must be 48 bytes/);
    }
  });

  it("does not accept a correctly-tagged empty blob as a key", () => {
    // The old `length < 32` guard let this through: 16-byte nonce, no
    // ciphertext, 16-byte tag that verifies — a zero-length key, reported as
    // success. Length is the only thing that catches it, since the tag is valid.
    const secret = new Uint8Array(16).fill(0x11);
    const nonce = new Uint8Array(16).fill(0x22);
    const sealedEmpty = eaxEncrypt(secret, nonce, new Uint8Array(0), { tagLength: 16 });

    const blob32 = new Uint8Array(32);
    blob32.set(nonce, 0);
    blob32.set(sealedEmpty, 16);

    expect(() => decryptTransportedKey(secret, blob32)).toThrow(/must be 48 bytes/);
  });

  it("rejects a randomBytes implementation that returns the wrong length", async () => {
    const transport = new FakeTransport([simulatedDerailleur()]);
    const peripheral = await transport.connect("sim-rd-0001");

    await expect(
      createBond(peripheral, { randomBytes: () => new Uint8Array(8) }),
    ).rejects.toThrow(/returned 8 bytes/);

    await peripheral.disconnect();
  });
});

/**
 * The orchestration around the handshake, rather than the maths inside it.
 *
 * These paths only run against awkward hardware — a component that answers a
 * read instead of notifying, one that splits the 48-byte blob across
 * notifications, or a rider who takes their time reaching the bike — so none of
 * them was exercised, which is exactly why they are worth pinning.
 */
describe("createBond orchestration against awkward components", () => {
  /** A SRAMBond service whose responses are supplied by the test. */
  function bondDevice(spec: Partial<FakeCharacteristicSpec>): FakeDeviceSpec {
    return {
      id: "sim-bond",
      name: "SRAM 1234567890",
      services: [
        {
          uuid: DEVICE_INFORMATION_SERVICE,
          characteristics: [
            { uuid: DIS_CHARACTERISTICS.manufacturerName, value: fromHex("53 52 41 4d"), properties: { read: true } },
          ],
        },
        {
          uuid: SRAMBOND_V1_SERVICE,
          characteristics: [
            { uuid: SRAMBOND_V1_CHARACTERISTIC, properties: { write: true, notify: true }, ...spec },
          ],
        },
      ],
    };
  }

  /** Device half of the handshake: its key pair, and the blob it hands back. */
  function deviceSide() {
    const devicePrivate = new Uint8Array(16).fill(0x5a);
    const devicePublic = computePublicKey(devicePrivate);
    const liveStateKey = new Uint8Array(16).fill(0xc3);

    const blobFor = (clientPublic: Uint8Array) => {
      const shared = computeSharedSecret(devicePrivate, clientPublic);
      const nonce = new Uint8Array(16).fill(0x77);
      const sealed = eaxEncrypt(shared, nonce, liveStateKey, { tagLength: 16 });
      const blob = new Uint8Array(48);
      blob.set(nonce, 0);
      blob.set(sealed, 16);
      return blob;
    };
    return { devicePublic, liveStateKey, blobFor };
  }

  it("falls back to a plain read when the component never notifies", async () => {
    // Some stacks expose the characteristic as readable rather than pushing a
    // notification. The handshake has to survive that without hanging.
    const { devicePublic, liveStateKey, blobFor } = deviceSide();
    let clientPublic = new Uint8Array(16);
    let stage = 0;

    const transport = new FakeTransport([
      bondDevice({
        properties: { read: true, write: true, notify: true },
        onWrite: (value) => {
          if (value.length === 16 && value[0] !== 0x00) clientPublic = new Uint8Array(value);
        },
        // Never notifies; answers reads in handshake order instead.
        readGenerator: () => (stage++ === 0 ? devicePublic : blobFor(clientPublic)),
      }),
    ]);

    const peripheral = await transport.connect("sim-bond");
    const key = await createBond(peripheral, {
      randomBytes: () => new Uint8Array(16).fill(0x11),
      timeoutMs: 20,
    });

    expect(toHex(key, "")).toBe(toHex(liveStateKey, ""));
    await peripheral.disconnect();
  });

  it("reassembles a transport blob split across notifications", async () => {
    // BLE delivers at most one MTU per notification, so a 48-byte blob can
    // arrive in pieces. Accumulating them is the difference between working and
    // failing on a shorter-MTU phone.
    const { devicePublic, liveStateKey, blobFor } = deviceSide();
    let clientPublic = new Uint8Array(16);

    const transport = new FakeTransport([
      bondDevice({
        onWrite: (value, notify) => {
          if (value.length === 16 && value[0] === 0x00) return; // init
          if (value.length !== 16) return;
          clientPublic = new Uint8Array(value);
          notify(devicePublic);
          const blob = blobFor(clientPublic);
          notify(blob.subarray(0, 20));
          notify(blob.subarray(20, 41));
          notify(blob.subarray(41));
        },
      }),
    ]);

    const peripheral = await transport.connect("sim-bond");
    const key = await createBond(peripheral, {
      randomBytes: () => new Uint8Array(16).fill(0x11),
      timeoutMs: 50,
    });

    expect(toHex(key, "")).toBe(toHex(liveStateKey, ""));
    await peripheral.disconnect();
  });

  it("gives up rather than reading forever when the blob never completes", async () => {
    // A component answering with zero-length values makes no progress: the blob
    // never grows and nothing ever times out, so only a ceiling ends it. The
    // error has to name the real problem rather than surfacing later as a tag
    // mismatch, which points at the crypto instead of the transfer.
    const { devicePublic } = deviceSide();

    const transport = new FakeTransport([
      bondDevice({
        onWrite: (value, notify) => {
          if (value.length !== 16 || value[0] === 0x00) return;
          notify(devicePublic);
          for (let i = 0; i < 200; i++) notify(new Uint8Array(0));
        },
      }),
    ]);

    const peripheral = await transport.connect("sim-bond");
    await expect(
      createBond(peripheral, { randomBytes: () => new Uint8Array(16).fill(0x11), timeoutMs: 20 }),
    ).rejects.toThrow(/still 0 bytes after 8 reads/);

    await peripheral.disconnect();
  });

  it("keeps the link warm while waiting for the rider to press the button", async () => {
    // The component hangs up an idle link at about three minutes, which is
    // easily less than a rider takes to walk to the bike. A periodic read of a
    // harmless characteristic is what stops the wait killing the handshake.
    vi.useFakeTimers();
    try {
      const { devicePublic, blobFor } = deviceSide();
      let clientPublic = new Uint8Array(16);

      const transport = new FakeTransport([
        bondDevice({
          onWrite: (value, notify) => {
            if (value.length !== 16 || value[0] === 0x00) return;
            clientPublic = new Uint8Array(value);
            notify(devicePublic);
            notify(blobFor(clientPublic));
          },
        }),
      ]);

      const peripheral = await transport.connect("sim-bond");
      const reads = vi.spyOn(peripheral, "read");

      let release!: () => void;
      const pending = createBond(peripheral, {
        randomBytes: () => new Uint8Array(16).fill(0x11),
        keepAliveIntervalMs: 1000,
        waitForPairingMode: () => new Promise<void>((r) => { release = r; }),
      });

      await vi.advanceTimersByTimeAsync(3500);
      const keepAlives = reads.mock.calls.filter(
        ([, chr]) => chr === DIS_CHARACTERISTICS.manufacturerName,
      ).length;
      expect(keepAlives).toBeGreaterThanOrEqual(3);

      release();
      await vi.advanceTimersByTimeAsync(50);
      await pending;

      // And the interval must stop once the wait is over, or it outlives the bond.
      const after = reads.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(reads.mock.calls.length).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves no timers armed when a response arrives before its timeout", async () => {
    // Every awaited response arms a timeout and races it against the
    // notification. When the notification wins, the timer has to be cancelled —
    // otherwise each step leaves one armed for the full timeout, which on a
    // phone keeps work scheduled long after the bond finished.
    vi.useFakeTimers();
    try {
      const { devicePublic, blobFor } = deviceSide();
      let clientPublic = new Uint8Array(16);

      const transport = new FakeTransport([
        bondDevice({
          // Answer late enough that createBond actually waits, rather than
          // finding the value already queued.
          onWrite: (value, notify) => {
            if (value.length !== 16 || value[0] === 0x00) return;
            clientPublic = new Uint8Array(value);
            setTimeout(() => {
              notify(devicePublic);
              setTimeout(() => notify(blobFor(clientPublic)), 5);
            }, 5);
          },
        }),
      ]);

      const peripheral = await transport.connect("sim-bond");
      const baseline = vi.getTimerCount();

      const pending = createBond(peripheral, {
        randomBytes: () => new Uint8Array(16).fill(0x11),
        timeoutMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(50);
      await pending;

      // With 60s timeouts, an uncancelled timer per awaited response would
      // still be armed here long after the handshake returned.
      expect(vi.getTimerCount()).toBe(baseline);

      await peripheral.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });
});

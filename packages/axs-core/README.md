# @gaborwnuk/axs-core

Transport-agnostic library for reading **SRAM AXS** components over Bluetooth Low
Energy: identification, GATT reconnaissance, the SRAMBond pairing handshake, and
decrypting live drivetrain state — including **current gear**.

Zero runtime dependencies. No native modules. Pure TypeScript that runs unmodified
under Hermes, so it works in React Native, plain Node and the browser.

> The AXS BLE protocol is not publicly documented. Everything this library
> implements was worked out by observing a real component and is verified against
> captured hardware data in the test suite. See [`PROTOCOL.md`](../../PROTOCOL.md)
> for the full protocol description.

---

## Install

```bash
npm install @gaborwnuk/axs-core
```

You supply the BLE stack — the library never imports one. For React Native, copy
the adapter in [`apps/demo`](../../apps/demo):

```bash
npx expo install react-native-ble-plx
```

## Reading gear, end to end

You supply the BLE stack; this library never imports one. `BleTransport` is the
only interface you have to satisfy — see [Transports](#transports).

### 1. Pair once

The component must be in pairing mode: hold its AXS button until the light
blinks. This is the **only** call in the library that writes to the device.

```ts
import { createBond, type BleTransport } from "@gaborwnuk/axs-core";

declare const transport: BleTransport;
declare const deviceId: string;
declare function promptTheRider(message: string): Promise<void>;

const peripheral = await transport.connect(deviceId);

const deviceKey = await createBond(peripheral, {
  // Must be a CSPRNG. `Math.random` would be a real vulnerability here: the
  // ephemeral private key has to be unguessable. Node 19+ and browsers have
  // `crypto.getRandomValues`; Hermes does not, so React Native needs a native
  // source such as expo-crypto's `getRandomBytes`.
  randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
  waitForPairingMode: () => promptTheRider("Hold the AXS button until it blinks"),
});

await peripheral.disconnect();
```

Store `deviceKey` — it is a credential. Reading with it never writes, so later
sessions skip this step entirely. Bonding again makes the component mint a
**fresh** key and invalidates this one.

### 2. Read gear

```ts
import { GearWatcher, type BleTransport } from "@gaborwnuk/axs-core";

declare const transport: BleTransport;
declare const deviceId: string;
declare const deviceKey: Uint8Array; // 16 bytes, from step 1

const watcher = new GearWatcher(transport, deviceId, { deviceKey });

watcher.events.on("gear", ({ gear, previous }) => {
  console.log(`shifted ${previous ?? "?"} → ${gear}`);
});

watcher.start();
// …later
await watcher.stop();
```

`GearWatcher` owns its connection and reconnects on drops. If something else
already holds the link — a `DeviceSession`, say — use `watchLiveState` instead
and hand it that connection, because an AXS component serves one central at a
time and a second connection closes the first:

```ts
import { watchLiveState, type DeviceSession } from "@gaborwnuk/axs-core";

declare const session: DeviceSession;
declare const deviceKey: Uint8Array;

const stop = watchLiveState(session.link, {
  deviceKey,
  onState: (state) => console.log("gear", state.gearRear),
});
```

> **Gear has to be polled, not subscribed to.** `d905000b` does notify, but the
> payload is a single `0xff` byte — a doorbell saying state changed, not the
> state itself. Only a *read* returns the encrypted frame. Both helpers above
> poll for you; if you drive the GATT yourself, subscribing alone will produce a
> steady stream of one-byte frames and a gear that never appears.

### 3. Or fold everything into one state object

`StateAggregator` collects every decoded value — serial, firmware, battery,
MicroAdjust, gear — with provenance. Gear enters through a keyed decoder:

```ts
import {
  AxsProbe,
  StateAggregator,
  createSrambondDecoder,
  LIVE_STATE_CHARACTERISTIC,
  type BleTransport,
} from "@gaborwnuk/axs-core";

declare const transport: BleTransport;
declare const deviceId: string;
declare const deviceKey: Uint8Array;

const probe = new AxsProbe(transport);
probe.registry.add(createSrambondDecoder(deviceKey));

const session = await probe.probe(deviceId);
const state = new StateAggregator(session.deviceId, session.deviceName, probe.registry);

session.events.on("frame", (frame) => state.ingest(frame));
state.events.on("shift", ({ from, to }) => console.log(`shifted ${from} → ${to}`));

// Required for gear: notifications alone carry no payload (see the note above),
// so poll the live-state characteristic to turn reads into frames.
const stopPolling = session.startPolling(250, (uuid) => uuid === LIVE_STATE_CHARACTERISTIC);
```

## Design

### Reads and writes are separated

`probe()` and all decoding are strictly read-only, and a regression test asserts
the probe issues no writes. Only `createBond()` writes, and only to the SRAMBond
service (`d905ee52`) — never the Nordic buttonless-DFU control point, which would
reboot the component into its bootloader.

### Capture first, decode later

Frames are stored raw; decoding is a pure function applied afterwards. A decoder
written next week replays against a capture taken today, so you iterate at a desk
instead of on a bike.

```ts
import {
  SessionRecorder,
  StateAggregator,
  loadSession,
  type DeviceSession,
  type DecoderRegistry,
} from "@gaborwnuk/axs-core";

declare const session: DeviceSession;
declare const registry: DecoderRegistry;

const recorder = new SessionRecorder(session);
recorder.start();
const json = recorder.toJSON(true); // persist this anywhere

// … later, with no hardware and possibly a decoder written since
const { frames } = loadSession(json);
const state = new StateAggregator("replay", null, registry);
for (const frame of frames) state.ingest(frame);
```

### Confidence is tracked, not assumed

Every decoded value carries its decoder, a 0–1 confidence and a timestamp. A
speculative heuristic reading can never overwrite a confirmed one, whatever order
they arrive in, and a UI can render the two differently.

### The registry is keyless

Decoders are pure functions of a frame, which keeps them trivially testable.
Decryption therefore enters through `createSrambondDecoder(key)` — a decoder you
construct once you hold a device key. Frames that fail authentication are
declined, so registering the wrong key is harmless.

## API

### Probing

| Export | Purpose |
|---|---|
| `AxsProbe` | Scan, identify, connect, enumerate, poll, stream frames |
| `DeviceSession` | One connection: `readAll`, `startPolling`, `frameHistory`, `tracker` |
| `identifyDevice` / `SRAM_COMPANY_ID` | Recognise AXS components from an advertisement |
| `describeUuid` | GATT knowledge base — standard vs. SRAM vendor UUIDs |

### Pairing and decryption

| Export | Purpose |
|---|---|
| `createBond(peripheral, opts)` | Offline SRAMBond handshake; returns the device key |
| `createSrambondDecoder(key)` | Registry decoder that decrypts live state into gear |
| `decodeSrambondState(key, frame)` | One-shot decrypt + decode of a `d905000b` frame |
| `decryptLiveStateFrame(key, frame)` | Just the AES-EAX layer |
| `computePublicKey` / `computeSharedSecret` / `decryptTransportedKey` | The handshake primitives, if you drive it yourself |

### Decoding

| Export | Purpose |
|---|---|
| `DecoderRegistry` / `DEFAULT_DECODERS` | Pluggable decoders, sorted by confidence |
| `decodeDrivetrainStatus` / `decodeDrivetrainConfig` | The gear protobufs |
| `AXS_DECODERS` | Confirmed vendor decoders: serial, model, firmware, MicroAdjust, usage record |
| `parseProtobuf` / `formatProtobuf` | Schema-less protobuf reader |
| `analyzeBytes` / `ByteChangeTracker` / `shannonEntropy` | Byte-volatility and entropy analysis |

### Crypto

| Export | Purpose |
|---|---|
| `eaxEncrypt` / `eaxDecrypt` / `cmac` | AES-EAX, validated against FIPS-197, NIST CMAC and the published EAX vectors |
| `modPow` / `publicKey` / `sharedSecret` | Finite-field Diffie–Hellman over BigInt |

### State and capture

| Export | Purpose |
|---|---|
| `StateAggregator` | Folds frames into one state object with provenance |
| `SessionRecorder` / `loadSession` / `replaySession` | Record, export and replay captures |
| `FakeTransport` / `simulatedDerailleur` / `SIMULATOR_DEVICE_KEY` | Hardware-free simulator that speaks the real AXS shapes, encryption included |

## What is decoded

Verified against a real `RD-GX-E-B1` and cross-checked against the official app:

| Value | Source | Needs a key? |
|---|---|---|
| Serial, model, firmware + git build id | `d905fe54` / `fe56` / `fe58` | No |
| MicroAdjust position | `d905000a` | No |
| Battery % | `0x2A19` | No |
| Cumulative shift counter, uptime | `d9050003` | No |
| **Current gear**, front position, trim | `d905000b` (`drivetrain_status`) | Yes |
| Cassette gear counts | `drivetrain_config` | Yes |

## Development

```bash
npm test          # unit tests, no hardware needed
npm run build     # ESM + CJS + type declarations
npm run typecheck
```

The test suite runs against real captured frames — a full 1→12→1 cassette sweep
and two real pairing handshakes — so a regression in the crypto or the decoders
fails the build rather than the bike.

## Licence

**Mozilla Public License 2.0** — Copyright (c) 2026 Gabor Wnuk. Free for
commercial and open-source use; keep the attribution, and modifications to
covered files stay open source under the MPL. See the
[LICENSE](../../LICENSE) at the repository root.

Not affiliated with, endorsed by, or connected to SRAM LLC. "SRAM", "AXS" and
"Eagle" are trademarks of SRAM LLC, used here only to describe interoperability.

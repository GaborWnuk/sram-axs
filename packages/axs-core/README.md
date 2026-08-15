# @axs/core

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
npm install @axs/core
```

You supply the BLE stack — the library never imports one. For React Native, copy
the adapter in [`apps/demo`](../../apps/demo):

```bash
npx expo install react-native-ble-plx
```

## Reading gear, end to end

```ts
import {
  AxsProbe,
  createBond,
  createSrambondDecoder,
  StateAggregator,
} from "@axs/core";

const probe = new AxsProbe(myTransport);
await probe.startScan();

// 1. Pair once. The component must be in pairing mode: hold its AXS button
//    until the light blinks. This is the only step that writes to the device.
const peripheral = await myTransport.connect(deviceId);
const deviceKey = await createBond(peripheral, {
  randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
  waitForPairingMode: async () => promptTheRider(),
});

// 2. Teach the decoder registry the key. Everything downstream — the log view,
//    StateAggregator, your dashboard — now sees gear with no further wiring.
probe.registry.add(createSrambondDecoder(deviceKey));

// 3. Read.
const session = await probe.probe(deviceId);
const state = new StateAggregator(session.deviceId, session.deviceName, probe.registry);
session.events.on("frame", (frame) => state.ingest(frame));
state.events.on("shift", ({ from, to }) => console.log(`shifted ${from} → ${to}`));
```

Store `deviceKey` and you can skip step 1 on later connections — reading is then
entirely read-only.

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
const recorder = new SessionRecorder(session);
recorder.start();
// … later, with no hardware
const { frames } = loadSession(json);
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

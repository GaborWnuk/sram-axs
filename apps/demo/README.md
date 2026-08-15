# AXS Probe (demo app)

Expo app demonstrating [`@axs/core`](../../packages/axs-core) end to end: find a
SRAM AXS component, pair with it, and read **live gear** — plus a ride dashboard
with GPS speed, and the reconnaissance views used to map the protocol.

The parts worth reading as reference usage:

| File | Shows |
|---|---|
| [`src/hooks/use-pairing.ts`](src/hooks/use-pairing.ts) | `createBond()` driven from a UI, including the physical AXS-button step |
| [`src/hooks/use-gear-watcher.ts`](src/hooks/use-gear-watcher.ts) | `GearWatcher` bound to React state, with auto-reconnect |
| [`src/key-store.ts`](src/key-store.ts) | Persisting the bond key in the platform keychain |
| [`src/components/live-gear.tsx`](src/components/live-gear.tsx) | The two together: pair once, then read |
| [`src/ble/plx-transport.ts`](src/ble/plx-transport.ts) | Implementing `BleTransport` on `react-native-ble-plx` |

Built on Expo SDK 57, React Native 0.86, expo-router with typed routes, and the
New Architecture.

## Running it

The app needs `react-native-ble-plx`, which is a native module — **Expo Go will
not work**. You need a development build.

```bash
# from the repo root
npm install
npm run build --workspace=@axs/core

cd apps/demo
npx expo prebuild          # generates ios/ and android/
npx expo run:ios           # or: npx expo run:android
```

On subsequent runs `npx expo start` is enough — the dev client is already
installed.

### No hardware?

The iOS Simulator has no Bluetooth radio. Switch **Transport** to **Simulator**
on the scan screen and a synthetic derailleur appears. It speaks the real AXS
shapes — including the AES-EAX encrypted live-state channel — so the whole
pipeline runs, gear included.

## Screens

**Scan.** Lists everything nearby. Scanning is deliberately *unfiltered*: an AXS
component that is asleep or advertising unexpectedly would be invisible behind a
company-ID filter, and "my derailleur isn't showing up" is exactly the situation
you would open this to debug. SRAM devices (company ID `0x0933`) sort first and
are badged, with their raw manufacturer payload shown in hex.

**Device.** Five tabs, of which **Live** is the one to look at first:

| Tab | What it is for |
|---|---|
| **Live** | Pair with the component, then watch gear update. This is the reference flow. |
| **State** | Decoded values with provenance. Low-confidence readings are dimmed and captioned. |
| **GATT** | The full service tree. Standard SIG entries are dimmed; vendor-defined ones are highlighted — that is where the undocumented AXS protocol lives. |
| **Log** | Raw frames: timestamp, characteristic, hex, best interpretation. "Mark shift" stamps ground truth onto the capture. |
| **Analysis** | Per-offset byte volatility and entropy. Useful for mapping the plaintext characteristics; note that gear is *not* among them — it lives on the encrypted channel (see [`PROTOCOL.md`](../../PROTOCOL.md)). |

**Dashboard.** GPS speed next to current gear. Speed comes from the location
provider's Doppler estimate rather than differentiated positions. Gear comes from
`GearWatcher`, using the key stored when you paired on the Live tab; if the
component has not been paired the readout says so instead of showing a guess.

## Pairing, and why it is needed

Identity, firmware, battery and MicroAdjust read in the clear. **Gear does not:**
it travels on an encrypted channel whose key the component only hands over during
the SRAMBond pairing handshake, and only while it is physically in pairing mode.

So the Live tab has two states. Unpaired, it offers a **Pair** button and then
asks you to hold the AXS button until the light blinks. Paired, it just shows
gear — the key is kept in the device keychain, and reading with it never writes
to the component.

Two things worth knowing:

- **Pairing re-keys the component.** Each bond makes it mint a fresh key and
  invalidates the previous one. The official SRAM app simply re-pairs itself the
  next time it connects, so this is recoverable, but it is why the app pairs once
  and stores the result rather than bonding on every connection.
- **Only pairing writes.** Everything else in this app is strictly read-only, and
  the write path touches only the SRAMBond service — never the firmware path.

## The bench workflow

1. Wake the component — press its AXS button or bounce the bike. AXS parts sleep
   aggressively; a silent scan usually means asleep, not broken.
2. Scan, connect. The probe enumerates read-only: discover, read everything
   readable, subscribe to everything that notifies. **It never writes** — a
   Nordic buttonless DFU control point in the tree would reboot the derailleur
   into its bootloader.
3. Open **GATT**. Note the vendor-defined characteristics.
4. Open **Log**, confirm frames are arriving.
5. Shift through the whole cassette, hitting **Mark shift** each time.
6. Open **Analysis**. Match change counts against your shift count to map the
   plaintext fields.
7. **Export** the capture and write a decoder against it offline — no bike
   required for iteration.

## Notes

- **Android** needs `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT` and location
  permission; BLE scanning is location-gated below Android 12.
- **Recording starts automatically on connect** — a capture you forgot to start
  is the one you needed.
- Exports go through the system share sheet as JSON. They contain the
  component's serial number, so treat them accordingly.

## Layout

```
app/                        expo-router routes
  _layout.tsx               stack + providers
  index.tsx                 scan
  device/[id].tsx           five-tab detail (Live first)
  dashboard.tsx             GPS speed + gear
src/
  ble/plx-transport.ts      the only file that knows a BLE stack exists
  key-store.ts              bond keys in the platform keychain
  probe-context.tsx         app state; buffers frames to avoid re-render storms
  hooks/use-pairing.ts      createBond() as a UI state machine
  hooks/use-gear-watcher.ts GearWatcher bound to React state
  hooks/use-gps-speed.ts
  components/live-gear.tsx  pair, then read gear — the reference flow
  components/ui.tsx
  theme.ts
  export-session.ts
```

Swapping `PlxTransport` for another BLE library — or for the core's
`FakeTransport` — requires no changes above `src/ble/`.

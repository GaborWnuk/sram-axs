# AXS Probe (demo app)

Expo app demonstrating [`@axs/core`](../../packages/axs-core). Scans for SRAM AXS
components, enumerates everything they expose over BLE, logs raw frames, and
shows a ride dashboard with GPS speed and current gear.

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
on the scan screen and a synthetic derailleur appears, driving the whole
pipeline — scan, GATT tree, notification stream, byte analysis, dashboard.

## Screens

**Scan.** Lists everything nearby. Scanning is deliberately *unfiltered*: an AXS
component that is asleep or advertising unexpectedly would be invisible behind a
company-ID filter, and "my derailleur isn't showing up" is exactly the situation
you would open this to debug. SRAM devices (company ID `0x0933`) sort first and
are badged, with their raw manufacturer payload shown in hex.

**Device.** Four tabs:

| Tab | What it is for |
|---|---|
| **State** | Decoded values with provenance. Low-confidence readings are dimmed and captioned. |
| **GATT** | The full service tree. Standard SIG entries are dimmed; vendor-defined ones are highlighted — that is where the undocumented AXS protocol lives. |
| **Log** | Raw frames: timestamp, characteristic, hex, best interpretation. "Mark shift" stamps ground truth onto the capture. |
| **Analysis** | Per-offset byte volatility and entropy. Useful for mapping the plaintext characteristics; note that gear is *not* among them — it lives on the encrypted channel (see [`PROTOCOL.md`](../../PROTOCOL.md)). |

**Dashboard.** GPS speed next to current gear. Speed comes from the location
provider's Doppler estimate rather than differentiated positions. Gear comes from
the encrypted `drivetrain_status` channel, so it needs the component's key —
supply one from `axs bond`, or run the Simulator transport, which ships its own
key. Every value is labelled with its decoder confidence.

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
app/                    expo-router routes
  _layout.tsx           stack + providers
  index.tsx             scan
  device/[id].tsx       four-tab detail
  dashboard.tsx         GPS speed + gear
src/
  ble/plx-transport.ts  the only file that knows a BLE stack exists
  probe-context.tsx     app state; buffers frames to avoid re-render storms
  hooks/use-gps-speed.ts
  components/ui.tsx
  theme.ts
  export-session.ts
```

Swapping `PlxTransport` for another BLE library — or for the core's
`FakeTransport` — requires no changes above `src/ble/`.

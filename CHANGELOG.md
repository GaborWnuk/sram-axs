# Changelog

## 0.2.0

Restructures the library so it describes the AXS platform rather than one
derailleur. See [ARCHITECTURE.md](ARCHITECTURE.md) for why, and
[REFACTORING.md](REFACTORING.md) for how each step was proven.

Reading gear behaves exactly as before, and the twelve captured frames from a
real RD-GX-E-B1 still decode to their physical gears.

### Breaking: component-specific state moved under `domains`

`AxsDeviceState` was a flat record with `gearRear` on it, so every component
carried every field — a dropper post would have had a permanently null gear, and
each new component family would have widened the type for everybody.

Identity, firmware and battery stay flat, because every AXS component has them.
Drivetrain values moved into `state.domains.drivetrain`, which is **absent**
unless the component actually reports one.

```diff
- state.gearRear?.value
+ state.domains.drivetrain?.gearRear?.value

- state.gearFront          state.totalRear          state.totalFront
+ state.domains.drivetrain?.gearFront   … ?.totalRear   … ?.totalFront

- state.shiftCount
+ state.domains.drivetrain?.shiftCount ?? 0
```

Unchanged: `deviceId`, `deviceName`, `manufacturerName`, `modelNumber`,
`serialNumber`, `hardwareRevision`, `firmwareRevision`, `softwareRevision`,
`batteryPercent`, `batteryVolts`, `frameCount`, `lastUpdateAt`, and the `change`
and `shift` events.

No deprecated accessors are provided. At 0.1 the break is cheap, and returning
an object with getters would have stopped the state being plain data.

### Fixed: decoded values that were being discarded

MicroAdjust and rear trim were decoded and then dropped, because the flat record
had nowhere to put them. They now appear as `domains.drivetrain.microAdjustCurrent`
/ `microAdjustMin` / `microAdjustMax` and `domains.drivetrain.trimRear`. The
component's own cumulative shift counter is exposed as `deviceShiftCounter`.

### Added

- `defineDomain`, `DomainReducer`, `DEFAULT_DOMAIN_REDUCERS` — contribute
  component-specific state without editing `StateAggregator`.
- `defineMessage`, `AXS_MESSAGES`, `routeMessage` — the encrypted channel is a
  pipe carrying several messages, distinguished by protobuf field number. Adding
  one no longer touches the crypto.
- `LiveStateWatcher<T>` — the reconnecting, doorbell-aware reader that
  `GearWatcher` is built on, usable for any component. `GearWatcher` keeps its
  exact shape.
- `watchLiveState` takes an optional `decode`, so a borrowed link can be read as
  something other than a drivetrain.
- `axs simulate --assert` exits non-zero unless every pipeline stage produced a
  real value, and runs in CI.

## 0.1.0

First release. Identification, GATT reconnaissance, the SRAMBond pairing
handshake, and decrypting live drivetrain state including current gear.

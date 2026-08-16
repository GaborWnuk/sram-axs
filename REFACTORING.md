# Refactoring plan: proving the architecture change

[ARCHITECTURE.md](ARCHITECTURE.md) says where the library should end up. This
says how to get there without breaking what already works on a bike, and — the
part that matters — **what proves each step**.

The constraint driving everything below: the derailleur path is verified working
against real hardware. Any refactor that quietly breaks it, and is only
discovered next time someone is in a garage with a phone, has cost more than it
saved.

---

## What actually guards the code today

| Surface | Guard | In CI |
|---|---|---|
| `axs-core` internals | 191 unit tests, including 12 real captured frames and two real handshakes | Yes |
| `axs-core` public API | One smoke test asserting `GearWatcher` is a function | Partly |
| `apps/cli` | `tsc --noEmit` and lint. No tests | Typecheck only |
| `apps/demo` | `tsc --noEmit` and lint. No tests | Typecheck only |
| Documentation examples | `check-docs` compiles 8 blocks against `dist` | Yes |
| Coverage | Codecov, with `apps/**` deliberately ignored | Yes |

The library is well covered. The two apps are covered by the type checker and
nothing else. That is a defensible position — but it means a *semantic* break
(a field that compiles fine and is simply never populated any more) has no
automated detector at all today.

Three specific gaps are worth closing before touching architecture.

---

## Gap 1 — the CLI's end-to-end path does not exercise the encrypted half

`simulate` describes itself as proving the library end to end. It does not. Run
it:

```
$ npm run cli -- simulate --seconds 2
  Rear gear      —
  Rear cogs      —
  Shifts seen    1
exit=0
```

`commandSimulate` delegates to `commandProbe`, which constructs `AxsProbe` with
the default registry and never registers
`createSrambondDecoder(SIMULATOR_DEVICE_KEY)`. So the decrypt → protobuf → gear
path — the most valuable and most fragile part of the library — is never
touched. `Shifts seen 1` comes from the *plaintext* usage record, not from gear.

And it exits 0 either way, so as a gate it detects only thrown exceptions.

The capability already exists and is used correctly in a unit test
(`probe.test.ts:252` registers the simulator decoder and asserts a real gear).
The CLI simply does not do it.

**Fix:** register the simulator decoder in `simulate`, add an assertion mode
that exits non-zero when expected values are absent, and run it in CI. That
turns a demo into a genuine end-to-end gate across transport → session →
registry → decrypt → aggregate → render, on every push, with no hardware. It is
the single highest-value item in this document relative to its cost.

## Gap 2 — nothing guards the public API surface

The only canary is the CI smoke test asserting `GearWatcher` is a function: one
of roughly a hundred exports, and a name Move B touches.

For a published package about to have its state model rewritten, silently
dropping an export is a breaking change nobody notices until an install fails.

**Fix:** a snapshot test over the sorted export list of `index.ts`. Any
addition, removal or rename becomes an explicit diff a human approves. Also
swap the CI smoke symbol from `GearWatcher` to something neutral — `AxsProbe`.

## Gap 3 — nothing proves behaviour is *preserved* across a refactor

The existing tests assert specific values, module by module. They are good
tests, but a refactor that relocates logic between modules can keep every one
of them green while changing what a consumer ends up seeing.

**Fix:** a characterization test. Replay a captured session through the whole
pipeline and snapshot the resulting state, recorded *before* the refactor
starts. The refactor then has to reproduce the same values, whatever shape they
live in.

The ingredients exist — `SessionRecorder`, `loadSession`, `replaySession`, and
the 12 captured sweep frames — but there is no stored session fixture; captures
live as inline hex inside individual test files. One
`fixtures/rd-gx-e-b1-sweep.json` gives characterization tests something to
replay and doubles as a regression corpus for every future decoder.

## Gap 4 — the demo can only be validated by hand, but it needs no bike

The demo has no tests, and cheap ones are not available: an Expo React Native
test harness is real setup cost for hooks that are thin event mirrors. That is
an acceptable trade, provided it is stated rather than assumed.

What the demo does have is the **Simulator transport**, already wired into
`probe-context.tsx`. So the emulator is a complete acceptance path with no
hardware involved — the same screenshot-driven workflow already used on the
bike, minus the bike.

So the demo's gate is honestly two things:

1. `tsc --noEmit`, which catches *structural* breakage and is the broadest
   check that exists across the repo;
2. a manual emulator pass against the Simulator transport, for semantics.

Two consequences worth building into the workflow. The app should be the first
consumer updated after any library change, because its typecheck is the widest
structural net available. And logic worth testing should live in the library,
not the app — `useGearWatcher` is a pure event-to-state mirror, and the one
genuinely app-specific invariant (re-render on `gear`, never on `reading`, which
fires at 4 Hz) is not worth a test harness.

---

## Phase 0 — build the net before moving anything

Four additive changes. None touches architecture. All can land at a desk.

1. Export-surface snapshot test.
2. Session fixture plus a characterization test over replayed state.
3. `simulate` registers the simulator decoder, gains `--assert`, and runs in CI.
4. CI smoke symbol changed to `AxsProbe`.

After these, every move below has an automated answer to "did I break it".

---

## The moves, and what proves each one

### Move C — message profile registry *(do this first)*

Non-breaking, and the blast radius stops at the library.

| | |
|---|---|
| **Library** | `axs/srambond.ts`, `axs/srambond.test.ts` |
| **Consumers** | `probe.test.ts:252`, `state.test.ts:63` — **tests only** |
| **Apps** | None. The CLI uses `GearWatcher`, the demo uses `watchLiveState`; neither imports `createSrambondDecoder` |
| **Proof** | The 12 captured sweep frames must still decode to their physical gears. That is real hardware data, so it is the strongest evidence available without a bike |
| **Hardware** | None |

Zero app impact makes this the ideal first move: it proves the profile-registry
pattern in miniature and exercises the new safety net on a change that cannot
reach a user interface.

### Move B — `LiveStateWatcher<T>`

Non-breaking, provided `GearWatcher` stays as a wrapper.

| | |
|---|---|
| **Library** | `axs/gear-watcher.ts`, `axs/gear-watcher.test.ts` (9 tests) |
| **Consumers** | `cli.ts:445`, `use-gear-watcher.ts:69`, `live-gear.tsx:59` |
| **Proof** | The 9 existing watcher tests must pass **unchanged** — that is precisely the non-breakage proof. Plus a new test instantiating `LiveStateWatcher` with a non-drivetrain decode function, and the export snapshot |
| **Hardware** | None for type parameterisation |

One caveat to state plainly: the reconnect and backoff paths are tested against
`FakeTransport` only. Real drop behaviour — the component hanging up an idle
link with GATT status 19 at around three minutes — is not reproducible in CI.
Re-parameterising the types is safe at a desk; changing reconnect *timing or
policy* is not, and needs a bike.

### Move A — open the state model

The breaking one. Do it with the net fully in place and already exercised.

| | |
|---|---|
| **Library** | `state.ts`, `state.test.ts` (14 tests) |
| **CLI** | `cli.ts:299-301` (gear, cogs, shift rows) |
| **Demo** | `device/[id].tsx:73,102-104,498-500`; `dashboard.tsx:120`; `probe-context.tsx:37,72,113` |
| **Not affected** | `live-gear.tsx:63` reads `DrivetrainStatus.gearRear` from the watcher, not from `AxsDeviceState` |
| **Docs** | `packages/axs-core/README.md` (StateAggregator section), root `README.md` |
| **Proof** | Characterization snapshot proves values unchanged; `state.test.ts` rewritten against the new shape; `tsc --noEmit` across both apps catches every structural miss; `check:docs`; `simulate --assert`; manual emulator pass |
| **Hardware** | None |

Three consumer files and one type import. That is the entire external cost, and
it only stays that small while the package is at 0.1.

### Move D — component profile registry

New surface, no removals. Meaningful only once Move F provides a second device
to select a profile *for*, so land them together.

**Proof:** new unit tests, plus a simulated non-derailleur device that the probe
correctly profiles.

### Move F — a simulator per component family

Pure addition. `FakeTransport` already accepts a list of devices
(`new FakeTransport([simulatedDerailleur()])`), so multi-device simulation needs
no transport change.

**Proof:** each new simulator is itself the test fixture for its family.

### Move G — bike-level aggregate

New composition layer over several `DeviceSession`s.

**Proof:** `FakeTransport` with several simulated devices. The one thing it
cannot answer is how many concurrent GATT links a phone will actually sustain —
that needs measuring on hardware before the design leans on it.

### Move E — the control boundary

A decision, not a refactor, and the only item here where a mistake moves a
motor.

**Proof:** the existing `probe.test.ts:141` "never writes" test stands
unchanged, plus a new test asserting the control module is unreachable from the
main entry point, enforced by the `exports` map in `package.json` rather than by
convention.

**Hardware:** yes, eventually, and carefully. Not part of this cleanup.

---

## What needs the bike, and what does not

| Work | Hardware |
|---|---|
| Phase 0, Moves A, B, C | None. Desk work, proven by existing tests and the simulator |
| Moves D, F | None to build; a real component to confirm the profile is right |
| Move G | Simulated multi-device: none. Concurrent-link ceiling: yes |
| Move E | Yes |
| Any *new* component profile | Yes — field numbers and characteristics are guesses until observed |

The headline: **the entire architecture cleanup, Phase 0 through Move D, can be
done and proven without hardware.** The bike is needed to add knowledge about a
new component, not to restructure how knowledge is held.

---

## Order of work

Ascending risk, so the safety net gets exercised on cheap changes first.

1. **Phase 0** — export snapshot, fixture and characterization test,
   `simulate --assert` in CI, neutral smoke symbol.
2. **Move C** — message profiles. Library-only, zero app impact.
3. **Move B** — `LiveStateWatcher<T>`, `GearWatcher` retained as a wrapper.
4. **Move A** — open the state model. Breaking; bump to 0.2.
5. **Moves D + F** — component profiles with a second simulated family.
6. **Move G** — bike-level aggregate, when Flight Attendant work begins.
7. **Move E** — control boundary, before any write is written.

Steps 2 through 4 are independent of each other; the ordering is chosen for risk
management, not dependency.

## Definition of done, per step

Every step lands only when all of these hold:

- `npm run check` is green — build, lint, typecheck across all three workspaces,
  191+ unit tests, documentation examples;
- `npm run cli -- simulate --assert` exits 0 and reports a real gear;
- the characterization snapshot is unchanged, or its diff is explained in the
  commit message;
- the export snapshot is unchanged, or its diff is deliberate;
- for anything the demo renders: one emulator pass on the Simulator transport,
  confirming the affected screen still shows what it did before.

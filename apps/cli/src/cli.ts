#!/usr/bin/env -S npx tsx
/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * axs — command-line probe for SRAM AXS components.
 *
 * Commands:
 *   scan                 list nearby BLE devices, SRAM ones highlighted
 *   probe <id>           connect, enumerate read-only, stream and record frames
 *   analyze <file>       offline analysis of a recorded capture (no hardware)
 *   simulate             run the whole pipeline against the built-in fake device
 */

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import process from "node:process";
import {
  AxsProbe,
  ByteChangeTracker,
  DecoderRegistry,
  SessionRecorder,
  StateAggregator,
  FakeTransport,
  createBond,
  createSrambondDecoder,
  GearWatcher,
  describeUuid,
  fromHex,
  loadSession,
  LIVE_STATE_CHARACTERISTIC,
  SIMULATOR_DEVICE_KEY,
  simulatedDerailleur,
  toHex,
  uuidEquals,
  type AxsDeviceState,
  type BleTransport,
  type Decoder,
  type DiscoveredDevice,
} from "@gaborwnuk/axs-core";

import { NobleTransport } from "./noble-transport.js";

// --- terminal helpers ------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);

const c = {
  bold: (t: string) => paint("1", t),
  dim: (t: string) => paint("2", t),
  red: (t: string) => paint("31", t),
  green: (t: string) => paint("32", t),
  yellow: (t: string) => paint("33", t),
  blue: (t: string) => paint("34", t),
  magenta: (t: string) => paint("35", t),
  cyan: (t: string) => paint("36", t),
};

/** Render an unknown thrown value as a string safe for interpolation. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(message: string): never {
  console.error(c.red(`error: ${message}`));
  process.exit(1);
}

/** Minimal flag parser: `--key value` and `--flag`. */
function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;

    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function numberFlag(flags: Record<string, string | boolean>, key: string, fallback: number): number {
  const raw = flags[key];
  if (typeof raw !== "string") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- scan ------------------------------------------------------------------

function describeDevice(device: DiscoveredDevice): string {
  const { result, identification } = device;
  const name = (result.name ?? "(unnamed)").padEnd(24).slice(0, 24);
  const rssi = String(result.rssi ?? "—").padStart(5);
  const tag = identification.isSram ? c.green(" SRAM ") : "      ";
  const kind = identification.kind !== "unknown" ? c.magenta(identification.kind) : "";

  let line = `${tag} ${c.bold(name)} ${rssi}dBm  ${c.dim(result.id)}  ${kind}`;

  const payload = identification.manufacturerData?.payload;
  if (identification.isSram && payload && payload.length > 0) {
    line += `\n         ${c.dim("mfg payload:")} ${c.cyan(toHex(payload))}`;
  }
  return line;
}

async function commandScan(transport: BleTransport, flags: Record<string, string | boolean>) {
  const seconds = numberFlag(flags, "seconds", 15);
  const onlySram = flags.sram === true;

  const probe = new AxsProbe(transport);
  probe.events.on("log", (entry) => {
    if (entry.level !== "debug") console.log(c.dim(`  ${entry.message}`));
  });

  console.log(c.bold(`\nScanning for ${seconds}s…`));
  console.log(
    c.dim(
      "Wake the derailleur first: press its AXS button or bounce the bike.\n" +
        "AXS components sleep aggressively and will not advertise otherwise.\n",
    ),
  );

  const seen = new Set<string>();
  probe.events.on("device", (device) => {
    if (onlySram && !device.identification.isSram) return;
    if (seen.has(device.result.id)) return;
    seen.add(device.result.id);
    console.log(describeDevice(device));
  });

  const stop = await probe.startScan();
  await sleep(seconds * 1000);
  stop();

  const devices = probe.devices();
  const sram = devices.filter((d) => d.identification.isSram);

  console.log(c.bold(`\n${devices.length} devices, ${sram.length} SRAM.`));
  if (sram.length > 0) {
    console.log(c.dim("\nProbe one with:"));
    for (const device of sram) {
      console.log(c.cyan(`  npm run axs -w @gaborwnuk/axs-cli -- probe ${device.result.id}`));
    }
  } else {
    console.log(
      c.yellow(
        "\nNo SRAM devices found. If the derailleur is awake and still absent, it may " +
          "only advertise while the AXS app is disconnected — force-quit the app and retry.",
      ),
    );
  }
  console.log();
}

// --- probe -----------------------------------------------------------------

async function commandProbe(
  transport: BleTransport,
  deviceId: string,
  flags: Record<string, string | boolean>,
  options: { extraDecoders?: Decoder[] } = {},
): Promise<StateAggregator> {
  const seconds = numberFlag(flags, "seconds", 30);
  const outPath = typeof flags.out === "string" ? flags.out : null;
  // 0 disables polling. AXS notifications carry no payload, so polling the
  // readable characteristics is how you actually observe state changing.
  const pollMs = numberFlag(flags, "poll", 0) * 1000;

  const probe = new AxsProbe(transport);
  // Callers with a device key hand in a keyed decoder here. Without one the
  // encrypted live-state channel stays opaque, which is correct for a plain
  // `probe` of an unpaired component and wrong for `simulate`, where the key
  // is known.
  for (const decoder of options.extraDecoders ?? []) probe.registry.add(decoder);
  probe.events.on("log", (entry) => {
    const tint =
      entry.level === "warn" ? c.yellow : entry.level === "error" ? c.red : c.dim;
    console.log(tint(`  ${entry.message}`));
  });

  // The device must be discovered before it can be connected to.
  console.log(c.bold(`\nLocating ${deviceId}…`));
  const stopScan = await probe.startScan();

  const found = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 20_000);
    const off = probe.events.on("device", (device) => {
      if (device.result.id === deviceId) {
        clearTimeout(timer);
        off();
        resolve(true);
      }
    });
  });
  stopScan();

  if (!found) fail(`Device ${deviceId} not seen while scanning. Is it awake and in range?`);

  console.log(c.bold("\nProbing (read-only — this never writes to the device)…\n"));
  const session = await probe.probe(deviceId);

  const recorder = new SessionRecorder(session);
  recorder.notes = `axs cli probe of ${deviceId}`;
  recorder.start();

  const aggregator = new StateAggregator(session.deviceId, session.deviceName, probe.registry);

  // Seed from history first: probe() already ran the connect-time read pass
  // (firmware, serial, model) before a listener could be attached.
  for (const frame of session.frameHistory()) aggregator.ingest(frame);
  session.events.on("frame", (frame) => aggregator.ingest(frame));

  aggregator.events.on("shift", ({ from, to, totalShifts }) => {
    console.log(c.green(`  ⇄ shift ${from ?? "?"} → ${to ?? "?"}  (total ${totalShifts})`));
  });

  session.events.on("frame", (frame) => {
    const best = probe.registry.best(frame);
    const info = frame.characteristicUuid ? describeUuid(frame.characteristicUuid) : null;
    // Vendor UUIDs have no short form and no name; show their leading segment
    // rather than a useless "?".
    const label = (info?.short ?? info?.uuid.slice(0, 8) ?? "—").padEnd(10).slice(0, 10);
    const speculative = (best?.confidence ?? 0) < 0.8;

    console.log(
      `  ${c.dim((frame.elapsedMs / 1000).toFixed(2).padStart(7) + "s")} ` +
        `${c.blue(label)} ${toHex(frame.data).padEnd(24)} ` +
        (best ? (speculative ? c.dim(best.summary) : c.green(best.summary)) : ""),
    );
  });

  let disconnected = false;
  session.events.on("disconnected", ({ error }) => {
    disconnected = true;
    console.log(c.yellow(`\n  Device disconnected${error ? `: ${error.message}` : ""}`));
  });

  if (pollMs > 0) {
    // Restrict polling to a subset when asked. The high-entropy 32-43 byte
    // characteristics look encrypted and are not worth the connection budget;
    // polling everything at a short interval risks getting dropped.
    const only = typeof flags["poll-only"] === "string"
      ? (flags["poll-only"]).split(",").map((s) => s.trim().toLowerCase())
      : null;
    session.startPolling(
      pollMs,
      only ? (uuid) => only.some((prefix) => uuid.toLowerCase().startsWith(prefix)) : undefined,
    );
  }

  console.log(
    c.dim(
      `\nStreaming for ${seconds}s. Shift through the whole cassette now — ` +
        "that is what makes the byte analysis meaningful.\n",
    ),
  );

  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline && !disconnected) await sleep(250);

  recorder.stop();
  await session.close();

  printSummary(session.trackedCharacteristics(), (uuid) => session.tracker(uuid), aggregator);

  if (outPath) {
    writeFileSync(outPath, recorder.toJSON(true), "utf8");
    console.log(c.green(`\nCapture written to ${outPath} (${recorder.frameCount} frames)`));
    console.log(c.dim(`Analyse it later with:  npm run axs -w @gaborwnuk/axs-cli -- analyze ${outPath}`));
  } else if (recorder.frameCount > 0) {
    console.log(
      c.yellow(`\n${recorder.frameCount} frames captured but not saved. Re-run with --out capture.json`),
    );
  }
  console.log();

  return aggregator;
}

function printSummary(
  characteristics: string[],
  trackerFor: (uuid: string) => ByteChangeTracker | null,
  aggregator: StateAggregator,
) {
  const state = aggregator.current();

  console.log(c.bold("\n── Device state ─────────────────────────────────────────"));
  const rows: Array<[string, string]> = [
    ["Manufacturer", state.manufacturerName?.value ?? "—"],
    ["Model", state.modelNumber?.value ?? "—"],
    ["Serial", state.serialNumber?.value ?? "—"],
    ["Firmware", state.firmwareRevision?.value ?? "—"],
    ["Hardware", state.hardwareRevision?.value ?? "—"],
    ["Battery", state.batteryPercent ? `${state.batteryPercent.value}%` : "—"],
    ["Rear gear", state.gearRear ? String(state.gearRear.value) : "—"],
    ["Rear cogs", state.totalRear ? String(state.totalRear.value) : "—"],
    ["Shifts seen", String(state.shiftCount)],
    ["Frames", String(state.frameCount)],
  ];

  for (const [label, value] of rows) {
    console.log(`  ${label.padEnd(14)} ${value === "—" ? c.dim(value) : c.bold(value)}`);
  }

  if (characteristics.length === 0) return;

  console.log(c.bold("\n── Byte volatility ──────────────────────────────────────"));
  console.log(
    c.dim("  The offset whose change count matches your shift count is the gear field.\n"),
  );

  for (const uuid of characteristics) {
    const tracker = trackerFor(uuid);
    if (!tracker || tracker.frameCount < 2) continue;

    const info = describeUuid(uuid);
    const vendor = info.category === "vendor";
    console.log(
      `  ${vendor ? c.magenta(info.uuid) : c.blue(info.short ?? info.uuid)}` +
        ` ${c.dim(`${info.name ?? "vendor-defined"} · ${tracker.frameCount} frames`)}`,
    );

    console.log(c.dim("    off  changes  range      last"));
    for (const stat of tracker.report()) {
      const changes = stat.constant ? c.dim("const") : c.cyan(String(stat.changes));
      console.log(
        `    ${String(stat.offset).padStart(3)}  ${changes.padEnd(16)} ` +
          `${`${stat.minValue}–${stat.maxValue}`.padEnd(10)} 0x${stat.lastValue
            .toString(16)
            .padStart(2, "0")}`,
      );
    }
    console.log();
  }
}

// --- bond (offline self-pairing) -------------------------------------------

/** Resolve when the user presses Enter, after showing a prompt. */
function promptEnter(message: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(message);
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

async function commandBond(
  transport: BleTransport,
  deviceId: string,
  flags: Record<string, string | boolean>,
) {
  const seconds = numberFlag(flags, "seconds", 60);
  const pollMs = numberFlag(flags, "poll", 0.25) * 1000;

  const probe = new AxsProbe(transport);
  probe.events.on("log", (entry) => {
    if (entry.level === "warn") console.log(c.yellow(`  ${entry.message}`));
  });

  console.log(c.bold(`\nLocating ${deviceId}…`));
  if (!(await locate(probe, deviceId))) {
    fail(`Device ${deviceId} not seen. Wake it (AXS button) and retry.`);
  }

  console.log(c.bold("\nConnecting…"));
  const peripheral = await transport.connect(deviceId);
  const services = await peripheral.discoverServices();
  const liveService = services.find((s) =>
    s.characteristics.some((ch) => uuidEquals(ch.uuid, LIVE_STATE_CHARACTERISTIC)),
  );

  console.log(
    c.bold("\nOffline create-bond") +
      c.dim(" — writes to the SRAMBond service only, never the firmware path.\n"),
  );

  // `--ready` skips the interactive prompt for callers that have already put the
  // component into pairing mode (and for non-interactive shells, where there is
  // no stdin to read from).
  const alreadyInPairingMode = flags.ready === true;
  if (alreadyInPairingMode) {
    console.log(c.yellow("  --ready: assuming the AXS button is held and the light is blinking.\n"));
  }

  let deviceKey: Uint8Array;
  try {
    deviceKey = await createBond(peripheral, {
      randomBytes: (n) => Uint8Array.from(randomBytes(n)),
      ...(alreadyInPairingMode
        ? {}
        : {
            waitForPairingMode: () =>
              promptEnter(
                c.yellow(
                  "  ▶ Hold the derailleur's AXS button until the light blinks, then press Enter… ",
                ),
              ),
          }),
      onStep: (step) => console.log(c.dim(`    · ${step}`)),
    });
  } catch (error) {
    await peripheral.disconnect();
    fail(`Bond failed: ${errorMessage(error)}. Was it in pairing mode?`);
  }

  console.log(c.green(`\n  Bonded. Device key: ${c.bold(toHex(deviceKey, ""))}`));
  console.log(c.dim(`  Reuse it read-only with:  gear ${deviceId} --key ${toHex(deviceKey, "")}\n`));

  if (!liveService) {
    console.log(c.yellow("Live-state characteristic not found on this component; cannot read gear."));
    await peripheral.disconnect();
    return;
  }

  // Hand the link back before the watcher opens its own — one connection at a time.
  await peripheral.disconnect();

  console.log(c.bold(`Reading gear for ${seconds}s`) + c.dim(" — shift to watch it track.\n"));
  await streamGear(transport, deviceId, deviceKey, seconds, pollMs);
}


/**
 * Print live gear until the deadline, reconnecting automatically.
 *
 * AXS components drop an idle connection within a minute or two, so anything
 * long-running has to expect it. `GearWatcher` handles the reconnects; this just
 * renders what it reports.
 */
async function streamGear(
  transport: BleTransport,
  deviceId: string,
  deviceKey: Uint8Array,
  seconds: number,
  pollMs: number,
): Promise<void> {
  const watcher = new GearWatcher(transport, deviceId, {
    deviceKey,
    pollIntervalMs: pollMs,
  });

  let readings = 0;
  let reconnects = 0;
  let lastWarning = "";

  watcher.events.on("gear", ({ gear, previous, reading }) => {
    const extra =
      reading.gearFront !== undefined
        ? c.dim(` (fd ${reading.gearFront}, trim ${reading.trimRear ?? "—"})`)
        : "";
    const arrow = previous === null ? "" : c.dim(`  ${previous} → `);
    console.log(`  ${arrow}${c.bold(c.green(`gear ${gear}`))}${extra}`);
  });
  watcher.events.on("reading", () => readings++);
  watcher.events.on("status", ({ status, attempt, error }) => {
    if (status === "connected") {
      console.log(c.dim(attempt === 0 ? "  · connected" : `  · reconnected after ${attempt} attempt(s)`));
    } else if (status === "reconnecting") {
      reconnects++;
      // Only narrate the first attempt of each drop; backoff retries are noise.
      if (attempt <= 1) {
        console.log(c.yellow(`  · link dropped${error ? `: ${error.message}` : ""} — reconnecting`));
      }
    }
  });
  watcher.events.on("warning", ({ message }) => {
    // Repeated identical warnings during one bad patch are not worth repeating.
    if (message !== lastWarning) {
      lastWarning = message;
      console.log(c.dim(`  · ${message}`));
    }
  });

  watcher.start();
  await sleep(seconds * 1000);
  await watcher.stop();

  console.log(
    c.bold(`\n${readings} frames decoded`) +
      (reconnects > 0 ? c.dim(`, ${reconnects} reconnect(s)`) : "") +
      (readings === 0
        ? c.red(" — nothing decoded. Wrong key, or the component re-bonded since.")
        : ""),
  );
  console.log();
}

// --- gear (live decrypted reading) -----------------------------------------

/** Scan until the given device id appears, or time out. */
async function locate(probe: AxsProbe, deviceId: string, timeoutMs = 20_000): Promise<boolean> {
  const stopScan = await probe.startScan();
  const found = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    const off = probe.events.on("device", (device) => {
      if (device.result.id === deviceId) {
        clearTimeout(timer);
        off();
        resolve(true);
      }
    });
  });
  stopScan();
  return found;
}

async function commandGear(
  transport: BleTransport,
  deviceId: string,
  flags: Record<string, string | boolean>,
) {
  const keyHex = typeof flags.key === "string" ? flags.key : null;
  if (!keyHex) {
    fail("gear needs --key <hex> — the component's 16-byte AES key (see docs/PROTOCOL)");
  }
  const key = fromHex(keyHex);
  if (key.length !== 16) fail(`--key must be 16 bytes (32 hex chars), got ${key.length}`);

  const seconds = numberFlag(flags, "seconds", 120);
  const pollMs = numberFlag(flags, "poll", 0.25) * 1000; // 4 Hz, matching the app

  const probe = new AxsProbe(transport);
  probe.events.on("log", (entry) => {
    if (entry.level === "warn") console.log(c.yellow(`  ${entry.message}`));
    else if (entry.level === "error") console.log(c.red(`  ${entry.message}`));
  });

  console.log(c.bold(`\nLocating ${deviceId}…`));
  if (!(await locate(probe, deviceId))) {
    fail(`Device ${deviceId} not seen. Wake it, and make sure the AXS app is disconnected.`);
  }

  console.log(
    c.bold(`\nReading gear for ${seconds}s`) +
      c.dim(" — read-only, reconnecting automatically if the link drops.\n"),
  );
  await streamGear(transport, deviceId, key, seconds, pollMs);
}

// --- analyze (offline) -----------------------------------------------------

async function commandAnalyze(path: string) {
  const json = await readFile(path, "utf8");
  const { document, frames } = loadSession(json);

  console.log(c.bold(`\n${path}`));
  console.log(`  device   ${document.deviceName ?? "—"} (${document.deviceId})`);
  console.log(`  notes    ${document.notes || "—"}`);
  console.log(`  frames   ${frames.length}`);
  if (frames.length === 0) return;

  const span = (frames[frames.length - 1]!.elapsedMs - frames[0]!.elapsedMs) / 1000;
  console.log(`  span     ${span.toFixed(1)}s\n`);

  const registry = new DecoderRegistry();
  const trackers = new Map<string, ByteChangeTracker>();
  const aggregator = new StateAggregator(document.deviceId, document.deviceName, registry);

  for (const frame of frames) {
    aggregator.ingest(frame);
    if (!frame.characteristicUuid) continue;

    const key = normalizeKey(frame.characteristicUuid);
    let tracker = trackers.get(key);
    if (!tracker) {
      tracker = new ByteChangeTracker();
      trackers.set(key, tracker);
    }
    tracker.add(frame.data);
  }

  const labelled = frames.filter((f) => f.label);
  if (labelled.length > 0) {
    console.log(c.bold("── Marked frames ────────────────────────────────────────"));
    for (const frame of labelled) {
      console.log(
        `  ${c.dim((frame.elapsedMs / 1000).toFixed(2) + "s")} ${toHex(frame.data)}  ${c.yellow(frame.label!)}`,
      );
    }
    console.log();
  }

  printSummary([...trackers.keys()], (uuid) => trackers.get(uuid) ?? null, aggregator);
}

const normalizeKey = (uuid: string) => uuid.toLowerCase();

// --- simulate --------------------------------------------------------------

async function commandSimulate(flags: Record<string, string | boolean>) {
  const seconds = numberFlag(flags, "seconds", 8);
  const shouldAssert = flags.assert === true;

  console.log(
    c.bold("\nRunning the full pipeline against the built-in simulated derailleur.\n") +
      c.dim("No hardware involved — this proves the library end to end.\n"),
  );

  const transport = new FakeTransport([simulatedDerailleur()], { advertiseIntervalMs: 1000 });

  // The simulator's key is known, so unlike a probe of real unpaired hardware
  // this run can decrypt. Without it the encrypted live-state channel — the
  // decrypt → protobuf → gear path, which is the part most worth exercising —
  // would never be touched, and the run would prove only the plaintext half.
  const aggregator = await commandProbe(
    transport,
    "sim-rd-0001",
    { ...flags, seconds: String(seconds), poll: String(numberFlag(flags, "poll", 1)) },
    { extraDecoders: [createSrambondDecoder(SIMULATOR_DEVICE_KEY)] },
  );

  if (!shouldAssert) {
    console.log(c.dim("Re-run with --assert to check the pipeline produced real values.\n"));
    return;
  }

  assertSimulatedPipeline(aggregator.current());
}

/**
 * Turn the simulator run into a gate.
 *
 * Printing a table proves nothing: every field renders as "—" when decoding
 * silently stops working, and the process still exits 0. These checks are the
 * difference between a demo and something CI can rely on, and they are chosen
 * to span the whole pipeline — transport, enumeration, plaintext decoders, the
 * SRAMBond crypto, and the aggregator that folds it together.
 */
function assertSimulatedPipeline(state: AxsDeviceState): void {
  const failures: string[] = [];

  const check = (label: string, ok: boolean, detail: string): void => {
    if (ok) {
      console.log(`  ${c.green("✓")} ${label.padEnd(28)} ${c.dim(detail)}`);
    } else {
      console.log(`  ${c.red("✗")} ${label.padEnd(28)} ${c.red(detail)}`);
      failures.push(label);
    }
  };

  console.log(c.bold("── Pipeline assertions ──────────────────────────────────\n"));

  check("frames captured", state.frameCount > 0, `${state.frameCount} frames`);
  check(
    "identity decoded",
    state.serialNumber !== null,
    state.serialNumber ? `serial ${state.serialNumber.value}` : "no serial decoded",
  );
  check(
    "firmware decoded",
    state.firmwareRevision !== null,
    state.firmwareRevision ? state.firmwareRevision.value : "no firmware decoded",
  );

  // The load-bearing one. A gear only appears if the transport, the SRAMBond
  // AES-EAX layer and the protobuf decoder all worked.
  const gear = state.gearRear?.value ?? null;
  check(
    "encrypted gear decoded",
    gear !== null && gear >= 1 && gear <= 12,
    gear === null ? "no gear — the SRAMBond path is broken" : `gear ${gear}`,
  );
  check(
    "gear came from SRAMBond",
    state.gearRear?.decoder === "axs/srambond",
    state.gearRear ? `decoder ${state.gearRear.decoder}` : "no decoder",
  );

  console.log();

  if (failures.length > 0) {
    fail(`${failures.length} pipeline assertion(s) failed: ${failures.join(", ")}`);
  }
  console.log(c.green("Pipeline OK — every stage produced a real value.\n"));
}

// --- entry point -----------------------------------------------------------

function usage(): never {
  console.log(`
${c.bold("axs")} — probe SRAM AXS components over BLE

  ${c.cyan("scan")} [--seconds N] [--sram]
      List nearby devices. SRAM components are highlighted.

  ${c.cyan("probe <device-id>")} [--seconds N] [--out capture.json] [--poll N]
      Connect, enumerate read-only, stream frames, print byte analysis.
      --poll N re-reads every readable characteristic every N seconds, which is
      how you catch state that is never pushed in a notification.

  ${c.cyan("bond <device-id>")} [--seconds N] [--ready]
      Offline self-pairing: run the SRAMBond create-bond over BLE (no cloud, no
      account), print the component's live-state key, then read gear. Prompts you
      to hold the AXS button (pairing mode); --ready skips that prompt when the
      component is already blinking, which is what non-interactive shells need.

  ${c.cyan("gear <device-id> --key <hex>")} [--seconds N] [--poll S]
      Connect (read-only) and print the live gear, decrypting the drivetrain
      characteristic with the component's AES key (from ${c.cyan("bond")}). --poll defaults to 0.25s.

  ${c.cyan("analyze <capture.json>")}
      Re-analyse a saved capture. No hardware needed.

  ${c.cyan("simulate")} [--seconds N] [--assert]
      Exercise the pipeline against the built-in fake device, decrypting its
      live state with the simulator's known key. --assert checks each stage
      produced a real value and exits non-zero otherwise, which is what makes
      this usable as a CI gate rather than a demo.

${c.dim("macOS: your terminal needs Bluetooth access in")}
${c.dim("System Settings > Privacy & Security > Bluetooth.")}
`);
  process.exit(1);
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const flags = parseFlags(rest);
  const positional = rest.filter((token) => !token.startsWith("--"));

  // Offline commands need no radio.
  if (command === "analyze") {
    const path = positional[0];
    if (!path) fail("analyze needs a capture file path");
    await commandAnalyze(path);
    return;
  }

  if (command === "simulate") {
    await commandSimulate(flags);
    return;
  }

  if (command !== "scan" && command !== "probe" && command !== "gear" && command !== "bond") usage();

  const transport = new NobleTransport();
  try {
    await transport.ready();

    if (command === "scan") {
      await commandScan(transport, flags);
    } else if (command === "gear") {
      const deviceId = positional[0];
      if (!deviceId) fail("gear needs a device id (run `scan` first)");
      await commandGear(transport, deviceId, flags);
    } else if (command === "bond") {
      const deviceId = positional[0];
      if (!deviceId) fail("bond needs a device id (run `scan` first)");
      await commandBond(transport, deviceId, flags);
    } else {
      const deviceId = positional[0];
      if (!deviceId) fail("probe needs a device id (run `scan` first)");
      await commandProbe(transport, deviceId, flags);
    }
  } finally {
    transport.stop();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(c.red(`\n${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  });

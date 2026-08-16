/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

import { describe, expect, it, vi } from "vitest";

import type { RawFrame } from "./frame.js";
import { AxsProbe } from "./probe.js";
import { SessionRecorder, loadSession } from "./recorder.js";
import { StateAggregator } from "./state.js";
import { AXS_USAGE_RECORD_OFFSETS } from "./axs/device-info.js";
import { createSrambondDecoder } from "./axs/srambond.js";
import {
  FakeTransport,
  SIMULATOR_DEVICE_KEY,
  simulatedDerailleur,
} from "./testing/fake-transport.js";

describe("AxsProbe scanning", () => {
  it("discovers the simulated derailleur and identifies it as SRAM", async () => {
    const probe = new AxsProbe(new FakeTransport());
    await probe.startScan();

    const devices = probe.devices();
    expect(devices).toHaveLength(1);
    expect(devices[0]!.identification.isSram).toBe(true);
    expect(devices[0]!.result.name).toBe("SIM GX Eagle RD");
  });

  it("sorts SRAM devices ahead of everything else", async () => {
    const transport = new FakeTransport([
      { id: "other", name: "Some Headphones", rssi: -30, services: [] },
      simulatedDerailleur(),
    ]);

    const probe = new AxsProbe(transport);
    await probe.startScan();

    // The derailleur has a weaker signal but must still sort first.
    expect(probe.devices()[0]!.identification.isSram).toBe(true);
  });

  it("counts repeat sightings of the same device", async () => {
    const transport = new FakeTransport();
    const probe = new AxsProbe(transport);

    const stop = await probe.startScan();
    await probe.startScan(); // second round of advertisements
    stop();

    expect(probe.devices()[0]!.sightings).toBeGreaterThanOrEqual(2);
  });

  it("clears discovered devices on request", async () => {
    const probe = new AxsProbe(new FakeTransport());
    await probe.startScan();
    probe.clearDevices();
    expect(probe.devices()).toHaveLength(0);
  });
});

describe("AxsProbe device probing", () => {
  it("enumerates the GATT tree", async () => {
    const probe = new AxsProbe(new FakeTransport());
    const session = await probe.probe("sim-rd-0001", { subscribeAll: false });

    const serviceUuids = session.gatt.map((s) => s.uuid);
    expect(serviceUuids).toContain("180a");
    expect(serviceUuids).toContain("180f");

    await session.close();
  });

  it("retains connect-time reads in frame history", async () => {
    // REGRESSION TEST: probe() runs its read pass before the caller can attach
    // a "frame" listener. Without a retained history, every Device Information
    // read (firmware, serial, model) is emitted into the void and the UI shows
    // blanks for data the device happily provided.
    const probe = new AxsProbe(new FakeTransport());
    const session = await probe.probe("sim-rd-0001", { subscribeAll: false });

    const history = session.frameHistory();
    const modelFrame = history.find((f) => f.characteristicUuid === "2a24")!;

    expect(modelFrame).toBeDefined();
    expect(probe.registry.best(modelFrame)!.fields.modelNumber).toBe("RD-GX-E-B1");

    await session.close();
  });

  it("populates full device state when seeded from history", async () => {
    const probe = new AxsProbe(new FakeTransport());
    const session = await probe.probe("sim-rd-0001", { subscribeAll: false });

    const state = new StateAggregator(session.deviceId, session.deviceName, probe.registry);
    for (const frame of session.frameHistory()) state.ingest(frame);

    const current = state.current();
    expect(current.manufacturerName?.value).toBe("SRAM");
    expect(current.modelNumber?.value).toBe("RD-GX-E-B1");
    expect(current.firmwareRevision?.value).toBe("1.28.0");
    expect(current.serialNumber?.value).toBe("SIM00000001");
    expect(current.batteryPercent?.value).toBe(87);

    await session.close();
  });

  it("still delivers live frames to listeners attached after probe()", async () => {
    const probe = new AxsProbe(new FakeTransport());
    const frames: RawFrame[] = [];

    const session = await probe.probe("sim-rd-0001", { subscribeAll: false });
    session.events.on("frame", (f) => frames.push(f));

    await session.readAll();
    expect(frames.length).toBeGreaterThan(0);

    await session.close();
  });

  it("logs a warning for an unreadable characteristic instead of aborting", async () => {
    const probe = new AxsProbe(new FakeTransport());
    const warnings: string[] = [];
    probe.events.on("log", (entry) => {
      if (entry.level === "warn") warnings.push(entry.message);
    });

    const session = await probe.probe("sim-rd-0001", { subscribeAll: false });

    expect(warnings.some((w) => w.includes("d90500f1"))).toBe(true);
    // The readable characteristics must still have been read.
    expect(session.trackedCharacteristics()).toContain("2a24");

    await session.close();
  });

  it("never writes to any characteristic during a probe", async () => {
    const transport = new FakeTransport();
    const probe = new AxsProbe(transport);

    const session = await probe.probe("sim-rd-0001", { subscribeAll: false });
    const peripheral = transport.peripherals.get("sim-rd-0001")!;
    const writeSpy = vi.spyOn(peripheral, "write");

    await session.readAll();

    // Writing to a Nordic buttonless DFU control point would reboot the
    // component into its bootloader, so the probe must stay strictly read-only.
    expect(writeSpy).not.toHaveBeenCalled();
    await session.close();
  });

  it("streams notifications and tracks byte volatility", async () => {
    vi.useFakeTimers();
    try {
      const probe = new AxsProbe(new FakeTransport());
      const session = await probe.probe("sim-rd-0001");

      await vi.advanceTimersByTimeAsync(3000);

      const tracker = session.tracker("d9050003-90aa-4c7c-b036-1e01fb8eb7ee")!;
      expect(tracker.frameCount).toBeGreaterThan(5);

      // Uptime ticks on every notification, so it must rank among the most
      // volatile offsets — this is the signal the analysis view surfaces.
      const uptimeStats = tracker.report().find(
        (s) => s.offset === AXS_USAGE_RECORD_OFFSETS.uptime,
      )!;
      expect(uptimeStats.changes).toBeGreaterThan(5);
      // Byte 0 is the record type and must never change.
      expect(tracker.constantOffsets()).toContain(0);

      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops delivering frames after close", async () => {
    vi.useFakeTimers();
    try {
      const probe = new AxsProbe(new FakeTransport());
      const session = await probe.probe("sim-rd-0001");

      await vi.advanceTimersByTimeAsync(1000);
      await session.close();

      let afterClose = 0;
      session.events.on("frame", () => afterClose++);
      await vi.advanceTimersByTimeAsync(2000);

      expect(afterClose).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces an unexpected disconnect", async () => {
    const transport = new FakeTransport();
    const probe = new AxsProbe(transport);
    const session = await probe.probe("sim-rd-0001", { subscribeAll: false });

    const onDisconnect = vi.fn();
    session.events.on("disconnected", onDisconnect);

    transport.disconnectDevice("sim-rd-0001", new Error("out of range"));

    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(session.isClosed).toBe(true);
  });

  it("rejects an unknown device id", async () => {
    const probe = new AxsProbe(new FakeTransport());
    await expect(probe.probe("nope")).rejects.toThrow(/No such device/);
  });
});

describe("end-to-end capture, record and replay", () => {
  it("records a session, serialises it and replays it into state", async () => {
    vi.useFakeTimers();
    try {
      const probe = new AxsProbe(new FakeTransport());
      const session = await probe.probe("sim-rd-0001");

      const recorder = new SessionRecorder(session);
      recorder.notes = "GX Eagle Transmission, bench test";
      recorder.start();

      // start() seeds from history, so the connect-time reads are in the
      // capture even though the recorder was created after probe().
      expect(recorder.all().some((f) => f.characteristicUuid === "2a26")).toBe(true);

      await vi.advanceTimersByTimeAsync(4000);
      recorder.stop();
      await session.close();

      expect(recorder.frameCount).toBeGreaterThan(10);

      // Round-trip through JSON, exactly as an exported capture would.
      const { document, frames } = loadSession(recorder.toJSON());
      expect(document.notes).toBe("GX Eagle Transmission, bench test");
      expect(frames).toHaveLength(recorder.frameCount);

      // Replay into a fresh aggregator: the simulated derailleur walks the
      // cassette, so gear and shift count must both advance.
      // Gear only decodes once the component's key is known — exactly as on real
      // hardware, where the key comes from the bond.
      probe.registry.add(createSrambondDecoder(SIMULATOR_DEVICE_KEY));
      const state = new StateAggregator("sim-rd-0001", "SIM GX Eagle RD", probe.registry);
      for (const frame of frames) state.ingest(frame);

      const drivetrain = state.current().domains.drivetrain;
      expect(drivetrain?.gearRear?.value).toBeGreaterThanOrEqual(1);
      expect(drivetrain?.totalRear?.value).toBe(12);
      expect(drivetrain?.shiftCount).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("polling", () => {
  it("keeps polling when one characteristic's read hangs forever", async () => {
    // REGRESSION TEST: a GATT read that never settles used to wedge the poll
    // loop behind its in-flight guard. On real hardware this silently killed a
    // 150s capture 23s in, while the connection stayed up and the log stayed
    // clean. Every read must settle, one way or another.
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport([
        {
          id: "hangs",
          name: "Wedging device",
          services: [
            {
              uuid: "180a",
              characteristics: [
                { uuid: "2a24", value: Uint8Array.from([0x41]), properties: { read: true } },
                { uuid: "2a25", properties: { read: true }, readHangs: true },
              ],
            },
          ],
        },
      ]);

      const probe = new AxsProbe(transport);
      const session = await probe.probe("hangs", { readAll: false, subscribeAll: false });
      await session.discover();

      const stop = session.startPolling(1000, undefined, 200);

      // Several rounds, each containing a read that never resolves.
      await vi.advanceTimersByTimeAsync(6000);
      stop();

      const good = session
        .frameHistory()
        .filter((f) => f.characteristicUuid === "2a24" && f.source === "read");

      // Without the timeout this is 1 — the first round wedges and no further
      // round ever begins.
      expect(good.length).toBeGreaterThan(2);

      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling when the returned handle is called", async () => {
    vi.useFakeTimers();
    try {
      const probe = new AxsProbe(new FakeTransport());
      const session = await probe.probe("sim-rd-0001", { readAll: false, subscribeAll: false });
      await session.discover();

      const stop = session.startPolling(500);
      await vi.advanceTimersByTimeAsync(1200);
      const afterStart = session.frameHistory().length;

      stop();
      await vi.advanceTimersByTimeAsync(3000);

      expect(session.frameHistory().length).toBe(afterStart);
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("only polls characteristics that pass the filter", async () => {
    vi.useFakeTimers();
    try {
      const probe = new AxsProbe(new FakeTransport());
      const session = await probe.probe("sim-rd-0001", { readAll: false, subscribeAll: false });
      await session.discover();

      const stop = session.startPolling(500, (uuid) => uuid.toLowerCase().startsWith("2a24"));
      await vi.advanceTimersByTimeAsync(1200);
      stop();

      const polled = new Set(session.frameHistory().map((f) => f.characteristicUuid));
      expect(polled).toEqual(new Set(["2a24"]));

      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

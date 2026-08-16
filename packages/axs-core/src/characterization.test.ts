/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * Characterization: what a consumer actually ends up seeing.
 *
 * Every other test in this suite asserts a specific value inside a specific
 * module. That is the right shape for a unit test and the wrong shape for
 * catching a refactor: when logic moves between modules, each module's tests
 * can stay green while the value that reaches the CLI or the app changes.
 *
 * So this replays the whole reference capture through the pipeline a consumer
 * really uses — `loadSession` → `DecoderRegistry` → `StateAggregator` — and
 * pins the result. It asserts nothing about *correctness*; the unit tests do
 * that. It asserts only that the answer is the same as it was before, which is
 * exactly the question a refactor has to answer.
 *
 * If a change here is intended, update the snapshot and say why in the commit
 * message. If it is not intended, the refactor broke something.
 */

import { describe, expect, it } from "vitest";

import { createSrambondDecoder } from "./axs/srambond.js";
import { DecoderRegistry } from "./decode/registry.js";
import { loadSession } from "./recorder.js";
import { StateAggregator, type AxsDeviceState } from "./state.js";
import {
  RD_GX_E_B1_DEVICE_KEY,
  RD_GX_E_B1_SWEEP,
  rdGxEB1Session,
} from "./testing/rd-gx-e-b1-capture.js";

/** Replay the capture exactly as a consumer would. */
function replayCapture(): AxsDeviceState {
  // Round-tripping through JSON is deliberate: it exercises the serialisation
  // a stored capture really goes through, so a break in base64 or in the frame
  // shape shows up here rather than the first time somebody loads a file.
  const { document, frames } = loadSession(JSON.stringify(rdGxEB1Session()));

  const registry = new DecoderRegistry();
  registry.add(createSrambondDecoder(RD_GX_E_B1_DEVICE_KEY));

  const state = new StateAggregator(document.deviceId, document.deviceName, registry);
  for (const frame of frames) state.ingest(frame);

  return state.current();
}

/**
 * Reduce provenance to `decoder@confidence`.
 *
 * The full `ValueSource` carries an `updatedAt` that is stable only because the
 * capture has fixed timestamps. Keeping the decoder name and confidence in the
 * snapshot is what matters: it catches a value silently starting to come from a
 * *different*, less trustworthy decoder, which a bare value comparison misses.
 */
function provenance(state: AxsDeviceState): Record<string, string> {
  const out: Record<string, string> = {};

  const walk = (prefix: string, source: object): void => {
    for (const [key, value] of Object.entries(source)) {
      if (value && typeof value === "object" && "decoder" in value && "confidence" in value) {
        out[`${prefix}${key}`] = `${String(value.decoder)}@${String(value.confidence)}`;
      }
    }
  };

  walk("", state);
  // Domains carry their own provenance-tracked values, and a value quietly
  // changing which domain it lands in is exactly the kind of refactor slip
  // worth catching.
  for (const [domain, value] of Object.entries(state.domains)) {
    if (value && typeof value === "object") walk(`${domain}.`, value);
  }

  return out;
}

describe("characterization: replaying the RD-GX-E-B1 capture", () => {
  it("folds the capture into the same state as before", () => {
    const state = replayCapture();
    const drivetrain = state.domains.drivetrain;

    expect({
      deviceId: state.deviceId,
      deviceName: state.deviceName,
      serialNumber: state.serialNumber?.value ?? null,
      modelNumber: state.modelNumber?.value ?? null,
      firmwareRevision: state.firmwareRevision?.value ?? null,
      manufacturerName: state.manufacturerName?.value ?? null,
      batteryPercent: state.batteryPercent?.value ?? null,
      gearRear: drivetrain?.gearRear?.value ?? null,
      gearFront: drivetrain?.gearFront?.value ?? null,
      trimRear: drivetrain?.trimRear?.value ?? null,
      totalRear: drivetrain?.totalRear?.value ?? null,
      totalFront: drivetrain?.totalFront?.value ?? null,
      microAdjustCurrent: drivetrain?.microAdjustCurrent?.value ?? null,
      microAdjustMin: drivetrain?.microAdjustMin?.value ?? null,
      microAdjustMax: drivetrain?.microAdjustMax?.value ?? null,
      shiftCount: drivetrain?.shiftCount ?? 0,
      frameCount: state.frameCount,
      lastUpdateAt: state.lastUpdateAt,
    }).toMatchInlineSnapshot(`
      {
        "batteryPercent": null,
        "deviceId": "rd-gx-e-b1",
        "deviceName": "SRAM 1234567890",
        "firmwareRevision": "2.55.6",
        "frameCount": 17,
        "gearFront": 1,
        "gearRear": 12,
        "lastUpdateAt": 1754000004000,
        "manufacturerName": null,
        "microAdjustCurrent": 12,
        "microAdjustMax": 23,
        "microAdjustMin": 1,
        "modelNumber": "RD-GX-E-B1",
        "serialNumber": "1234567890",
        "shiftCount": 11,
        "totalFront": null,
        "totalRear": null,
        "trimRear": 12,
      }
    `);
  });

  it("reports only the domains the component actually has", () => {
    // A derailleur has a drivetrain and nothing else. The old flat record gave
    // every device every field; this is the property that replaced it.
    expect(Object.keys(replayCapture().domains)).toEqual(["drivetrain"]);
  });

  it("keeps every value coming from the decoder it came from before", () => {
    expect(provenance(replayCapture())).toMatchInlineSnapshot(`
      {
        "drivetrain.gearFront": "axs/srambond@0.99",
        "drivetrain.gearRear": "axs/srambond@0.99",
        "drivetrain.microAdjustCurrent": "axs/microadjust@0.92",
        "drivetrain.microAdjustMax": "axs/microadjust@0.92",
        "drivetrain.microAdjustMin": "axs/microadjust@0.92",
        "drivetrain.trimRear": "axs/srambond@0.99",
        "firmwareRevision": "axs/device-record@0.95",
        "modelNumber": "axs/model@0.95",
        "serialNumber": "axs/serial@0.97",
      }
    `);
  });

  it("reports one shift per gear change in the sweep", () => {
    // The capture walks 1→12, so eleven transitions. Stated as an arithmetic
    // relation rather than a literal so that extending the corpus updates the
    // expectation instead of breaking it.
    expect(replayCapture().domains.drivetrain?.shiftCount).toBe(RD_GX_E_B1_SWEEP.length - 1);
  });

  it("ends on the last gear in the capture", () => {
    const last = RD_GX_E_B1_SWEEP[RD_GX_E_B1_SWEEP.length - 1];
    expect(replayCapture().domains.drivetrain?.gearRear?.value).toBe(last?.[0]);
  });
});

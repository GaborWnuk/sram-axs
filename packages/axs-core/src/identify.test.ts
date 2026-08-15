/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

import { describe, expect, it } from "vitest";

import {
  SRAM_COMPANY_ID,
  identifyDevice,
  parseManufacturerData,
  summarizeScanResult,
} from "./identify.js";
import { sramManufacturerData } from "./testing/fake-transport.js";
import type { ScanResult } from "./transport.js";

function scan(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    id: "device-1",
    name: null,
    rssi: -60,
    manufacturerData: null,
    serviceUuids: [],
    serviceData: {},
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe("SRAM_COMPANY_ID", () => {
  it("is the value assigned by the Bluetooth SIG", () => {
    expect(SRAM_COMPANY_ID).toBe(0x0933);
  });
});

describe("parseManufacturerData", () => {
  it("reads the company identifier little-endian", () => {
    const data = parseManufacturerData(Uint8Array.from([0x33, 0x09, 0xaa, 0xbb]));

    expect(data?.companyId).toBe(0x0933);
    expect(data?.isSram).toBe(true);
    expect(Array.from(data!.payload)).toEqual([0xaa, 0xbb]);
  });

  it("recognises a non-SRAM company", () => {
    // 0x004C = Apple
    const data = parseManufacturerData(Uint8Array.from([0x4c, 0x00, 0x01]));
    expect(data?.isSram).toBe(false);
  });

  it("returns null for absent or truncated data", () => {
    expect(parseManufacturerData(null)).toBeNull();
    expect(parseManufacturerData(Uint8Array.from([0x33]))).toBeNull();
  });

  it("handles a company identifier with no payload", () => {
    const data = parseManufacturerData(sramManufacturerData());
    expect(data?.isSram).toBe(true);
    expect(data?.payload.length).toBe(0);
  });
});

describe("identifyDevice", () => {
  it("identifies SRAM from the company identifier alone", () => {
    const id = identifyDevice(scan({ manufacturerData: sramManufacturerData([0x01]) }));

    expect(id.isSram).toBe(true);
    expect(id.confidence).toBeGreaterThanOrEqual(0.8);
    expect(id.evidence.some((e) => e.kind === "sram-company-id")).toBe(true);
  });

  it("does not claim SRAM for another vendor", () => {
    const id = identifyDevice(scan({ manufacturerData: Uint8Array.from([0x4c, 0x00]) }));

    expect(id.isSram).toBe(false);
    expect(id.evidence.some((e) => e.kind === "other-company-id")).toBe(true);
  });

  it("stays neutral when there is no manufacturer data", () => {
    const id = identifyDevice(scan());

    expect(id.isSram).toBe(false);
    expect(id.confidence).toBe(0);
    expect(id.kind).toBe("unknown");
  });

  it("guesses a component kind from the advertised name, at low weight", () => {
    const id = identifyDevice(
      scan({ name: "GX Eagle RD", manufacturerData: sramManufacturerData() }),
    );

    expect(id.kind).toBe("rear-derailleur");
    // The name hint must never dominate; the company ID carries the weight.
    const nameEvidence = id.evidence.find((e) => e.kind === "name-hint");
    expect(nameEvidence?.weight).toBeLessThan(0.2);
    expect(nameEvidence?.detail).toMatch(/unconfirmed/i);
  });

  it("recognises other AXS component families by name", () => {
    const mfg = sramManufacturerData();
    expect(identifyDevice(scan({ name: "Reverb AXS", manufacturerData: mfg })).kind).toBe(
      "dropper-post",
    );
    expect(identifyDevice(scan({ name: "TyreWiz 2.0", manufacturerData: mfg })).kind).toBe(
      "tire-pressure",
    );
    expect(identifyDevice(scan({ name: "AXS Pod Controller", manufacturerData: mfg })).kind).toBe(
      "shifter-pod",
    );
  });

  it("does not classify a component kind for non-SRAM devices", () => {
    // REGRESSION TEST: caught on a real macOS scan. The substring "Pod" inside
    // "AirPods" matched the shifter-pod pattern, labelling a pair of headphones
    // as a bike component — worse than saying nothing, because it points you at
    // the wrong device.
    const airpods = identifyDevice(scan({ name: "AirPods Max - Find My" }));

    expect(airpods.isSram).toBe(false);
    expect(airpods.kind).toBe("unknown");
  });

  it("matches component names on word boundaries, not substrings", () => {
    const mfg = sramManufacturerData();
    // "Pod" as a substring must not match; as a word it must.
    expect(identifyDevice(scan({ name: "AirPods", manufacturerData: mfg })).kind).toBe("unknown");
    expect(identifyDevice(scan({ name: "AXS Pod", manufacturerData: mfg })).kind).toBe(
      "shifter-pod",
    );
  });

  it("never exceeds a confidence of 1", () => {
    const id = identifyDevice(
      scan({ name: "GX Eagle Transmission RD", manufacturerData: sramManufacturerData() }),
    );
    expect(id.confidence).toBeLessThanOrEqual(1);
  });

  it("exposes the vendor payload as evidence for later analysis", () => {
    const id = identifyDevice(
      scan({ manufacturerData: sramManufacturerData([0xde, 0xad, 0xbe, 0xef]) }),
    );

    const payload = id.evidence.find((e) => e.kind === "manufacturer-payload");
    expect(payload?.detail).toContain("de ad be ef");
  });
});

describe("summarizeScanResult", () => {
  it("packs the useful facts onto one line", () => {
    const summary = summarizeScanResult(
      scan({ name: "GX Eagle RD", rssi: -55, manufacturerData: sramManufacturerData([0x01, 0x02]) }),
    );

    expect(summary).toContain("GX Eagle RD");
    expect(summary).toContain("-55dBm");
    expect(summary).toContain("SRAM");
    expect(summary).toContain("rear-derailleur");
  });

  it("handles an unnamed device", () => {
    expect(summarizeScanResult(scan({ name: null }))).toContain("(unnamed)");
  });
});

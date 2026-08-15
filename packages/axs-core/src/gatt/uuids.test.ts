/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

import { describe, expect, it } from "vitest";

import {
  describeUuid,
  isInterestingUuid,
  normalizeUuid,
  shortUuid,
  uuidEquals,
} from "./uuids.js";

describe("normalizeUuid", () => {
  it("expands 16-bit UUIDs onto the SIG base", () => {
    expect(normalizeUuid("180a")).toBe("0000180a-0000-1000-8000-00805f9b34fb");
  });

  it("expands 32-bit UUIDs", () => {
    expect(normalizeUuid("1234abcd")).toBe("1234abcd-0000-1000-8000-00805f9b34fb");
  });

  it("lower-cases and re-dashes 128-bit UUIDs", () => {
    expect(normalizeUuid("6E400001B5A3F393E0A9E50E24DCCA9E")).toBe(
      "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
    );
  });

  it("tolerates a 0x prefix and surrounding whitespace", () => {
    expect(normalizeUuid("  0x180F ")).toBe("0000180f-0000-1000-8000-00805f9b34fb");
  });

  it("is idempotent", () => {
    const once = normalizeUuid("180a");
    expect(normalizeUuid(once)).toBe(once);
  });
});

describe("shortUuid", () => {
  it("collapses SIG-base UUIDs", () => {
    expect(shortUuid("0000180a-0000-1000-8000-00805f9b34fb")).toBe("0x180a");
    expect(shortUuid("180a")).toBe("0x180a");
  });

  it("returns null for vendor UUIDs", () => {
    expect(shortUuid("6e400001-b5a3-f393-e0a9-e50e24dcca9e")).toBeNull();
  });

  it("returns null for 32-bit UUIDs outside the 16-bit range", () => {
    expect(shortUuid("1234abcd")).toBeNull();
  });
});

describe("uuidEquals", () => {
  it("compares across short and long forms", () => {
    expect(uuidEquals("180a", "0000180A-0000-1000-8000-00805f9b34fb")).toBe(true);
    expect(uuidEquals("180a", "180f")).toBe(false);
  });
});

describe("describeUuid", () => {
  it("names SIG services", () => {
    const info = describeUuid("180a");
    expect(info.name).toBe("Device Information");
    expect(info.category).toBe("sig-service");
  });

  it("names SIG characteristics", () => {
    expect(describeUuid("2a26").name).toBe("Firmware Revision String");
  });

  it("flags Nordic UUIDs, which hint at the underlying silicon", () => {
    const info = describeUuid("6e400001-b5a3-f393-e0a9-e50e24dcca9e");
    expect(info.category).toBe("nordic");
    expect(info.note).toMatch(/byte-stream/i);
  });

  it("classifies unrecognised vendor UUIDs as analysis targets", () => {
    const info = describeUuid("f0000001-0451-4000-b000-000000000000");
    expect(info.category).toBe("vendor");
    expect(info.name).toBeNull();
  });

  it("classifies unrecognised SIG-range UUIDs as unknown, not vendor", () => {
    expect(describeUuid("1234").category).toBe("unknown");
  });
});

describe("isInterestingUuid", () => {
  it("is true only for unrecognised vendor UUIDs", () => {
    expect(isInterestingUuid("f0000001-0451-4000-b000-000000000000")).toBe(true);
    expect(isInterestingUuid("180a")).toBe(false);
    expect(isInterestingUuid("6e400001-b5a3-f393-e0a9-e50e24dcca9e")).toBe(false);
  });
});

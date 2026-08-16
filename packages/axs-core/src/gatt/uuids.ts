/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * GATT UUID normalisation and a knowledge base of UUIDs worth recognising when
 * enumerating an AXS component.
 *
 * Two jobs: separate the standard Bluetooth SIG entries from SRAM's
 * vendor-defined ones, and name the vendor characteristics whose meaning is
 * known. Entries marked CONFIRMED were verified against real hardware; the rest
 * are recorded so the tool can say "this is a known AXS characteristic that is
 * not decoded yet", which is more useful than "unknown".
 */

/** The Bluetooth SIG base UUID that 16- and 32-bit UUIDs expand into. */
const BASE_UUID_SUFFIX = "-0000-1000-8000-00805f9b34fb";

export type UuidCategory =
  | "sig-service"
  | "sig-characteristic"
  | "nordic"
  | "vendor"
  | "unknown";

export interface UuidInfo {
  /** Canonical lower-case 128-bit form. */
  uuid: string;
  /** Short `0xXXXX` form when the UUID is SIG-allocated, otherwise null. */
  short: string | null;
  /** Human-readable name, or null when unrecognised. */
  name: string | null;
  category: UuidCategory;
  /** Extra context shown in the demo app's GATT explorer. */
  note?: string;
}

/**
 * Expand a 16-bit (`180a`), 32-bit or already-128-bit UUID into the canonical
 * lower-case 128-bit form. Accepts values with or without `0x` and dashes,
 * because BLE stacks are inconsistent about which they hand back.
 */
export function normalizeUuid(uuid: string): string {
  const cleaned = uuid.trim().toLowerCase().replace(/^0x/, "");

  if (cleaned.length === 4) return `0000${cleaned}${BASE_UUID_SUFFIX}`;
  if (cleaned.length === 8) return `${cleaned}${BASE_UUID_SUFFIX}`;

  const undashed = cleaned.replace(/-/g, "");
  if (undashed.length === 32) {
    return [
      undashed.slice(0, 8),
      undashed.slice(8, 12),
      undashed.slice(12, 16),
      undashed.slice(16, 20),
      undashed.slice(20, 32),
    ].join("-");
  }

  // Not a recognised shape; return it lower-cased so comparisons stay stable.
  return cleaned;
}

/**
 * Collapse a 128-bit UUID back to `0xXXXX` when it sits in the SIG base range,
 * otherwise null.
 */
export function shortUuid(uuid: string): string | null {
  const normalized = normalizeUuid(uuid);
  if (!normalized.endsWith(BASE_UUID_SUFFIX)) return null;
  if (!normalized.startsWith("0000")) return null;
  return `0x${normalized.slice(4, 8)}`;
}

/** Case-insensitive UUID comparison that tolerates mixed short/long forms. */
export function uuidEquals(a: string, b: string): boolean {
  return normalizeUuid(a) === normalizeUuid(b);
}

interface KnownUuid {
  name: string;
  category: UuidCategory;
  note?: string;
}

/** Keys are canonical 128-bit UUIDs. */
const KNOWN: Record<string, KnownUuid> = {};

function register(uuid: string, entry: KnownUuid): void {
  KNOWN[normalizeUuid(uuid)] = entry;
}

// --- Bluetooth SIG services ------------------------------------------------

register("1800", { name: "Generic Access", category: "sig-service" });
register("1801", { name: "Generic Attribute", category: "sig-service" });
register("180a", {
  name: "Device Information",
  category: "sig-service",
  note: "Firmware/hardware revision and serial number live here. Usually readable without pairing.",
});
register("180f", {
  name: "Battery Service",
  category: "sig-service",
  note: "Standard 0-100% battery level. AXS may expose this in addition to a vendor-specific voltage.",
});
register("1816", { name: "Cycling Speed and Cadence", category: "sig-service" });
register("1818", { name: "Cycling Power", category: "sig-service" });
register("1826", { name: "Fitness Machine", category: "sig-service" });
register("fe59", {
  name: "Nordic Secure DFU",
  category: "nordic",
  note: "Strong hint the component runs Nordic silicon and the nRF SDK bootloader.",
});

// --- Bluetooth SIG characteristics -----------------------------------------

register("2a00", { name: "Device Name", category: "sig-characteristic" });
register("2a01", { name: "Appearance", category: "sig-characteristic" });
register("2a04", {
  name: "Peripheral Preferred Connection Parameters",
  category: "sig-characteristic",
});
register("2a19", { name: "Battery Level", category: "sig-characteristic" });
register("2a23", { name: "System ID", category: "sig-characteristic" });
register("2a24", { name: "Model Number String", category: "sig-characteristic" });
register("2a25", { name: "Serial Number String", category: "sig-characteristic" });
register("2a26", { name: "Firmware Revision String", category: "sig-characteristic" });
register("2a27", { name: "Hardware Revision String", category: "sig-characteristic" });
register("2a28", { name: "Software Revision String", category: "sig-characteristic" });
register("2a29", { name: "Manufacturer Name String", category: "sig-characteristic" });
register("2a50", { name: "PnP ID", category: "sig-characteristic" });

// --- Nordic vendor UUIDs ---------------------------------------------------
// Worth flagging explicitly: if AXS exposes a Nordic UART Service, the custom
// protocol is a byte stream rather than a structured GATT layout, which changes
// the reverse-engineering approach entirely.

register("6e400001-b5a3-f393-e0a9-e50e24dcca9e", {
  name: "Nordic UART Service (NUS)",
  category: "nordic",
  note: "A framed byte-stream pipe. If present, treat TX notifications as a protocol stream, not discrete fields.",
});
register("6e400002-b5a3-f393-e0a9-e50e24dcca9e", {
  name: "NUS RX (write)",
  category: "nordic",
});
register("6e400003-b5a3-f393-e0a9-e50e24dcca9e", {
  name: "NUS TX (notify)",
  category: "nordic",
});
register("8ec90003-f315-4f60-9fb8-838830daea50", {
  name: "Buttonless DFU Control Point",
  category: "nordic",
  note: "Writing here reboots the component into its bootloader. Do not poke this.",
});

// --- SRAM AXS vendor UUIDs -------------------------------------------------
//
// Observed on a real component (advertised name `SRAM 1234567890`) during a
// bench capture on 2026-08-01. SRAM uses a consistent vendor base:
//
//     d905XXXX-90aa-4c7c-b036-1e01fb8eb7ee
//
// plus a second family `adee000X-772[67]-453c-a069-007ea97a0add`.
//
// Only entries marked CONFIRMED have a verified meaning.

/** The 128-bit base that SRAM's vendor UUIDs are built on. */
export const SRAM_UUID_SUFFIX = "-90aa-4c7c-b036-1e01fb8eb7ee";

function sramUuid(short: string): string {
  return `d905${short}${SRAM_UUID_SUFFIX}`;
}

register("fe51", {
  name: "SRAM Device Service",
  category: "vendor",
  note: "16-bit SIG member allocation. Holds the device identity characteristics.",
});

register(sramUuid("fe54"), {
  name: "Device Serial Number",
  category: "vendor",
  note: "CONFIRMED: little-endian uint32. Matches the number in the advertised name (e.g. `SRAM 1234567890`).",
});
register(sramUuid("fe56"), {
  name: "Model / Product ID",
  category: "vendor",
  note: "CONFIRMED: little-endian uint16. 1075 = RD-GX-E-B1 (GX Eagle Transmission).",
});
register(sramUuid("fe57"), { name: "SRAM fe57 (unmapped)", category: "vendor" });
register(sramUuid("fe58"), {
  name: "Device Record (firmware + build ID)",
  category: "vendor",
  note: "CONFIRMED: firmware triplet at offset 5, stored patch-first (06 37 02 = 2.55.6). Tail holds an ASCII git build id such as g313caa0ed6.dir.",
});

register(sramUuid("0001"), { name: "SRAM device info service", category: "vendor" });
register(sramUuid("0002"), {
  name: "SRAM device descriptor",
  category: "vendor",
  note: "Embeds the serial twice plus the fe56 model bytes.",
});
register(sramUuid("0003"), {
  name: "Live State Record",
  category: "vendor",
  note: "CONFIRMED: the only plaintext characteristic that changes in use. 54 bytes; offset 50 = shift counter, 46..47 = 16-bit uptime, 14 = shift-linked analog. No gear ordinal.",
});
register(sramUuid("0054"), {
  name: "Live-state channel (encrypted)",
  category: "vendor",
  note: "ENCRYPTED live state (carries drivetrain_status incl. rd_position = current gear). 99.7% of bytes differ between consecutive reads, no two reads alike in ~195 samples: authenticated encryption (AES-EAX) with a per-message nonce. Emits content-free 0xff 'come read me' notifications. Readable only after the SRAMBond session handshake; not decodable by passive byte analysis. See PROTOCOL.md §4-§6.",
});
register(sramUuid("000b"), {
  name: "Live-state channel (encrypted)",
  category: "vendor",
  note: "ENCRYPTED live state, same scheme as d9050054 (99.6% byte turnover). Readable only after the SRAMBond session handshake. See PROTOCOL.md §4-§6.",
});
register(sramUuid("0004"), { name: "SRAM device descriptor (variant)", category: "vendor" });

register(sramUuid("000a"), {
  name: "MicroAdjust Position",
  category: "vendor",
  note: "CONFIRMED: protobuf varints — field 23 = min, 24 = current, 25 = max. Read 1/12/23 while the AXS app's MicroAdjust screen showed exactly 1, 12, 23.",
});

register(sramUuid("fff0"), { name: "SRAM fff0 service", category: "vendor" });
register(sramUuid("fff1"), { name: "SRAM fff1 (notify)", category: "vendor" });
register(sramUuid("fff2"), {
  name: "SRAM identity (protobuf)",
  category: "vendor",
  note: "CONFIRMED protobuf. Field 25 → nested field 22 = device serial.",
});

// SRAMBond — the secure-session handshake service. A Diffie-Hellman key
// agreement feeds an AES-EAX session that protects the live-state channels
// (d9050054 / d905000b). Two generations exist. The handshake requires WRITES;
// this read-only tool only labels these, it never writes to them. See PROTOCOL.md §5.
register(sramUuid("ee51"), { name: "SRAMBond v1 service", category: "vendor", note: "Secure-session handshake (v1). See PROTOCOL.md §5." });
register(sramUuid("ee52"), { name: "SRAMBond v1 bond/data", category: "vendor", note: "v1 session characteristic." });
register(sramUuid("ee53"), { name: "SRAMBond v1 token", category: "vendor", note: "v1 token characteristic — reads as high-entropy when probed passively." });
register(sramUuid("ee58"), { name: "SRAMBond v2 service", category: "vendor", note: "Secure-session handshake (v2, current). See PROTOCOL.md §5-§6." });
register(sramUuid("ee59"), { name: "SRAMBond v2 challenge", category: "vendor", note: "v2 challenge/response (session confirmation)." });
register(sramUuid("ee5a"), { name: "SRAMBond v2 KEX", category: "vendor", note: "v2 Diffie-Hellman public-key exchange." });
register(sramUuid("ee5b"), { name: "SRAMBond v2 create-bond", category: "vendor", note: "v2 bond finalize." });

/** Look up what is known about a UUID. */
export function describeUuid(uuid: string): UuidInfo {
  const normalized = normalizeUuid(uuid);
  const known = KNOWN[normalized];
  const short = shortUuid(normalized);

  if (known) {
    const info: UuidInfo = {
      uuid: normalized,
      short,
      name: known.name,
      category: known.category,
    };
    if (known.note !== undefined) info.note = known.note;
    return info;
  }

  return {
    uuid: normalized,
    short,
    name: null,
    // An unrecognised UUID outside the SIG base range is, by
    // definition, a vendor-defined one — exactly what matters here.
    category: short === null ? "vendor" : "unknown",
  };
}

/** True when the UUID is vendor-defined and unrecognised: a target for analysis. */
export function isInterestingUuid(uuid: string): boolean {
  return describeUuid(uuid).category === "vendor";
}

/** Convenience constants used by the well-known readers. */
export const DEVICE_INFORMATION_SERVICE = normalizeUuid("180a");
export const BATTERY_SERVICE = normalizeUuid("180f");
export const BATTERY_LEVEL_CHARACTERISTIC = normalizeUuid("2a19");

export const DIS_CHARACTERISTICS = {
  manufacturerName: normalizeUuid("2a29"),
  modelNumber: normalizeUuid("2a24"),
  serialNumber: normalizeUuid("2a25"),
  hardwareRevision: normalizeUuid("2a27"),
  firmwareRevision: normalizeUuid("2a26"),
  softwareRevision: normalizeUuid("2a28"),
  systemId: normalizeUuid("2a23"),
  pnpId: normalizeUuid("2a50"),
} as const;

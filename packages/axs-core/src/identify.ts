/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * Device identification from BLE advertisement data.
 *
 * The one hard fact available is SRAM's Bluetooth SIG company identifier
 * (`0x0933`), which picks AXS components out of a crowded scan without
 * connecting to anything.
 *
 * Everything past that — what the manufacturer payload *means*, how a
 * derailleur announces itself differently from a pod — is unmapped. So this
 * module reports **evidence and confidence** rather than pretending to know.
 * As you confirm byte meanings on the bench, encode them here.
 */

import { toHex, toPrintableAscii, u16le } from "./bytes.js";
import type { ScanResult } from "./transport.js";

/**
 * SRAM's assigned Bluetooth SIG company identifier.
 *
 * Source: Bluetooth SIG `company_identifiers.yaml`, entry `0x0933: SRAM`.
 * RockShox and Quarq products ship under the same identifier — there are no
 * separate allocations for them.
 */
export const SRAM_COMPANY_ID = 0x0933;

/** What kind of AXS component this appears to be. */
export type AxsDeviceKind =
  | "rear-derailleur"
  | "front-derailleur"
  | "shifter-pod"
  | "dropper-post"
  | "power-meter"
  | "tire-pressure"
  | "suspension"
  | "unknown";

/** A single reason contributing to an identification. */
export interface Evidence {
  /** Short machine-readable tag, e.g. `sram-company-id`. */
  kind: string;
  /** Human-readable explanation shown in the demo app. */
  detail: string;
  /** How much this moves the needle, 0..1. */
  weight: number;
}

export interface ManufacturerData {
  companyId: number;
  /** True when the company identifier is SRAM's. */
  isSram: boolean;
  /** Payload after the two-byte company identifier. */
  payload: Uint8Array;
}

export interface Identification {
  /** Confident this is a SRAM/AXS component. */
  isSram: boolean;
  kind: AxsDeviceKind;
  /** 0..1. Anything below ~0.5 is a guess worth double-checking. */
  confidence: number;
  evidence: Evidence[];
  manufacturerData: ManufacturerData | null;
}

/**
 * Split raw manufacturer-specific advertisement data into its little-endian
 * company identifier and the vendor payload.
 *
 * Returns null when the blob is too short to contain an identifier.
 */
export function parseManufacturerData(data: Uint8Array | null): ManufacturerData | null {
  if (!data || data.length < 2) return null;

  const companyId = u16le(data, 0);
  return {
    companyId,
    isSram: companyId === SRAM_COMPANY_ID,
    payload: data.subarray(2),
  };
}

/**
 * Name fragments observed on AXS hardware.
 *
 * ⚠️ These are hypotheses, not confirmed values. AXS advertised names have not
 * been documented publicly and none has been captured on the bench yet. Each
 * carries a low weight on purpose — the company identifier does the real work.
 * Update this table with real captures and raise the weights.
 */
const NAME_HINTS: Array<{ pattern: RegExp; kind: AxsDeviceKind; detail: string }> = [
  {
    pattern: /\bRD\b|\bderailleur\b|\beagle\b|\btransmission\b|\bxx1\b|\bx01\b|\bgx\b/i,
    kind: "rear-derailleur",
    detail: "name suggests a rear derailleur",
  },
  {
    pattern: /\bFD\b|\bfront\s*derailleur\b/i,
    kind: "front-derailleur",
    detail: "name suggests a front derailleur",
  },
  {
    pattern: /\bpod\b|\bshifter\b|\bblip\b|\brocker\b|\bcontroller\b/i,
    kind: "shifter-pod",
    detail: "name suggests a shifter/pod",
  },
  {
    pattern: /\breverb\b|\bdropper\b|\bseatpost\b/i,
    kind: "dropper-post",
    detail: "name suggests a dropper post",
  },
  {
    pattern: /\bquarq\b|\bdzero\b|\bdub\s*pm\b|\bpower\s*meter\b/i,
    kind: "power-meter",
    detail: "name suggests a power meter",
  },
  {
    pattern: /\btyrewiz\b|\btirewiz\b/i,
    kind: "tire-pressure",
    detail: "name suggests a tyre pressure sensor",
  },
  {
    pattern: /\bflight\s*attendant\b|\bshock\b|\bfork\b/i,
    kind: "suspension",
    detail: "name suggests a suspension component",
  },
];

/**
 * Identify a scanned device.
 *
 * The company identifier is treated as near-conclusive for "this is SRAM".
 * Component *kind* is deliberately low-confidence until the advertisement
 * payload is mapped.
 */
export function identifyDevice(result: ScanResult): Identification {
  const evidence: Evidence[] = [];
  const manufacturerData = parseManufacturerData(result.manufacturerData);

  let isSram = false;
  let kind: AxsDeviceKind = "unknown";
  let confidence = 0;

  if (manufacturerData?.isSram) {
    isSram = true;
    confidence += 0.8;
    evidence.push({
      kind: "sram-company-id",
      detail: `Manufacturer data carries SRAM's Bluetooth company ID (0x${SRAM_COMPANY_ID.toString(16).padStart(4, "0")})`,
      weight: 0.8,
    });

    if (manufacturerData.payload.length > 0) {
      evidence.push({
        kind: "manufacturer-payload",
        detail: `Vendor payload (${manufacturerData.payload.length} bytes): ${toHex(manufacturerData.payload)}`,
        weight: 0,
      });
    }
  } else if (manufacturerData) {
    evidence.push({
      kind: "other-company-id",
      detail: `Manufacturer data belongs to company 0x${manufacturerData.companyId
        .toString(16)
        .padStart(4, "0")}, not SRAM`,
      weight: 0,
    });
  }

  // Observed on real hardware: AXS components advertise a local name of the
  // form "SRAM <serial>", where the number is the little-endian uint32 serial
  // also exposed by characteristic d905fe54. That is strong enough to stand on
  // its own if manufacturer data is absent from a given advertisement.
  const sramName = result.name ? /^SRAM\s+(\d+)\s*$/i.exec(result.name) : null;
  if (sramName) {
    if (!isSram) {
      isSram = true;
      confidence += 0.7;
    }
    evidence.push({
      kind: "sram-name-serial",
      detail: `Advertised name "${result.name}" matches the AXS "SRAM <serial>" pattern; serial ${sramName[1]}`,
      weight: 0.7,
    });
  }

  // Component classification is only attempted for devices already believed
  // are SRAM. Name matching alone is far too weak to stand on its own: an
  // earlier revision of this happily labelled "AirPods Max" a shifter-pod,
  // which is worse than saying nothing — it sends you probing the wrong device.
  if (result.name && isSram) {
    for (const hint of NAME_HINTS) {
      if (hint.pattern.test(result.name)) {
        kind = hint.kind;
        confidence += 0.15;
        evidence.push({
          kind: "name-hint",
          detail: `Advertised name "${result.name}" ${hint.detail} (unconfirmed heuristic)`,
          weight: 0.15,
        });
        break;
      }
    }
  }

  return {
    isSram,
    kind,
    confidence: Math.min(confidence, 1),
    evidence,
    manufacturerData,
  };
}

/**
 * One-line summary of an advertisement for the raw scan log.
 *
 * Deliberately dense — when you are staring at a scan list on a phone screen
 * next to a bike, you want everything on one row.
 */
export function summarizeScanResult(result: ScanResult): string {
  const id = identifyDevice(result);
  const parts: string[] = [];

  parts.push(result.name ?? "(unnamed)");
  if (result.rssi !== null) parts.push(`${result.rssi}dBm`);
  if (id.isSram) parts.push("SRAM");
  if (id.kind !== "unknown") parts.push(id.kind);

  if (id.manufacturerData && id.manufacturerData.payload.length > 0) {
    const payload = id.manufacturerData.payload;
    parts.push(`mfg=${toHex(payload.subarray(0, 8))}${payload.length > 8 ? "…" : ""}`);
    const ascii = toPrintableAscii(payload, "");
    if (ascii.length >= 4) parts.push(`"${ascii}"`);
  }

  return parts.join(" · ");
}

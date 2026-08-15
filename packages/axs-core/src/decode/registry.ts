/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * The decoder registry.
 *
 * Decoders are pure functions over a {@link RawFrame}. Every decoder gets shown
 * every frame and may decline. Results are sorted by confidence so the log view
 * can show the best interpretation while keeping the speculative ones available.
 *
 * Adding knowledge as you reverse-engineer means writing a new decoder here —
 * no changes to the transport, probe or UI.
 */

import { toUtf8 } from "../bytes.js";
import { AXS_DECODERS } from "../axs/device-info.js";
import type { Decoder, DecodedResult, RawFrame } from "../frame.js";
import {
  BATTERY_LEVEL_CHARACTERISTIC,
  DIS_CHARACTERISTICS,
  describeUuid,
  normalizeUuid,
} from "../gatt/uuids.js";
import { analyzeBytes } from "./heuristics.js";
import {
  flattenProtobuf,
  formatProtobuf,
  looksLikeProtobuf,
  parseProtobuf,
} from "./protobuf.js";

/** Device Information Service string characteristics, keyed by UUID. */
const DIS_STRING_FIELDS: Record<string, string> = {
  [DIS_CHARACTERISTICS.manufacturerName]: "manufacturerName",
  [DIS_CHARACTERISTICS.modelNumber]: "modelNumber",
  [DIS_CHARACTERISTICS.serialNumber]: "serialNumber",
  [DIS_CHARACTERISTICS.hardwareRevision]: "hardwareRevision",
  [DIS_CHARACTERISTICS.firmwareRevision]: "firmwareRevision",
  [DIS_CHARACTERISTICS.softwareRevision]: "softwareRevision",
};

/**
 * Standard Device Information Service strings.
 *
 * High confidence: the UUIDs are SIG-assigned and the encoding is specified.
 * This is the first real data you will get out of an AXS component.
 */
export const disStringDecoder: Decoder = {
  name: "gatt/device-information",
  decode(frame: RawFrame): DecodedResult | null {
    if (!frame.characteristicUuid) return null;

    const uuid = normalizeUuid(frame.characteristicUuid);
    const field = DIS_STRING_FIELDS[uuid];
    if (!field) return null;

    const value = toUtf8(frame.data).replace(/\0+$/, "");
    return {
      decoder: this.name,
      confidence: 0.99,
      summary: `${field}: ${value}`,
      fields: { [field]: value },
    };
  },
};

/** Standard Battery Service level, 0-100%. */
export const batteryLevelDecoder: Decoder = {
  name: "gatt/battery-level",
  decode(frame: RawFrame): DecodedResult | null {
    if (!frame.characteristicUuid) return null;
    if (normalizeUuid(frame.characteristicUuid) !== BATTERY_LEVEL_CHARACTERISTIC) return null;
    if (frame.data.length < 1) return null;

    const percent = frame.data[0] as number;
    return {
      decoder: this.name,
      confidence: 0.99,
      summary: `Battery: ${percent}%`,
      fields: { batteryPercent: percent },
    };
  },
};

/**
 * Structural decode of protobuf payloads.
 *
 * Several AXS vendor characteristics carry protobuf. Without a `.proto` schema
 * the fields cannot be named, but recovering the *shape* — field numbers, types,
 * nesting — turns an opaque blob into something you can reason about, and is
 * the single most useful lever for mapping the rest of the protocol.
 */
export const protobufDecoder: Decoder = {
  name: "protobuf/structure",
  decode(frame: RawFrame): DecodedResult | null {
    if (!looksLikeProtobuf(frame.data)) return null;

    const message = parseProtobuf(frame.data);
    const flat = flattenProtobuf(message.fields);

    return {
      decoder: this.name,
      confidence: 0.6,
      summary: `protobuf: ${flat.map((f) => `${f.path}=${f.value}`).join(" ")}`,
      fields: {
        protobuf: true,
        fieldCount: message.fields.length,
        tree: formatProtobuf(message.fields),
        values: Object.fromEntries(flat.map((f) => [f.path, f.value])),
      },
    };
  },
};

/**
 * Always-on fallback. Produces the hex/ascii/entropy view so no frame is ever
 * displayed as nothing at all.
 */
export const heuristicDecoder: Decoder = {
  name: "heuristic",
  decode(frame: RawFrame): DecodedResult | null {
    if (frame.data.length === 0) {
      return {
        decoder: this.name,
        confidence: 0.01,
        summary: "(empty payload)",
        fields: { length: 0 },
      };
    }

    const analysis = analyzeBytes(frame.data);
    const notes: string[] = [`${analysis.length}B`];
    if (analysis.looksLikeText) notes.push(`text "${analysis.ascii}"`);
    if (analysis.entropy > 7) notes.push(`high entropy ${analysis.entropy.toFixed(2)}`);

    return {
      decoder: this.name,
      confidence: 0.05,
      summary: `${analysis.hex}  (${notes.join(", ")})`,
      // The full integer candidate list is intentionally omitted here to keep
      // stored sessions small; call analyzeBytes directly when you need it.
      fields: {
        hex: analysis.hex,
        ascii: analysis.ascii,
        length: analysis.length,
        entropy: analysis.entropy,
        looksLikeText: analysis.looksLikeText,
      },
    };
  },
};

/** Annotates frames from vendor-defined (unrecognised) UUIDs as analysis targets. */
export const vendorCharacteristicDecoder: Decoder = {
  name: "gatt/vendor-characteristic",
  decode(frame: RawFrame): DecodedResult | null {
    if (!frame.characteristicUuid) return null;

    const info = describeUuid(frame.characteristicUuid);
    if (info.category !== "vendor") return null;

    return {
      decoder: this.name,
      confidence: 0.1,
      summary: `Vendor characteristic ${info.uuid} — undocumented, analysis target`,
      fields: { uuid: info.uuid, vendorDefined: true },
    };
  },
};

/** The decoders enabled by default. */
export const DEFAULT_DECODERS: Decoder[] = [
  disStringDecoder,
  batteryLevelDecoder,
  ...AXS_DECODERS,
  protobufDecoder,
  vendorCharacteristicDecoder,
  heuristicDecoder,
];

/** Holds a decoder set and applies it to frames. */
export class DecoderRegistry {
  private decoders: Decoder[];

  constructor(decoders: Decoder[] = DEFAULT_DECODERS) {
    this.decoders = [...decoders];
  }

  add(decoder: Decoder): void {
    this.decoders.push(decoder);
  }

  remove(name: string): void {
    this.decoders = this.decoders.filter((d) => d.name !== name);
  }

  list(): readonly Decoder[] {
    return this.decoders;
  }

  /** Apply every decoder, highest confidence first. */
  decode(frame: RawFrame): DecodedResult[] {
    const results: DecodedResult[] = [];

    for (const decoder of this.decoders) {
      try {
        const result = decoder.decode(frame);
        if (result) results.push(result);
      } catch (error) {
        // A decoder must never break the capture pipeline — losing the frame is
        // worse than losing one interpretation of it.
        results.push({
          decoder: decoder.name,
          confidence: 0,
          summary: `decoder threw: ${error instanceof Error ? error.message : String(error)}`,
          fields: { error: true },
        });
      }
    }

    return results.sort((a, b) => b.confidence - a.confidence);
  }

  /** The single most confident interpretation, or null when nothing matched. */
  best(frame: RawFrame): DecodedResult | null {
    return this.decode(frame)[0] ?? null;
  }
}

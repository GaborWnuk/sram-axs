/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

import { describe, expect, it, vi } from "vitest";

import { fromHex } from "../bytes.js";
import { decryptLiveStateFrame } from "./srambond.js";
import {
  AXS_MESSAGES,
  defineMessage,
  routeMessage,
  unmappedMessage,
  type AnyMessageProfile,
} from "./messages.js";
import {
  RD_GX_E_B1_DEVICE_KEY,
  RD_GX_E_B1_SWEEP,
} from "../testing/rd-gx-e-b1-capture.js";

/** Encode one protobuf `uint32` field (wire type 0). */
function uint32Field(fieldNumber: number, value: number): number[] {
  const out: number[] = [];
  let tag = fieldNumber << 3;
  do {
    out.push(tag > 0x7f ? (tag & 0x7f) | 0x80 : tag & 0x7f);
    tag >>>= 7;
  } while (tag > 0);

  let v = value;
  do {
    out.push(v > 0x7f ? (v & 0x7f) | 0x80 : v & 0x7f);
    v >>>= 7;
  } while (v > 0);

  return out;
}

const message = (...fields: number[][]): Uint8Array => Uint8Array.from(fields.flat());

describe("routeMessage", () => {
  it("routes a real captured drivetrain_status to the gear", () => {
    // Ground truth rather than a synthetic payload: the same bytes the
    // component produced for gear 7.
    const [gear, frameHex] = RD_GX_E_B1_SWEEP[6]!;
    const plaintext = decryptLiveStateFrame(RD_GX_E_B1_DEVICE_KEY, fromHex(frameHex));

    const routed = routeMessage(plaintext);

    expect(gear).toBe(7);

    expect(routed?.profile).toBe("drivetrain_status");
    expect(routed?.fields.gearRear).toBe(7);
    expect(routed?.summary).toBe("gear 7");
  });

  it("routes drivetrain_config to the cog counts", () => {
    const routed = routeMessage(
      message(uint32Field(23, 2), uint32Field(24, 12), uint32Field(25, 3)),
    );

    expect(routed?.profile).toBe("drivetrain_config");
    expect(routed?.fields).toMatchObject({ totalRear: 12, totalFront: 2, trimCount: 3 });
  });

  it("tells the two drivetrain messages apart on the same channel", () => {
    // Both arrive on d905000b; only the field numbers separate them. Getting
    // this wrong would report a cog count as a gear.
    const status = routeMessage(message(uint32Field(21, 4)));
    const config = routeMessage(message(uint32Field(24, 12)));

    expect(status?.profile).toBe("drivetrain_status");
    expect(config?.profile).toBe("drivetrain_config");
  });

  it("declines a plaintext no profile recognises", () => {
    expect(routeMessage(message(uint32Field(99, 1)))).toBeNull();
  });

  it("records which profile decoded a message", () => {
    // The aggregator and the log view both need to know what a value *is*, not
    // just that something decrypted.
    expect(routeMessage(message(uint32Field(21, 4)))?.fields.decodedMessage).toBe(
      "drivetrain_status",
    );
  });
});

describe("extending the vocabulary", () => {
  /**
   * The point of the profile registry: teaching the library a new component's
   * message must not require touching the crypto, the decoder or the transport.
   * This is that claim, tested — a message on field numbers no AXS drivetrain
   * uses, routed by registration alone.
   */
  const dropperStatus = defineMessage<{ postPosition: number }>({
    name: "dropper_status",
    fieldNumbers: [30],
    decode(plaintext) {
      const field = plaintext[0] === 0xf0 && plaintext[1] === 0x01 ? plaintext[2] : undefined;
      return field === undefined ? null : { postPosition: field };
    },
    toFields: (value) => ({ postPosition: value.postPosition }),
    summarize: (value) => `post ${String(value.postPosition)}`,
  });

  // No cast: a profile decoding to its own type sits in the same registry as
  // the drivetrain ones, which is the whole point of `defineMessage`.
  const withDropper = [...AXS_MESSAGES, dropperStatus];

  it("routes a message the built-in profiles do not know", () => {
    const routed = routeMessage(message(uint32Field(30, 42)), withDropper);

    expect(routed?.profile).toBe("dropper_status");
    expect(routed?.fields).toMatchObject({ postPosition: 42, decodedMessage: "dropper_status" });
  });

  it("leaves the drivetrain messages working alongside it", () => {
    expect(routeMessage(message(uint32Field(21, 9)), withDropper)?.fields.gearRear).toBe(9);
  });

  it("never calls a profile whose field numbers are absent", () => {
    // The pre-filter is what keeps a long profile list cheap: every frame is
    // shown to every profile, four times a second, on a phone.
    const route = vi.fn(() => null);
    const never: AnyMessageProfile = { name: "never", fieldNumbers: [77], route };

    routeMessage(message(uint32Field(21, 4)), [never]);

    expect(route).not.toHaveBeenCalled();
  });
});

describe("unmappedMessage", () => {
  it("surfaces the bytes and the field numbers for a message nobody claimed", () => {
    // An authenticated message the library cannot read is a reverse-engineering
    // lead, not an error, so it has to carry enough to work from.
    const unmapped = unmappedMessage(message(uint32Field(41, 7)));

    expect(unmapped.profile).toBe("unmapped");
    expect(unmapped.fields.decryptedFieldNumbers).toEqual([41]);
    // tag = 41 << 3 = 328, varint-encoded as c8 02; then the value 7.
    expect(unmapped.fields.decryptedHex).toBe("c80207");
    expect(unmapped.confidence).toBeLessThan(0.99);
  });
});

/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * The primary screen: pair with a component, then read its gear.
 *
 * This is the reference example of using the library end to end — `usePairing`
 * wraps `createBond`, and the key is persisted between sessions so pairing
 * happens exactly once.
 *
 * Note how gear arrives here: `watchLiveState` polls the session's own link.
 * Two things force that shape, both learned on hardware.
 *
 * An AXS component serves one central at a time, so asking Android for a second
 * connection to an already-connected peripheral closes the first — a
 * `GearWatcher` here would tear down the very session it sits on. And the
 * live-state characteristic notifies only a one-byte `0xff` doorbell, never the
 * frame itself, so subscribing produces a stream of undecodable frames and a
 * gear that never appears. Reading is what actually yields state.
 *
 * `GearWatcher` remains the right tool where nothing else holds the link — see
 * the dashboard, which uses it directly.
 */

import React, { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { toHex, watchLiveState } from "@axs/core";

import { forgetDeviceKey } from "../key-store";
import { usePairing } from "../hooks/use-pairing";
import { useProbe } from "../probe-context";
import { useTheme } from "../theme";
import { Badge, Button, Card, Row, SectionTitle } from "./ui";

export function LiveGear({ deviceId }: { deviceId: string }) {
  const theme = useTheme();
  const { transport, session, liveGear: gear, setLiveGear } = useProbe();
  const pairing = usePairing(transport);

  const [readError, setReadError] = useState<string | null>(null);

  // A component paired on a previous run needs no button press: the stored key
  // is enough, and reading with it never writes to the device.
  useEffect(() => {
    void pairing.restore(deviceId);
  }, [deviceId, pairing.restore]);

  // Poll live state over the session's link once a key is known.
  useEffect(() => {
    const link = session?.link;
    if (!pairing.deviceKey || !link) return;

    setReadError(null);
    const stop = watchLiveState(link, {
      deviceKey: pairing.deviceKey,
      onState: (state) => {
        setReadError(null);
        if (typeof state.gearRear === "number") setLiveGear(state.gearRear);
      },
      // A failed decode usually means a stale key — the component re-keys on
      // every bond, so a key from a previous pairing no longer authenticates.
      onError: (error) => setReadError(error.message),
    });

    return stop;
  }, [pairing.deviceKey, session, setLiveGear]);

  const connected = session !== null && !session.isClosed;

  const unpair = async () => {
    await forgetDeviceKey(deviceId);
    pairing.reset();
  };

  // --- not paired yet -------------------------------------------------------
  if (pairing.stage !== "paired") {
    return (
      <View style={styles.container}>
        <SectionTitle>Pairing</SectionTitle>
        <Card>
          <Text style={[styles.body, { color: theme.textDim }]}>
            Current gear travels on an encrypted channel. Pair once to obtain this
            component&apos;s key; after that, reading is ordinary and read-only.
          </Text>

          {pairing.stage === "awaiting-button" && (
            <View style={[styles.callout, { borderColor: theme.accent, backgroundColor: theme.accentDim }]}>
              <Text style={[styles.calloutTitle, { color: theme.text }]}>
                Hold the AXS button
              </Text>
              <Text style={[styles.body, { color: theme.textDim }]}>
                Press and hold the button on the component until its light blinks,
                then release and tap Ready. The component only accepts a new bond
                while it is in pairing mode.
              </Text>
              <Button title="Ready — it's blinking" tone="accent" onPress={pairing.confirmPairingMode} />
            </View>
          )}

          {(pairing.stage === "connecting" || pairing.stage === "exchanging") && (
            <Row label="Status" value={pairing.step ?? `${pairing.stage}…`} />
          )}

          {pairing.error && (
            <Text style={[styles.error, { color: theme.danger }]}>{pairing.error}</Text>
          )}

          {(pairing.stage === "idle" || pairing.stage === "failed") && (
            <Button
              title={pairing.stage === "failed" ? "Try pairing again" : "Pair with this component"}
              tone="accent"
              // Bond over the session's own link rather than a second
              // connection, which would tear this session down.
              onPress={() => void pairing.pair(deviceId, session?.link)}
            />
          )}

          {(pairing.stage === "connecting" || pairing.stage === "exchanging") && (
            <ActivityIndicator color={theme.accent} style={styles.spinner} />
          )}
        </Card>

        <Text style={[styles.footnote, { color: theme.textFaint }]}>
          Pairing writes only to the SRAMBond service, never the firmware path. It
          makes the component mint a fresh key, so the official SRAM app will
          re-pair itself the next time it connects.
        </Text>
      </View>
    );
  }

  // --- paired: show live gear ----------------------------------------------
  return (
    <View style={styles.container}>
      <SectionTitle>Live gear</SectionTitle>

      <Card>
        <View style={styles.gearBlock}>
          <Text style={[styles.gearValue, { color: gear === null ? theme.textFaint : theme.text }]}>
            {gear ?? "—"}
          </Text>
          <Text style={[styles.gearCaption, { color: theme.textDim }]}>
            {gear === null ? "waiting for a frame" : "rear gear"}
          </Text>
        </View>

        <View style={styles.statusRow}>
          <Badge
            tone={connected ? "success" : "neutral"}
            label={connected ? "connected" : "not connected"}
          />
        </View>

        {readError && (
          <Text style={[styles.warning, { color: theme.textDim }]}>{readError}</Text>
        )}
      </Card>

      <SectionTitle>Bond</SectionTitle>
      <Card>
        <Row
          label="Device key"
          value={pairing.deviceKey ? `${toHex(pairing.deviceKey, "").slice(0, 8)}…` : "—"}
          monospace
        />
        <Text style={[styles.footnote, { color: theme.textFaint }]}>
          Stored in the device keychain. Reading with it never writes to the
          component; re-pairing would replace it with a new key.
        </Text>
        <Button title="Forget this component" tone="neutral" onPress={() => void unpair()} />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 8 },
  body: { fontSize: 14, lineHeight: 20 },
  footnote: { fontSize: 12, lineHeight: 17, marginTop: 4 },
  error: { fontSize: 13, lineHeight: 18, marginTop: 8 },
  spinner: { marginTop: 12, alignSelf: "flex-start" },
  callout: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 10, marginTop: 12 },
  calloutTitle: { fontSize: 15, fontWeight: "700" },
  gearBlock: { alignItems: "center", paddingVertical: 12 },
  gearValue: { fontSize: 96, fontWeight: "800", lineHeight: 104 },
  gearCaption: { fontSize: 13, marginTop: -4 },
  statusRow: { flexDirection: "row", justifyContent: "center", marginTop: 4 },
  warning: { fontSize: 12, textAlign: "center", marginTop: 8 },
});

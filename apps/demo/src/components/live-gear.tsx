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
 * This is the reference example of using the library end to end —
 * `usePairing` wraps `createBond`, `useGearWatcher` wraps `GearWatcher`, and the
 * key is persisted between sessions so pairing happens exactly once.
 */

import React, { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { toHex, type GearWatcherStatus } from "@axs/core";

import { forgetDeviceKey } from "../key-store";
import { useGearWatcher } from "../hooks/use-gear-watcher";
import { usePairing } from "../hooks/use-pairing";
import { useProbe } from "../probe-context";
import { useTheme } from "../theme";
import { Badge, Button, Card, Row, SectionTitle } from "./ui";

function statusTone(status: GearWatcherStatus): "success" | "warning" | "neutral" {
  if (status === "connected") return "success";
  if (status === "stopped") return "neutral";
  return "warning";
}

function statusLabel(status: GearWatcherStatus, attempt: number): string {
  switch (status) {
    case "connected":
      return "connected";
    case "connecting":
      return "connecting…";
    case "reconnecting":
      return attempt > 0 ? `reconnecting (attempt ${attempt})` : "reconnecting…";
    case "stopped":
      return "stopped";
  }
}

export function LiveGear({ deviceId }: { deviceId: string }) {
  const theme = useTheme();
  const { transport } = useProbe();
  const pairing = usePairing(transport);

  // A component paired on a previous run needs no button press: the stored key
  // is enough, and reading with it never writes to the device.
  useEffect(() => {
    void pairing.restore(deviceId);
  }, [deviceId, pairing.restore]);

  const watcher = useGearWatcher(transport, deviceId, pairing.deviceKey);

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
              onPress={() => void pairing.pair(deviceId)}
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
          <Text style={[styles.gearValue, { color: watcher.gear === null ? theme.textFaint : theme.text }]}>
            {watcher.gear ?? "—"}
          </Text>
          <Text style={[styles.gearCaption, { color: theme.textDim }]}>
            {watcher.gear === null ? "waiting for a frame" : "rear gear"}
          </Text>
        </View>

        <View style={styles.statusRow}>
          <Badge
            tone={statusTone(watcher.status)}
            label={statusLabel(watcher.status, watcher.attempt)}
          />
        </View>

        {watcher.warning && (
          <Text style={[styles.warning, { color: theme.textDim }]}>{watcher.warning}</Text>
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

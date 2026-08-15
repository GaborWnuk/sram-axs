/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * Ride dashboard — GPS speed next to the current gear.
 *
 * Honest about provenance: GPS speed is a real, trustworthy reading. The gear
 * comes from a decoder whose confidence is tracked, and when that confidence is
 * low the UI says so rather than presenting a guess as a measurement.
 */

import { useRouter } from "expo-router";
import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button, Card, EmptyState, Row, SectionTitle } from "../src/components/ui";
import { useGpsSpeed } from "../src/hooks/use-gps-speed";
import { useProbe } from "../src/probe-context";
import { useTheme } from "../src/theme";

/** Big numeric readout with a unit and an optional caveat line. */
function Readout({
  value,
  unit,
  label,
  caveat,
  tone,
}: {
  value: string;
  unit: string;
  label: string;
  caveat?: string;
  tone?: "normal" | "uncertain";
}) {
  const theme = useTheme();
  const color = tone === "uncertain" ? theme.textDim : theme.text;

  return (
    <Card style={styles.readoutCard}>
      <Text style={[styles.readoutLabel, { color: theme.textDim }]}>{label}</Text>
      <View style={styles.readoutValueRow}>
        <Text style={[styles.readoutValue, { color, fontFamily: theme.mono }]}>{value}</Text>
        <Text style={[styles.readoutUnit, { color: theme.textFaint }]}>{unit}</Text>
      </View>
      {caveat ? (
        <Text style={[styles.readoutCaveat, { color: theme.warning }]}>{caveat}</Text>
      ) : null}
    </Card>
  );
}

export default function DashboardScreen() {
  const router = useRouter();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { session, deviceState } = useProbe();
  const gps = useGpsSpeed(true);

  const gear = deviceState?.gearRear ?? null;
  const totalRear = deviceState?.totalRear?.value ?? null;
  const gearIsSpeculative = gear !== null && gear.confidence < 0.8;

  const speedText =
    gps.speedKph === null ? "--.-" : gps.speedKph.toFixed(1).padStart(4, " ");

  return (
    <ScrollView
      style={{ backgroundColor: theme.bg }}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
    >
      <Readout
        label="GPS SPEED"
        value={speedText}
        unit="km/h"
        caveat={
          gps.permissionGranted === false
            ? "Location permission denied — grant it in system settings."
            : gps.speedKph === null
              ? "Waiting for a speed fix. Requires movement outdoors."
              : undefined
        }
      />

      <Readout
        label="REAR GEAR"
        value={gear ? String(gear.value) : "—"}
        unit={totalRear ? `of ${totalRear}` : ""}
        tone={gearIsSpeculative ? "uncertain" : "normal"}
        caveat={
          !session
            ? "Not connected to a component."
            : gear === null
              ? "No gear decoded yet. The AXS BLE protocol is undocumented — see the Analysis tab to map it."
              : gearIsSpeculative
                ? `Speculative (${gear.decoder}, confidence ${gear.confidence.toFixed(2)}). Verify against the physical cog.`
                : undefined
        }
      />

      {!session ? (
        <EmptyState
          title="No component connected"
          detail="Connect to an AXS component to see gear data here."
        />
      ) : (
        <Card>
          <SectionTitle>Telemetry</SectionTitle>
          <Row label="Component" value={session.deviceName ?? session.deviceId} />
          <Row label="Shifts observed" value={String(deviceState?.shiftCount ?? 0)} monospace />
          <Row
            label="Battery"
            value={
              deviceState?.batteryPercent ? `${deviceState.batteryPercent.value}%` : "—"
            }
            dim={!deviceState?.batteryPercent}
            monospace
          />
          <Row label="Frames" value={String(deviceState?.frameCount ?? 0)} monospace />
        </Card>
      )}

      <Card>
        <SectionTitle>GPS detail</SectionTitle>
        <Row
          label="Speed (m/s)"
          value={gps.speedMps === null ? "—" : gps.speedMps.toFixed(2)}
          dim={gps.speedMps === null}
          monospace
        />
        <Row
          label="Accuracy"
          value={gps.accuracyM === null ? "—" : `±${gps.accuracyM.toFixed(0)} m`}
          dim={gps.accuracyM === null}
          monospace
        />
        <Row
          label="Position"
          value={
            gps.latitude === null || gps.longitude === null
              ? "—"
              : `${gps.latitude.toFixed(5)}, ${gps.longitude.toFixed(5)}`
          }
          dim={gps.latitude === null}
          monospace
        />
        {gps.error ? (
          <Text style={[styles.error, { color: theme.danger }]}>{gps.error}</Text>
        ) : null}
      </Card>

      <Button title="Back to scan" tone="neutral" onPress={() => router.back()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 14 },
  readoutCard: { alignItems: "center", paddingVertical: 22 },
  readoutLabel: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.4,
  },
  readoutValueRow: { flexDirection: "row", alignItems: "baseline", marginTop: 6 },
  readoutValue: { fontSize: 62, fontWeight: "700", letterSpacing: -2 },
  readoutUnit: { fontSize: 16, marginLeft: 8, fontWeight: "600" },
  readoutCaveat: {
    fontSize: 11,
    marginTop: 10,
    textAlign: "center",
    lineHeight: 16,
    paddingHorizontal: 8,
  },
  error: { fontSize: 12, marginTop: 8 },
});

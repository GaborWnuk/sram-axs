/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * Scan screen.
 *
 * Scans unfiltered rather than filtering on SRAM's company ID — a component
 * that is asleep or advertising unexpectedly would be invisible under a filter,
 * and "my derailleur isn't showing up" is exactly what you'd open this to debug.
 *
 * The *list* defaults to SRAM only, because that is what you are here for. The
 * filter is a view over a complete scan, not a narrower scan, so "Show all"
 * reveals everything already seen without needing to scan again.
 */

import { useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { toHex, type DiscoveredDevice } from "@axs/core";

import { Badge, Button, Card, EmptyState, SectionTitle } from "../src/components/ui";
import { useProbe } from "../src/probe-context";
import { rssiColor, useTheme } from "../src/theme";

function DeviceRow({
  device,
  onPress,
  connecting,
}: {
  device: DiscoveredDevice;
  onPress: () => void;
  connecting: boolean;
}) {
  const theme = useTheme();
  const { result, identification, sightings } = device;
  const payload = identification.manufacturerData?.payload;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.deviceRow,
        {
          backgroundColor: pressed ? theme.surfaceAlt : theme.surface,
          borderColor: identification.isSram ? theme.accent : theme.border,
          borderLeftWidth: identification.isSram ? 3 : StyleSheet.hairlineWidth,
        },
      ]}
    >
      <View style={styles.deviceHeader}>
        <Text style={[styles.deviceName, { color: theme.text }]} numberOfLines={1}>
          {result.name ?? "(unnamed device)"}
        </Text>
        <Text style={[styles.rssi, { color: rssiColor(result.rssi, theme) }]}>
          {result.rssi ?? "—"} dBm
        </Text>
      </View>

      <Text
        style={[styles.deviceId, { color: theme.textFaint, fontFamily: theme.mono }]}
        numberOfLines={1}
      >
        {result.id}
      </Text>

      <View style={styles.badges}>
        {identification.isSram ? <Badge label="SRAM 0x0933" tone="accent" /> : null}
        {identification.kind !== "unknown" ? (
          <Badge label={identification.kind} tone="vendor" />
        ) : null}
        {identification.confidence > 0 ? (
          <Badge label={`conf ${identification.confidence.toFixed(2)}`} />
        ) : null}
        <Badge label={`${sightings} adv`} />
        {connecting ? <Badge label="connecting…" tone="warning" /> : null}
      </View>

      {payload && payload.length > 0 ? (
        <Text style={[styles.mfg, { color: theme.textDim, fontFamily: theme.mono }]}>
          mfg: {toHex(payload)}
        </Text>
      ) : null}
    </Pressable>
  );
}

export default function ScanScreen() {
  const router = useRouter();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const {
    devices,
    isScanning,
    startScan,
    stopScan,
    clearDevices,
    connect,
    connectingId,
    session,
    transportMode,
    setTransportMode,
    error,
    clearError,
  } = useProbe();

  const onSelect = useCallback(
    async (deviceId: string) => {
      await connect(deviceId);
      router.push(`/device/${encodeURIComponent(deviceId)}`);
    },
    [connect, router],
  );

  // Filtering happens here, on the rendered list, and never on the scan itself.
  // A radio-level filter would hide a component advertising without the
  // expected company ID — exactly the case worth seeing.
  const [sramOnly, setSramOnly] = useState(true);

  const sramCount = devices.filter((d) => d.identification.isSram).length;
  const visible = sramOnly ? devices.filter((d) => d.identification.isSram) : devices;
  const hidden = devices.length - visible.length;

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <FlatList
        data={visible}
        keyExtractor={(item) => item.result.id}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 24 }]}
        ListHeaderComponent={
          <View>
            {error ? (
              <Pressable onPress={clearError}>
                <Card style={{ borderColor: theme.danger }}>
                  <Text style={[styles.errorText, { color: theme.danger }]}>{error}</Text>
                  <Text style={[styles.errorHint, { color: theme.textFaint }]}>
                    Tap to dismiss
                  </Text>
                </Card>
              </Pressable>
            ) : null}

            <Card>
              <SectionTitle>Transport</SectionTitle>
              <View style={styles.buttonRow}>
                <Button
                  title="Bluetooth"
                  tone={transportMode === "bluetooth" ? "accent" : "neutral"}
                  onPress={() => setTransportMode("bluetooth")}
                  style={styles.flexButton}
                />
                <Button
                  title="Simulator"
                  tone={transportMode === "simulator" ? "accent" : "neutral"}
                  onPress={() => setTransportMode("simulator")}
                  style={styles.flexButton}
                />
              </View>
              {transportMode === "simulator" ? (
                <Text style={[styles.hint, { color: theme.textFaint }]}>
                  Synthetic derailleur. Lets you exercise the whole pipeline without
                  hardware — the iOS Simulator has no Bluetooth radio.
                </Text>
              ) : (
                <Text style={[styles.hint, { color: theme.textFaint }]}>
                  Requires a physical device. Wake the AXS component first: press its
                  AXS button or bounce the bike.
                </Text>
              )}
            </Card>

            <View style={styles.buttonRow}>
              <Button
                title={isScanning ? "Stop scan" : "Start scan"}
                tone={isScanning ? "danger" : "success"}
                onPress={isScanning ? stopScan : startScan}
                style={styles.flexButton}
              />
              <Button
                title="Clear"
                tone="neutral"
                onPress={clearDevices}
                style={styles.flexButton}
              />
            </View>

            {session ? (
              <Button
                title={`Open dashboard (${session.deviceName ?? "connected"})`}
                tone="accent"
                onPress={() => router.push("/dashboard")}
                style={styles.dashboardButton}
              />
            ) : null}

            <View style={styles.listHeaderRow}>
              <SectionTitle>
                {sramOnly
                  ? `${sramCount} SRAM device${sramCount === 1 ? "" : "s"}`
                  : `${devices.length} device${devices.length === 1 ? "" : "s"}${
                      sramCount > 0 ? ` · ${sramCount} SRAM` : ""
                    }`}
              </SectionTitle>
              <Button
                title={sramOnly ? `Show all${hidden > 0 ? ` (${hidden})` : ""}` : "SRAM only"}
                tone="neutral"
                onPress={() => setSramOnly((previous) => !previous)}
              />
            </View>
          </View>
        }
        renderItem={({ item }) => (
          <DeviceRow
            device={item}
            connecting={connectingId === item.result.id}
            onPress={() => void onSelect(item.result.id)}
          />
        )}
        ListEmptyComponent={
          <EmptyState
            title={
              isScanning
                ? "Scanning…"
                : sramOnly && devices.length > 0
                  ? "No SRAM devices"
                  : "No devices yet"
            }
            detail={
              isScanning
                ? "AXS components sleep aggressively. Press the AXS button on the derailleur or bounce the bike to wake it."
                : sramOnly && devices.length > 0
                  ? `Nothing nearby is advertising as SRAM. Tap Show all to see the other ${devices.length} device${devices.length === 1 ? "" : "s"}.`
                  : "Tap Start scan. SRAM components are listed here; Show all reveals everything else nearby."
            }
          />
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  list: { padding: 14 },
  buttonRow: { flexDirection: "row", gap: 10, marginBottom: 12 },
  listHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  flexButton: { flex: 1 },
  dashboardButton: { marginBottom: 12 },
  hint: { fontSize: 11, lineHeight: 16, marginTop: 8 },
  deviceRow: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginBottom: 8,
  },
  deviceHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  deviceName: { fontSize: 15, fontWeight: "600", flexShrink: 1 },
  rssi: { fontSize: 12, fontWeight: "600" },
  deviceId: { fontSize: 10, marginTop: 2 },
  badges: { flexDirection: "row", flexWrap: "wrap", marginTop: 6 },
  mfg: { fontSize: 10, marginTop: 6 },
  errorText: { fontSize: 13, fontWeight: "600" },
  errorHint: { fontSize: 11, marginTop: 4 },
});

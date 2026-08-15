/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * Device detail — the actual debugging surface.
 *
 * Four tabs, in the order you use them:
 *   State    what decoded with confidence
 *   GATT     the tree, with standard entries dimmed and vendor ones highlighted
 *   Log      raw frames, hex plus the best available interpretation
 *   Analysis per-offset byte volatility — the tool that cracks the protocol
 */

import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import { Alert, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  describeUuid,
  toHex,
  type RawFrame,
  type ValueSource,
} from "@axs/core";

import { LiveGear } from "../../src/components/live-gear";
import { Badge, Button, Card, EmptyState, Row, SectionTitle } from "../../src/components/ui";
import { exportCaptureJson } from "../../src/export-session";
import { useProbe } from "../../src/probe-context";
import { useTheme, type Theme } from "../../src/theme";

type Tab = "live" | "state" | "gatt" | "log" | "analysis";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "live", label: "Live" },
  { key: "state", label: "State" },
  { key: "gatt", label: "GATT" },
  { key: "log", label: "Log" },
  { key: "analysis", label: "Analysis" },
];

/** Render a value together with its confidence. */
function ProvenanceRow({
  label,
  source,
}: {
  label: string;
  source: ValueSource<string | number> | null;
}) {
  if (!source) return <Row label={label} value="—" dim />;

  const speculative = source.confidence < 0.8;
  return (
    <Row
      label={label}
      value={`${source.value}${speculative ? `  (${source.confidence.toFixed(2)})` : ""}`}
      dim={speculative}
      monospace
    />
  );
}

function StateTab() {
  const { deviceState, session } = useProbe();
  const theme = useTheme();

  if (!deviceState) return <EmptyState title="Not connected" />;

  const gear = deviceState.gearRear;

  return (
    <ScrollView contentContainerStyle={styles.tabContent}>
      <Card>
        <SectionTitle>Identity</SectionTitle>
        <Row label="Name" value={session?.deviceName ?? "—"} />
        <Row label="Address" value={deviceState.deviceId} monospace />
        <Row label="MTU" value={session?.mtu ? String(session.mtu) : "—"} />
        <ProvenanceRow label="Manufacturer" source={deviceState.manufacturerName} />
        <ProvenanceRow label="Model" source={deviceState.modelNumber} />
        <ProvenanceRow label="Serial" source={deviceState.serialNumber} />
        <ProvenanceRow label="Firmware" source={deviceState.firmwareRevision} />
        <ProvenanceRow label="Hardware" source={deviceState.hardwareRevision} />
      </Card>

      <Card>
        <SectionTitle>Power</SectionTitle>
        <ProvenanceRow label="Battery" source={deviceState.batteryPercent} />
        <ProvenanceRow label="Voltage" source={deviceState.batteryVolts} />
      </Card>

      <Card>
        <SectionTitle>Drivetrain</SectionTitle>
        <ProvenanceRow label="Rear gear" source={gear} />
        <ProvenanceRow label="Front gear" source={deviceState.gearFront} />
        <ProvenanceRow label="Rear cogs" source={deviceState.totalRear} />
        <Row label="Shifts observed" value={String(deviceState.shiftCount)} monospace />
        {gear && gear.confidence < 0.8 ? (
          <Text style={[styles.caveat, { color: theme.warning }]}>
            Gear is a speculative decoding ({gear.decoder}). The AXS BLE protocol is
            undocumented — confirm against the physical cog before trusting this.
          </Text>
        ) : null}
      </Card>

      <Card>
        <SectionTitle>Capture</SectionTitle>
        <Row label="Frames seen" value={String(deviceState.frameCount)} monospace />
        <Row
          label="Last update"
          value={
            deviceState.lastUpdateAt
              ? new Date(deviceState.lastUpdateAt).toLocaleTimeString()
              : "—"
          }
          monospace
        />
      </Card>
    </ScrollView>
  );
}

function GattTab() {
  const { session } = useProbe();
  const theme = useTheme();

  if (!session) return <EmptyState title="Not connected" />;

  const vendorCount = session.gatt
    .flatMap((s) => s.characteristics)
    .filter((c) => describeUuid(c.uuid).category === "vendor").length;

  return (
    <ScrollView contentContainerStyle={styles.tabContent}>
      <Card>
        <Text style={[styles.summary, { color: theme.textDim }]}>
          {session.gatt.length} services ·{" "}
          <Text style={{ color: theme.vendor, fontWeight: "700" }}>
            {vendorCount} vendor-defined
          </Text>{" "}
          characteristics. The vendor ones are where the undocumented AXS protocol
          lives — everything else is standard Bluetooth SIG.
        </Text>
      </Card>

      {session.gatt.map((service) => {
        const info = describeUuid(service.uuid);
        return (
          <Card key={service.uuid}>
            <View style={styles.serviceHeader}>
              <Text style={[styles.serviceName, { color: theme.text }]}>
                {info.name ?? "Unknown service"}
              </Text>
              <Badge
                label={info.short ?? "128-bit"}
                tone={info.category === "vendor" ? "vendor" : "neutral"}
              />
            </View>
            <Text style={[styles.uuid, { color: theme.textFaint, fontFamily: theme.mono }]}>
              {service.uuid}
            </Text>
            {info.note ? (
              <Text style={[styles.note, { color: theme.warning }]}>{info.note}</Text>
            ) : null}

            {service.characteristics.map((characteristic) => {
              const charInfo = describeUuid(characteristic.uuid);
              const isVendor = charInfo.category === "vendor";
              const props = Object.entries(characteristic.properties)
                .filter(([, enabled]) => enabled)
                .map(([name]) => name);

              return (
                <View
                  key={characteristic.uuid}
                  style={[
                    styles.characteristic,
                    { borderLeftColor: isVendor ? theme.vendor : theme.border },
                  ]}
                >
                  <Text
                    style={[
                      styles.charName,
                      { color: isVendor ? theme.vendor : theme.textDim },
                    ]}
                  >
                    {charInfo.name ?? "Undocumented characteristic"}
                  </Text>
                  <Text
                    style={[styles.uuid, { color: theme.textFaint, fontFamily: theme.mono }]}
                  >
                    {charInfo.short ?? characteristic.uuid}
                  </Text>
                  <View style={styles.badges}>
                    {props.length > 0 ? (
                      props.map((p) => <Badge key={p} label={p} />)
                    ) : (
                      <Badge label="no properties" tone="danger" />
                    )}
                  </View>
                </View>
              );
            })}
          </Card>
        );
      })}
    </ScrollView>
  );
}

function FrameRow({ frame, theme }: { frame: RawFrame; theme: Theme }) {
  const { probe } = useProbe();
  const best = probe?.registry.best(frame) ?? null;
  const charInfo = frame.characteristicUuid ? describeUuid(frame.characteristicUuid) : null;
  const speculative = (best?.confidence ?? 0) < 0.8;

  return (
    <View style={[styles.frameRow, { borderColor: theme.border }]}>
      <View style={styles.frameHeader}>
        <Text style={[styles.frameTime, { color: theme.textFaint, fontFamily: theme.mono }]}>
          {(frame.elapsedMs / 1000).toFixed(2)}s
        </Text>
        <Text style={[styles.frameChar, { color: theme.textDim }]} numberOfLines={1}>
          {charInfo?.short ?? charInfo?.name ?? frame.characteristicUuid ?? "—"}
        </Text>
        <Text style={[styles.frameSource, { color: theme.textFaint }]}>{frame.source}</Text>
      </View>

      <Text style={[styles.frameHex, { color: theme.text, fontFamily: theme.mono }]}>
        {toHex(frame.data)}
      </Text>

      {best ? (
        <Text
          style={[
            styles.frameDecoded,
            { color: speculative ? theme.textFaint : theme.success },
          ]}
        >
          {best.summary}
        </Text>
      ) : null}

      {frame.label ? (
        <Text style={[styles.frameLabel, { color: theme.warning }]}>▸ {frame.label}</Text>
      ) : null}
    </View>
  );
}

function LogTab() {
  const { frames, markFrame } = useProbe();
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.flex}>
      <View style={[styles.markBar, { borderColor: theme.border }]}>
        <Button
          title="Mark shift"
          tone="warning"
          onPress={() => markFrame(`marked @ ${new Date().toLocaleTimeString()}`)}
          style={styles.flexButton}
        />
      </View>

      <FlatList
        data={frames}
        keyExtractor={(item) => `${item.deviceId}-${item.seq}`}
        contentContainerStyle={[styles.tabContent, { paddingBottom: insets.bottom + 24 }]}
        renderItem={({ item }) => <FrameRow frame={item} theme={theme} />}
        ListEmptyComponent={
          <EmptyState
            title="No frames yet"
            detail="Frames appear as the component notifies. If nothing arrives, it may be asleep — wake it and reconnect."
          />
        }
        // The log is append-heavy; these keep scrolling smooth on long captures.
        initialNumToRender={20}
        maxToRenderPerBatch={20}
        windowSize={10}
        removeClippedSubviews
      />
    </View>
  );
}

function AnalysisTab() {
  const { session } = useProbe();
  const theme = useTheme();

  const characteristics = session?.trackedCharacteristics() ?? [];

  if (!session || characteristics.length === 0) {
    return (
      <EmptyState
        title="Nothing to analyse yet"
        detail="Capture some frames first, then come back. Shift through the cassette while the log runs."
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.tabContent}>
      <Card>
        <Text style={[styles.summary, { color: theme.textDim }]}>
          Which byte offsets change, and how often. Shift through the cassette, then look
          for the offset whose change count matches your shift count — that is your gear
          field.
        </Text>
      </Card>

      {characteristics.map((uuid) => {
        const tracker = session.tracker(uuid);
        if (!tracker) return null;

        const report = tracker.report();
        const info = describeUuid(uuid);

        return (
          <Card key={uuid}>
            <Text style={[styles.serviceName, { color: theme.text }]}>
              {info.name ?? info.short ?? "Vendor characteristic"}
            </Text>
            <Text style={[styles.uuid, { color: theme.textFaint, fontFamily: theme.mono }]}>
              {uuid} · {tracker.frameCount} frames
            </Text>

            <View style={[styles.tableHeader, { borderColor: theme.border }]}>
              <Text style={[styles.colOffset, { color: theme.textDim }]}>off</Text>
              <Text style={[styles.colChanges, { color: theme.textDim }]}>changes</Text>
              <Text style={[styles.colRange, { color: theme.textDim }]}>range</Text>
              <Text style={[styles.colLast, { color: theme.textDim }]}>last</Text>
            </View>

            {report.map((stat) => (
              <View key={stat.offset} style={styles.tableRow}>
                <Text
                  style={[styles.colOffset, { color: theme.text, fontFamily: theme.mono }]}
                >
                  {stat.offset}
                </Text>
                <Text
                  style={[
                    styles.colChanges,
                    {
                      color: stat.constant ? theme.textFaint : theme.accent,
                      fontFamily: theme.mono,
                    },
                  ]}
                >
                  {stat.constant ? "const" : stat.changes}
                </Text>
                <Text
                  style={[styles.colRange, { color: theme.textDim, fontFamily: theme.mono }]}
                >
                  {stat.minValue}–{stat.maxValue}
                </Text>
                <Text
                  style={[styles.colLast, { color: theme.text, fontFamily: theme.mono }]}
                >
                  0x{stat.lastValue.toString(16).padStart(2, "0")}
                </Text>
              </View>
            ))}
          </Card>
        );
      })}
    </ScrollView>
  );
}

export default function DeviceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const theme = useTheme();
  const [tab, setTab] = useState<Tab>("live");

  const {
    session,
    disconnect,
    isRecording,
    toggleRecording,
    recordedFrameCount,
    exportSession,
    deviceState,
  } = useProbe();

  const onExport = useCallback(async () => {
    const json = exportSession();
    if (!json) {
      Alert.alert("Nothing to export", "No frames have been recorded yet.");
      return;
    }

    try {
      const result = await exportCaptureJson(json, session?.deviceName ?? null);
      if (!result.shared) {
        Alert.alert("Saved", `Sharing unavailable. Written to:\n${result.uri}`);
      }
    } catch (caught) {
      Alert.alert("Export failed", caught instanceof Error ? caught.message : String(caught));
    }
  }, [exportSession, session]);

  const onDisconnect = useCallback(async () => {
    await disconnect();
    router.back();
  }, [disconnect, router]);

  const body = useMemo(() => {
    switch (tab) {
      case "live":
        return <LiveGear deviceId={id} />;
      case "state":
        return <StateTab />;
      case "gatt":
        return <GattTab />;
      case "log":
        return <LogTab />;
      case "analysis":
        return <AnalysisTab />;
    }
  }, [tab, id]);

  if (!session) {
    return (
      <View style={[styles.flex, { backgroundColor: theme.bg }]}>
        <EmptyState
          title="Not connected"
          detail={`No active session for ${id}. Go back and reconnect.`}
        />
        <View style={styles.tabContent}>
          <Button title="Back to scan" tone="accent" onPress={() => router.back()} />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.flex, { backgroundColor: theme.bg }]}>
      <View style={[styles.toolbar, { borderColor: theme.border }]}>
        <Button
          title={isRecording ? `● REC ${recordedFrameCount}` : "Record"}
          tone={isRecording ? "danger" : "neutral"}
          onPress={toggleRecording}
          style={styles.flexButton}
        />
        <Button
          title="Export"
          tone="accent"
          onPress={() => void onExport()}
          style={styles.flexButton}
        />
        <Button
          title="Disconnect"
          tone="neutral"
          onPress={() => void onDisconnect()}
          style={styles.flexButton}
        />
      </View>

      <View style={[styles.tabBar, { borderColor: theme.border }]}>
        {TABS.map((entry) => {
          const active = entry.key === tab;
          return (
            <Pressable
              key={entry.key}
              onPress={() => setTab(entry.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              style={[
                styles.tab,
                { borderBottomColor: active ? theme.accent : "transparent" },
              ]}
            >
              <Text
                style={[styles.tabLabel, { color: active ? theme.accent : theme.textDim }]}
              >
                {entry.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {deviceState && tab !== "log" ? (
        <View style={[styles.gearStrip, { backgroundColor: theme.surfaceAlt }]}>
          <Text style={[styles.gearStripText, { color: theme.textDim }]}>
            gear {deviceState.gearRear?.value ?? "—"}
            {deviceState.totalRear ? `/${deviceState.totalRear.value}` : ""} · shifts{" "}
            {deviceState.shiftCount} · frames {deviceState.frameCount}
          </Text>
        </View>
      ) : null}

      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  tabContent: { padding: 14 },
  toolbar: {
    flexDirection: "row",
    gap: 8,
    padding: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  flexButton: { flex: 1 },
  tabBar: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { flex: 1, paddingVertical: 11, alignItems: "center", borderBottomWidth: 2 },
  tabLabel: { fontSize: 13, fontWeight: "600" },
  gearStrip: { paddingVertical: 5, paddingHorizontal: 14 },
  gearStripText: { fontSize: 11 },
  summary: { fontSize: 12, lineHeight: 18 },
  serviceHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  serviceName: { fontSize: 15, fontWeight: "700", flexShrink: 1 },
  uuid: { fontSize: 10, marginTop: 2 },
  note: { fontSize: 11, marginTop: 6, lineHeight: 16 },
  characteristic: {
    borderLeftWidth: 2,
    paddingLeft: 10,
    marginTop: 12,
  },
  charName: { fontSize: 13, fontWeight: "600" },
  badges: { flexDirection: "row", flexWrap: "wrap", marginTop: 4 },
  caveat: { fontSize: 11, lineHeight: 16, marginTop: 10 },
  markBar: { padding: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  frameRow: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 9,
    marginBottom: 6,
  },
  frameHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  frameTime: { fontSize: 10, width: 54 },
  frameChar: { fontSize: 10, flex: 1 },
  frameSource: { fontSize: 9 },
  frameHex: { fontSize: 11, marginTop: 4 },
  frameDecoded: { fontSize: 11, marginTop: 3 },
  frameLabel: { fontSize: 11, marginTop: 3, fontWeight: "600" },
  tableHeader: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: 4,
    marginTop: 10,
  },
  tableRow: { flexDirection: "row", paddingVertical: 3 },
  colOffset: { width: 40, fontSize: 11 },
  colChanges: { width: 70, fontSize: 11 },
  colRange: { flex: 1, fontSize: 11 },
  colLast: { width: 50, fontSize: 11, textAlign: "right" },
});

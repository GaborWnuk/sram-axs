/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * Small shared presentational pieces. Kept in one file — they are each a few
 * lines and splitting them across a components/ tree would be more navigation
 * than it is worth at this size.
 */

import React from "react";
import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";

import { useTheme } from "../theme";

export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.surface, borderColor: theme.border },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  return <Text style={[styles.sectionTitle, { color: theme.textDim }]}>{children}</Text>;
}

export function Badge({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "accent" | "success" | "warning" | "danger" | "vendor";
}) {
  const theme = useTheme();
  const color = {
    neutral: theme.textDim,
    accent: theme.accent,
    success: theme.success,
    warning: theme.warning,
    danger: theme.danger,
    vendor: theme.vendor,
  }[tone];

  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color, fontFamily: theme.mono }]}>{label}</Text>
    </View>
  );
}

export function Button({
  title,
  onPress,
  tone = "accent",
  disabled = false,
  style,
}: {
  title: string;
  onPress: () => void;
  tone?: "accent" | "neutral" | "danger" | "success" | "warning";
  disabled?: boolean;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const color = {
    accent: theme.accent,
    neutral: theme.textDim,
    danger: theme.danger,
    success: theme.success,
    warning: theme.warning,
  }[tone];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.button,
        {
          borderColor: color,
          backgroundColor: pressed && !disabled ? theme.surfaceAlt : "transparent",
          opacity: disabled ? 0.4 : 1,
        },
        style,
      ]}
    >
      <Text style={[styles.buttonText, { color }]}>{title}</Text>
    </Pressable>
  );
}

/** Label/value row. `dim` marks low-confidence values. */
export function Row({
  label,
  value,
  dim = false,
  monospace = false,
}: {
  label: string;
  value: string;
  dim?: boolean;
  monospace?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: theme.textDim }]} numberOfLines={1}>
        {label}
      </Text>
      <Text
        style={[
          styles.rowValue,
          {
            color: dim ? theme.textFaint : theme.text,
            fontFamily: monospace ? theme.mono : undefined,
          },
        ]}
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  );
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyTitle, { color: theme.textDim }]}>{title}</Text>
      {detail ? (
        <Text style={[styles.emptyDetail, { color: theme.textFaint }]}>{detail}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.1,
    textTransform: "uppercase",
    marginBottom: 8,
    marginTop: 4,
  },
  badge: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginRight: 6,
    marginTop: 4,
  },
  badgeText: { fontSize: 10, fontWeight: "600" },
  button: {
    borderWidth: 1,
    borderRadius: 9,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: "center",
  },
  buttonText: { fontSize: 14, fontWeight: "600" },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingVertical: 5,
    gap: 12,
  },
  rowLabel: { fontSize: 13, flexShrink: 0 },
  rowValue: { fontSize: 13, flexShrink: 1, textAlign: "right" },
  empty: { padding: 28, alignItems: "center" },
  emptyTitle: { fontSize: 14, fontWeight: "600", textAlign: "center" },
  emptyDetail: { fontSize: 12, marginTop: 6, textAlign: "center", lineHeight: 17 },
});

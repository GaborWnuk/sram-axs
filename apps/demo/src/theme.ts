/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * Theme tokens.
 *
 * Dark-first: this is a tool you use outdoors next to a bike, often in a
 * workshop. Monospace everywhere it matters, because most of the content is
 * hex.
 */

import { Platform, useColorScheme } from "react-native";

export const mono = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

export interface Theme {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  accentDim: string;
  success: string;
  warning: string;
  danger: string;
  /** Highlight for vendor-defined, undocumented GATT entries. */
  vendor: string;
  mono: string;
}

const dark: Theme = {
  bg: "#0b0e13",
  surface: "#141920",
  surfaceAlt: "#1b222c",
  border: "#28313d",
  text: "#e8edf4",
  textDim: "#97a3b4",
  textFaint: "#5c6878",
  accent: "#4da3ff",
  accentDim: "#1e3a5f",
  success: "#3ddc91",
  warning: "#ffb454",
  danger: "#ff5f56",
  vendor: "#c77dff",
  mono,
};

const light: Theme = {
  bg: "#f6f7f9",
  surface: "#ffffff",
  surfaceAlt: "#eef1f5",
  border: "#d6dce4",
  text: "#10151c",
  textDim: "#5a6675",
  textFaint: "#8b97a6",
  accent: "#0066d6",
  accentDim: "#cfe2fb",
  success: "#0a8f56",
  warning: "#a86400",
  danger: "#c62f28",
  vendor: "#7a2fd0",
  mono,
};

export function useTheme(): Theme {
  return useColorScheme() === "light" ? light : dark;
}

/** RSSI to a rough signal-quality colour. */
export function rssiColor(rssi: number | null, theme: Theme): string {
  if (rssi === null) return theme.textFaint;
  if (rssi > -60) return theme.success;
  if (rssi > -80) return theme.warning;
  return theme.danger;
}

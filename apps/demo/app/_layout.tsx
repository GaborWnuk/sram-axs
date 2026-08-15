/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useColorScheme } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ProbeProvider } from "../src/probe-context";
import { useTheme } from "../src/theme";

function RootStack() {
  const theme = useTheme();

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.surface },
        headerTintColor: theme.text,
        headerTitleStyle: { fontWeight: "700" },
        contentStyle: { backgroundColor: theme.bg },
      }}
    >
      <Stack.Screen name="index" options={{ title: "AXS Probe" }} />
      <Stack.Screen name="device/[id]" options={{ title: "Device" }} />
      <Stack.Screen name="dashboard" options={{ title: "Ride Dashboard" }} />
    </Stack>
  );
}

export default function RootLayout() {
  const scheme = useColorScheme();

  return (
    <SafeAreaProvider>
      <ProbeProvider>
        <StatusBar style={scheme === "light" ? "dark" : "light"} />
        <RootStack />
      </ProbeProvider>
    </SafeAreaProvider>
  );
}

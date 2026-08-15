import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  // Hermes (React Native) target. No Node built-ins are used anywhere in src/,
  // so the output is safe to bundle into a mobile app.
  target: "es2020",
  platform: "neutral",
  treeshake: true,
});

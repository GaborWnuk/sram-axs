// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.expo/**",
      "**/android/**",
      "**/ios/**",
      "apps/demo/expo-env.d.ts",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node, ...globals.es2022 },
    },
    rules: {
      // The library decodes untyped bytes into `unknown` field bags; `any` is
      // still banned, but narrowing from `unknown` is the normal idiom here.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "off",
      eqeqeq: ["error", "always"],
      "prefer-const": "error",
      "no-var": "error",
      // Transport methods are `async` because the interface is promise-based —
      // an in-memory implementation legitimately has nothing to await.
      "@typescript-eslint/require-await": "off",
    },
  },

  // Build/test tooling configs are not part of the type-checked program.
  {
    files: ["**/*.config.ts", "**/*.config.mts"],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Tests and the simulator may use looser typing.
  {
    files: ["**/*.test.ts", "**/testing/**"],
    rules: {
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // Plain JS tooling (Frida scripts, metro config) is not type-checked.
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      // CommonJS config files legitimately use require().
      "@typescript-eslint/no-require-imports": "off",
    },
  },

  // The demo app talks to react-native-ble-plx, whose enums are compared
  // against plain string state values.
  {
    files: ["apps/demo/**"],
    rules: { "@typescript-eslint/no-unsafe-enum-comparison": "off" },
  },

  // Frida instrumentation runs inside Frida's own runtime, which injects these
  // globals. Probing memory legitimately swallows read failures.
  {
    files: ["tools/frida/**/*.js"],
    languageOptions: {
      globals: {
        Interceptor: "readonly",
        Module: "readonly",
        Process: "readonly",
        Memory: "readonly",
        NativePointer: "readonly",
        NativeFunction: "readonly",
        Java: "readonly",
        ptr: "readonly",
        send: "readonly",
        recv: "readonly",
      },
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
);

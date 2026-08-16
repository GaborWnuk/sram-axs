/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      // `lcov` is what Codecov consumes; `text` keeps the CI log readable and
      // `json-summary` is the machine-readable form for any later tooling.
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        // Barrel file: re-exports only, so it reports as covered or not
        // depending on import order rather than on anything being tested.
        "src/index.ts",
      ],
    },
  },
});

/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * Type-check every TypeScript example in the documentation.
 *
 * Examples rot silently: a rename lands, the code keeps compiling, and the
 * README quietly starts describing an API that no longer exists. Worse, an
 * example can be incomplete rather than wrong — referring to a `transport` that
 * is never defined — which reads fine to whoever wrote it and is useless to
 * anyone copying it.
 *
 * So every ```ts block is extracted and compiled against the library's real
 * emitted types, under the same strictness as the source. Placeholders the
 * reader is expected to supply must be declared with `declare const`, which
 * documents them honestly and keeps the snippet compiling.
 *
 * Run with `npm run check:docs`. Requires a build first, since examples resolve
 * the package through dist/index.d.ts.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const DOCS = ["README.md", "packages/axs-core/README.md", "apps/demo/README.md"];
const TS_LANGS = new Set(["ts", "tsx", "typescript"]);

const types = join(repoRoot, "packages/axs-core/dist/index.d.ts");
if (!existsSync(types)) {
  console.error("error: packages/axs-core/dist/index.d.ts is missing — run `npm run build` first.");
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "axs-docs-"));
mkdirSync(join(work, "src"));

let count = 0;
const index = [];

for (const doc of DOCS) {
  let source;
  try {
    source = await readFile(join(repoRoot, doc), "utf8");
  } catch {
    continue;
  }

  const blocks = [...source.matchAll(/```(\w+)\n([\s\S]*?)```/g)];
  blocks.forEach(([, lang, body], i) => {
    if (!TS_LANGS.has(lang)) return;
    const name = `${doc.replace(/[/.]/g, "_")}_${i}.ts`;
    writeFileSync(join(work, "src", name), body);
    index.push({ doc, block: i, name });
    count += 1;
  });
}

if (count === 0) {
  console.error("error: no TypeScript examples found — the extractor is probably broken.");
  process.exit(1);
}

writeFileSync(
  join(work, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
        lib: ["ES2022", "DOM"],
        paths: { "@gaborwnuk/axs-core": [types] },
      },
      include: ["src/**/*.ts"],
    },
    null,
    2,
  ),
);

const tsc = join(repoRoot, "node_modules/.bin/tsc");
try {
  // Run inside the temp dir so diagnostics come back as "src/<file>.ts" rather
  // than a long absolute path that buries the useful part.
  execFileSync(tsc, ["-p", "tsconfig.json"], { cwd: work, stdio: "pipe", encoding: "utf8" });
  console.log(`✓ ${count} documentation examples type-check`);
  rmSync(work, { recursive: true, force: true });
} catch (error) {
  const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  // Map the temp filename in each diagnostic back to the document it came from.
  const mapped = output.replace(/src\/(\S+?)\.ts/g, (match, name) => {
    const hit = index.find((entry) => entry.name === `${name}.ts`);
    return hit ? `${hit.doc} (code block ${hit.block})` : match;
  });
  console.error("Documentation examples failed to type-check:\n");
  console.error(mapped.trim());
  console.error(
    "\nExamples must compile. For values the reader supplies, use `declare const x: T`.",
  );
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

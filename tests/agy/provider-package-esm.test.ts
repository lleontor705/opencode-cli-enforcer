/**
 * Plain-ESM import and bundler guard for runtime `.mjs` modules under `src/`
 * (REQ-CB-AGY-001, REQ-CB-PROV-001, REQ-CB-TOOL-001).
 *
 * OpenCode v2 imports `provider-package.mjs` shims with Bun's JS loader
 * (`loader: "js"`) and spawns `runner-cli.mjs` without `tsx`. Every `.mjs`
 * module under `src/` must load cleanly in a bare Node subprocess (with
 * `NODE_OPTIONS` cleared so `tsx` cannot mask TypeScript syntax) and pass
 * `bun build` whenever `bun` is installed.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as agyProviderPackage from "../../src/agy/provider-package.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC_DIR = path.join(ROOT, "src");

const DUMMY_SDK_MESSAGE =
  "agy: the dummy SDK's languageModel was invoked; the LanguageModelV3 adapter must be supplied by the aisdk language hook";

function collectMjsFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith("._")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectMjsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      found.push(fullPath);
    }
  }
  return found.sort();
}

function findBunBinary(): string | null {
  const probe = spawnSync("sh", ["-c", "command -v bun"], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout.trim().length > 0 ? probe.stdout.trim() : null;
}

const BUN_BIN = findBunBinary();

describe("agy provider-package.mjs", () => {
  it("imports cleanly and exports exactly createAgyProviderSdk", () => {
    assert.deepEqual(Object.keys(agyProviderPackage).sort(), ["createAgyProviderSdk"]);
  });

  it("factory returns an SDK object exposing a languageModel function", () => {
    const sdk = agyProviderPackage.createAgyProviderSdk({});
    assert.equal(typeof sdk.languageModel, "function");
  });

  it("languageModel throws the dummy-SDK guard message", () => {
    const sdk = agyProviderPackage.createAgyProviderSdk({});
    assert.throws(() => sdk.languageModel("gemini-3.8-flash"), {
      message: DUMMY_SDK_MESSAGE,
    });
  });
});

describe("plain-ESM guard across all src/**/*.mjs modules", () => {
  const mjsFiles = collectMjsFiles(SRC_DIR);

  it("discovers all expected runtime .mjs entrypoints", () => {
    const relative = mjsFiles.map((file) => path.relative(ROOT, file).replace(/\\/g, "/"));
    assert.deepEqual(relative, [
      "src/agy/provider-package.mjs",
      "src/agy/runner-cli.mjs",
      "src/provider/provider-package.mjs",
    ]);
  });

  it("loads every src/**/*.mjs file in bare Node without tsx", () => {
    const cleanEnv = { ...process.env, NODE_OPTIONS: "" };
    for (const file of mjsFiles) {
      const fileUrl = pathToFileURL(file).href;
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", `await import(${JSON.stringify(fileUrl)});`],
        { env: cleanEnv, encoding: "utf8", timeout: 15_000 },
      );
      assert.equal(
        result.status,
        0,
        `bare Node failed to import ${path.relative(ROOT, file)}:\n${result.stderr}`,
      );
    }
  });

  it(
    "parses every src/**/*.mjs file with Bun's JS loader (bun build)",
    { skip: BUN_BIN === null ? "bun is not installed on PATH" : false },
    () => {
      for (const file of mjsFiles) {
        const result = spawnSync(BUN_BIN!, ["build", "--target=bun", file], {
          encoding: "utf8",
          timeout: 15_000,
        });
        assert.equal(
          result.status,
          0,
          `bun build rejected ${path.relative(ROOT, file)}:\n${result.stderr}`,
        );
      }
    },
  );
});

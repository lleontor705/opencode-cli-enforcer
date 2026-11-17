/**
 * Test-discovery coverage guard.
 *
 * `package.json`, ci.yml and release.yml run `node --test tests/**\/*.test.ts`
 * UNQUOTED (Node 20's `--test` has no native glob). sh/dash/bash have no
 * `globstar`, so `**` collapses to `*` and the shell only expands files exactly
 * one directory below `tests/`. A suite placed anywhere else is silently never
 * run — which is how the v3.1.1 `.mjs` guard shipped without executing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_GLOB = "tests/**/*.test.ts";
const GLOB_SOURCES = ["package.json", ".github/workflows/ci.yml", ".github/workflows/release.yml"];

function listTestFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith("._") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listTestFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) found.push(full);
  }
  return found;
}

function repoTestFiles(): string[] {
  return listTestFiles(join(ROOT, "tests"))
    .map((file) => relative(ROOT, file).replace(/\\/g, "/"))
    .sort();
}

/** True when sh would expand the unquoted glob to `path` (`tests/<dir>/<name>.test.ts`). */
function matchedByShellGlob(path: string): boolean {
  const parts = path.split("/");
  return (
    parts.length === 3 &&
    parts[0] === "tests" &&
    !parts[1]!.startsWith(".") &&
    !parts[2]!.startsWith(".") &&
    parts[2]!.endsWith(".test.ts")
  );
}

function escapedFiles(paths: readonly string[]): string[] {
  return paths.filter((path) => !matchedByShellGlob(path));
}

test("TestREQ_CB_DOC_001_every_test_file_is_reached_by_the_unquoted_glob", () => {
  const files = repoTestFiles();
  assert.ok(files.length > 0, "tests/ must contain *.test.ts suites");
  assert.deepEqual(
    escapedFiles(files),
    [],
    `these suites are never run by \`${TEST_GLOB}\` under sh (no globstar); move them to tests/<dir>/`,
  );
});

test("TestREQ_CB_DOC_001_glob_predicate_rejects_root_and_nested_suites", () => {
  assert.equal(matchedByShellGlob("tests/agy/provider-package-esm.test.ts"), true);
  assert.deepEqual(
    escapedFiles([
      "tests/agy-provider-package.test.ts",
      "tests/agy/deep/nested.test.ts",
      "tests/.hidden/x.test.ts",
      "tests/ci/workflow.test.ts",
    ]),
    ["tests/agy-provider-package.test.ts", "tests/agy/deep/nested.test.ts", "tests/.hidden/x.test.ts"],
  );
});

test(
  "TestREQ_CB_DOC_001_real_sh_expansion_matches_the_discovered_suites",
  { skip: process.platform === "win32" ? "POSIX sh required" : false },
  () => {
    const result = spawnSync("sh", ["-c", `for f in ${TEST_GLOB}; do printf '%s\\n' "$f"; done`], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const expanded = result.stdout
      .split("\n")
      .filter((line) => line.length > 0 && !line.split("/").pop()!.startsWith("._"))
      .sort();
    assert.deepEqual(expanded, repoTestFiles(), "sh expansion of the test glob must reach every suite");
  },
);

test("TestREQ_CB_DOC_001_runners_share_the_same_unquoted_test_glob", () => {
  for (const source of GLOB_SOURCES) {
    const text = readFileSync(join(ROOT, source), "utf8");
    const globs = text.match(/["']?tests\/[^\s"']*\*[^\s"']*\.test\.ts["']?/g) ?? [];
    assert.ok(globs.length > 0, `${source} must run the unit-test glob`);
    for (const glob of globs) {
      assert.equal(glob, TEST_GLOB, `${source} must use the unquoted \`${TEST_GLOB}\` glob, got ${glob}`);
    }
  }
});

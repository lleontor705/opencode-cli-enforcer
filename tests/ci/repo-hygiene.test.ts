/**
 * Deterministic oracle for the open-source supply-chain governance layer.
 *
 * Parses .github/dependabot.yml, .github/workflows/scorecard.yml and
 * .github/workflows/codeql.yml with a real YAML 1.2 parser and asserts the
 * wiring pinned by REQ-CB-DOC-004, plus the LICENSE / package.json metadata
 * that ships with the npm artifact.
 *
 * The parser is Effect's bundled YAML 1.2 module, which arrives transitively via
 * @opencode/plugin's `effect` dependency. The declarative-config policy forbids
 * ad-hoc lexing of YAML and no standalone YAML package is a direct dependency.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "effect/unstable/encoding/Yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEPENDABOT_PATH = join(ROOT, ".github", "dependabot.yml");
const SCORECARD_PATH = join(ROOT, ".github", "workflows", "scorecard.yml");
const CODEQL_PATH = join(ROOT, ".github", "workflows", "codeql.yml");
const LICENSE_PATH = join(ROOT, "LICENSE");
const PACKAGE_PATH = join(ROOT, "package.json");

const FULL_SHA_PIN = /^[\w.-]+(?:\/[\w.-]+)+@[0-9a-f]{40}$/;

interface Step {
  uses?: unknown;
  with?: Record<string, unknown>;
}

interface Job {
  "runs-on"?: unknown;
  "timeout-minutes"?: unknown;
  permissions?: unknown;
  steps?: Step[];
}

interface Workflow {
  on?: Record<string, unknown>;
  permissions?: unknown;
  concurrency?: { "cancel-in-progress"?: unknown };
  jobs?: Record<string, Job>;
}

function readYaml<T>(path: string): T {
  return parse(readFileSync(path, "utf8")) as T;
}

function stepsOf(workflow: Workflow): Step[] {
  return Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

function actionStep(workflow: Workflow, prefix: string): Step {
  const step = stepsOf(workflow).find((candidate) => String(candidate.uses ?? "").startsWith(prefix));
  assert.ok(step, `the workflow must run ${prefix}`);
  return step!;
}

function permissionValue(permissions: unknown, scope: string): unknown {
  if (permissions === null || typeof permissions !== "object") return undefined;
  return (permissions as Record<string, unknown>)[scope];
}

function branchesOf(event: unknown): string[] {
  const branches = (event as { branches?: unknown } | undefined)?.branches;
  return Array.isArray(branches) ? branches.map(String) : [];
}

function cronEntries(event: unknown): string[] {
  if (!Array.isArray(event)) return [];
  return event.map((entry) => String((entry as { cron?: unknown }).cron ?? "").trim()).filter((cron) => cron.split(/\s+/).length === 5);
}

/** Top-level permissions must never grant write access anywhere. */
function assertReadOnlyPermissions(permissions: unknown, label: string): void {
  if (permissions === "read-all") return;
  assert.ok(permissions !== null && typeof permissions === "object", `${label}: top-level permissions must be read-only`);
  for (const [scope, value] of Object.entries(permissions as Record<string, unknown>)) {
    assert.equal(value, "read", `${label}: top-level "${scope}" must not grant write access`);
  }
}

/** One job, least-privilege workflow scope, code-scanning write at job level. */
function assertJobScope(workflow: Workflow, label: string): Job {
  const jobs = Object.entries(workflow.jobs ?? {});
  assert.equal(jobs.length, 1, `${label} must declare exactly one job`);
  assertReadOnlyPermissions(workflow.permissions, label);
  const job = jobs[0]![1];
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(permissionValue(job.permissions, "security-events"), "write");
  return job;
}

/**
 * Shared SHA-pinning oracle: every `uses:` must reference a full 40-hex commit
 * SHA. Defined once and reused by every workflow assertion so the rule cannot
 * drift between the files.
 */
function assertAllUsesPinned(workflow: Workflow, label: string): string[] {
  const uses = stepsOf(workflow)
    .map((step) => String(step.uses ?? ""))
    .filter((value) => value.length > 0);
  assert.ok(uses.length > 0, `${label} must invoke at least one action`);
  for (const value of uses) {
    assert.match(value, FULL_SHA_PIN, `${label}: "${value}" must be pinned to a full 40-hex commit SHA`);
  }
  return uses;
}

interface DependabotUpdate {
  "package-ecosystem"?: string;
  directory?: string;
  schedule?: { interval?: string };
  "open-pull-requests-limit"?: unknown;
  "commit-message"?: { prefix?: string };
  groups?: Record<string, { "update-types"?: unknown }>;
}

interface Dependabot {
  version?: unknown;
  updates?: DependabotUpdate[];
}

const MAJOR_TOKENS = new Set(["major", "version-update:semver-major"]);

function ecosystem(name: string): DependabotUpdate {
  const found = (readYaml<Dependabot>(DEPENDABOT_PATH).updates ?? []).find((update) => update["package-ecosystem"] === name);
  assert.ok(found, `dependabot must configure the ${name} ecosystem`);
  return found!;
}

function groupedUpdateTypes(update: DependabotUpdate): string[][] {
  return Object.values(update.groups ?? {}).map((group) =>
    Array.isArray(group["update-types"]) ? group["update-types"].map(String) : [],
  );
}

test("TestREQ_CB_DOC_004_dependabot_tracks_npm_and_actions_weekly", () => {
  assert.equal(readYaml<Dependabot>(DEPENDABOT_PATH).version, 2, "dependabot must use schema version 2");
  for (const name of ["npm", "github-actions"]) {
    const update = ecosystem(name);
    assert.equal(update.directory, "/", `${name} must watch the repository root`);
    assert.equal(update.schedule?.interval, "weekly", `${name} must run on a weekly schedule`);
    const limit = update["open-pull-requests-limit"];
    assert.ok(Number.isInteger(limit) && Number(limit) > 0 && Number(limit) <= 10, `${name} must declare a bounded open-pull-requests-limit`);
    assert.ok(Object.keys(update.groups ?? {}).length >= 1, `${name} must declare at least one update group`);
    assert.ok(String(update["commit-message"]?.prefix ?? "").length > 0, `${name} must declare a commit-message prefix`);
  }
});

test("TestREQ_CB_DOC_004_dependabot_batches_minor_patch_and_leaves_major_ungrouped", () => {
  const lists = groupedUpdateTypes(ecosystem("npm"));
  assert.ok(lists.length >= 2, "npm must batch development and production bumps into separate groups");
  assert.ok(
    lists.some((list) => !list.some((token) => MAJOR_TOKENS.has(token))),
    "at least one grouped update-types list must omit major bumps",
  );
  for (const list of lists) {
    assert.ok(list.length > 0, "every group must constrain its update-types");
    assert.ok(!list.some((token) => MAJOR_TOKENS.has(token)), "major bumps must stay ungrouped for individual review");
  }
});

test("TestREQ_CB_DOC_004_scorecard_pins_every_action_and_triggers_on_protection_changes", () => {
  const workflow = readYaml<Workflow>(SCORECARD_PATH);
  const uses = assertAllUsesPinned(workflow, "scorecard.yml");
  assert.equal(uses.length, 4, "checkout, scorecard, upload-sarif and upload-artifact must all run");
  assert.equal(workflow.concurrency?.["cancel-in-progress"], true, "superseded Scorecard runs must cancel");
  const on = workflow.on ?? {};
  assert.ok(on.branch_protection_rule !== undefined, "branch protection changes must re-run Scorecard");
  assert.ok(cronEntries(on.schedule).length > 0, "a weekly schedule must be declared");
  assert.ok(branchesOf(on.push).includes("main"), "pushes to main must re-run Scorecard");
});

test("TestREQ_CB_DOC_004_scorecard_publishes_sarif_under_least_privilege", () => {
  const workflow = readYaml<Workflow>(SCORECARD_PATH);
  const job = assertJobScope(workflow, "scorecard.yml");
  assert.equal(job["timeout-minutes"], 15);
  assert.equal(permissionValue(job.permissions, "id-token"), "write", "publishing needs an OIDC token");
  assert.equal(actionStep(workflow, "actions/checkout@").with?.["persist-credentials"], false);
  const scorecard = actionStep(workflow, "ossf/scorecard-action@");
  assert.equal(scorecard.with?.publish_results, true, "Scorecard must publish its results");
  assert.equal(scorecard.with?.results_format, "sarif");
  assert.equal(scorecard.with?.results_file, "results.sarif");
  assert.equal(actionStep(workflow, "github/codeql-action/upload-sarif@").with?.sarif_file, "results.sarif");
});

test("TestREQ_CB_DOC_004_codeql_pins_every_action_and_scans_the_expected_language", () => {
  const workflow = readYaml<Workflow>(CODEQL_PATH);
  assertAllUsesPinned(workflow, "codeql.yml");
  assert.equal(actionStep(workflow, "github/codeql-action/init@").with?.languages, "javascript-typescript");
  assert.ok(actionStep(workflow, "github/codeql-action/analyze@"), "analyze must upload the CodeQL results");
  assert.equal(workflow.concurrency?.["cancel-in-progress"], true, "superseded CodeQL runs must cancel");
});

test("TestREQ_CB_DOC_004_codeql_runs_on_main_events_and_a_schedule", () => {
  const workflow = readYaml<Workflow>(CODEQL_PATH);
  assert.equal(assertJobScope(workflow, "codeql.yml")["timeout-minutes"], 30);
  const on = workflow.on ?? {};
  assert.ok(branchesOf(on.push).includes("main"), "pushes to main must be analyzed");
  assert.ok(branchesOf(on.pull_request).includes("main"), "PRs targeting main must be analyzed");
  assert.ok(cronEntries(on.schedule).length > 0, "a weekly schedule must be declared");
});

test("TestREQ_CB_DOC_004_sarif_uploaders_share_the_codeql_action_pin", () => {
  const codeqlSteps = [
    ...assertAllUsesPinned(readYaml<Workflow>(SCORECARD_PATH), "scorecard.yml"),
    ...assertAllUsesPinned(readYaml<Workflow>(CODEQL_PATH), "codeql.yml"),
  ].filter((value) => value.startsWith("github/codeql-action/"));
  assert.ok(codeqlSteps.length >= 3, "init, analyze and upload-sarif must all be pinned");
  assert.equal(new Set(codeqlSteps.map((value) => value.split("@")[1])).size, 1, "the CodeQL steps must share one SHA");
});

test("TestREQ_CB_DOC_004_license_metadata_agrees_and_ships_in_the_artifact", () => {
  const license = readFileSync(LICENSE_PATH, "utf8").split(/\r?\n/).find((line) => line.trim().length > 0)!.trim();
  assert.match(license, /MIT/, "LICENSE must open with its MIT identifier");
  const pkg = JSON.parse(readFileSync(PACKAGE_PATH, "utf8")) as { license?: string; files?: unknown };
  assert.equal(pkg.license, "MIT", "package.json must declare the MIT license");
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes("LICENSE"), "the npm files allowlist must ship LICENSE");
  assert.ok(license.toLowerCase().includes(String(pkg.license).toLowerCase()), "LICENSE text and package.json must agree");
});
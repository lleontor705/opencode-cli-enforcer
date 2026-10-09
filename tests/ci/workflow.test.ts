/**
 * Deterministic oracle for the CI workflow (.github/workflows/ci.yml).
 *
 * Parses the workflow with a real YAML 1.2 parser and asserts the wiring pinned
 * by REQ-CB-DOC-001: main-branch push/PR triggers, a Node 20/22/24 matrix across
 * Linux and macOS, install -> typecheck -> unit tests, and an integration job
 * gated on the CLAUDE_BRIDGE_INTEGRATION repository variable so forks skip.
 *
 * The parser is Effect's bundled YAML 1.2 module, which arrives transitively via
 * @opencode/plugin's `effect` dependency. A real parser is used deliberately:
 * the declarative-config policy forbids ad-hoc lexing of YAML, and no standalone
 * YAML package is a direct dependency. package.json is out of scope here, so the
 * transitive parser is the only standards-compliant option available.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "effect/unstable/encoding/Yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = join(HERE, "..", "..", ".github", "workflows", "ci.yml");
const SOURCE = readFileSync(WORKFLOW_PATH, "utf8");

interface Job {
  if?: string;
  "runs-on"?: unknown;
  strategy?: { matrix?: Record<string, unknown> };
  steps?: Array<Record<string, unknown>>;
}

interface Workflow {
  on?: Record<string, unknown>;
  jobs?: Record<string, Job>;
}

const workflow = parse(SOURCE) as Workflow;
const jobs = workflow.jobs ?? {};

function stepsOf(job: Job): Array<Record<string, unknown>> {
  return job.steps ?? [];
}

function allSteps(): Array<Record<string, unknown>> {
  return Object.values(jobs).flatMap(stepsOf);
}

function runCommands(): string[] {
  return allSteps()
    .map((step) => String(step.run ?? ""))
    .filter((command) => command.length > 0);
}

function branchesOf(event: unknown): string[] {
  if (Array.isArray(event)) return event.map(String);
  const branches = (event as { branches?: unknown } | undefined)?.branches;
  return Array.isArray(branches) ? branches.map(String) : [];
}

test("TestREQ_CB_DOC_001_ci_triggers_cover_push_and_pr_on_main", () => {
  const on = workflow.on ?? {};
  assert.ok(branchesOf(on.push).includes("main"), "push to main must trigger CI");
  assert.ok(branchesOf(on.pull_request).includes("main"), "PRs targeting main must trigger CI");
});

test("TestREQ_CB_DOC_001_ci_matrix_targets_supported_node_versions", () => {
  const versions = new Set<number>();
  for (const job of Object.values(jobs)) {
    const matrix = job.strategy?.matrix?.["node-version"];
    if (Array.isArray(matrix)) for (const value of matrix) versions.add(Number(value));
  }
  for (const expected of [20, 22, 24]) {
    assert.ok(versions.has(expected), `the matrix must include Node ${expected}`);
  }
});

test("TestREQ_CB_DOC_001_ci_runs_checkout_install_and_typecheck", () => {
  assert.ok(
    allSteps().some((step) => String(step.uses ?? "").startsWith("actions/checkout")),
    "actions/checkout must run",
  );
  assert.ok(
    allSteps().some((step) => String(step.uses ?? "").startsWith("actions/setup-node")),
    "actions/setup-node must run",
  );
  const commands = runCommands();
  assert.ok(commands.some((command) => command.includes("npm ci")), "dependencies must install via npm ci");
  assert.ok(
    commands.some((command) => command.includes("npm install")),
    "install must fall back to npm install when no lockfile is tracked",
  );
  assert.ok(
    commands.some((command) => /(?:npx\s+)?tsc\s+--noEmit/.test(command)),
    "a typecheck step (npx tsc --noEmit) must exist",
  );
});

test("TestREQ_CB_DOC_001_ci_unit_tests_use_explicit_file_patterns", () => {
  const testCommands = runCommands().filter((command) => command.includes("--test"));
  assert.ok(testCommands.length > 0, "at least one node --test step must exist");
  assert.ok(
    testCommands.some((command) => /tests\/[^\s"']*\.test\.ts/.test(command)),
    "unit tests must pass an explicit *.test.ts pattern",
  );
  const bareDirectoryInvocations = testCommands.filter((command) =>
    /(?:^|\s)--test\s+["']?tests["']?\s*$/.test(command.trim()),
  );
  assert.equal(
    bareDirectoryInvocations.length,
    0,
    "the workflow must not invoke the broken `node --test tests` directory form",
  );
});

test("TestREQ_CB_DOC_001_ci_integration_job_is_variable_gated", () => {
  const integrationJobs = Object.entries(jobs).filter(([, job]) =>
    stepsOf(job).some((step) => {
      const command = String(step.run ?? "");
      return command.includes("tests/int-bridge.mjs") && command.includes("tests/int-session-mirror.mjs");
    }),
  );
  assert.equal(integrationJobs.length, 1, "exactly one job must invoke both CLI-gated integration suites");

  const [name, job] = integrationJobs[0]!;
  assert.ok(job.if, `job ${name} must be gated`);
  assert.match(job.if!, /vars\.CLAUDE_BRIDGE_INTEGRATION/, `job ${name} must gate on the repository variable`);
  assert.equal(job["runs-on"], "ubuntu-latest");
});

test("TestREQ_CB_DOC_001_ci_contains_no_hardcoded_secrets", () => {
  assert.ok(!/\$\{\{\s*secrets/i.test(SOURCE), "the workflow must not read the secrets context");
  assert.ok(!/(api[_-]?key|password|npm[_-]?token|gh[_-]?token)\s*[:=]/i.test(SOURCE), "no credentials may be hardcoded");
});

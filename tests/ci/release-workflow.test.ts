/**
 * Deterministic oracle for the release CD pipeline (.github/workflows/release.yml).
 *
 * Parses the workflow with a real YAML 1.2 parser and asserts the contract pinned
 * by REQ-CB-DOC-003: a tag-only trigger, read-only top-level permissions with
 * per-job least privilege, a `production` environment approval gate on the job
 * that publishes, the tag/package.json and CHANGELOG gates, a CycloneDX SBOM
 * artifact, and a `gh release create ... --verify-tag` step carrying that SBOM.
 *
 * The parser is Effect's bundled YAML 1.2 module, which arrives transitively via
 * @opencode/plugin's `effect` dependency (the same choice as workflow.test.ts).
 * A real parser is used deliberately: the declarative-config policy forbids ad-hoc
 * lexing of YAML, and no standalone YAML package is a direct dependency.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "effect/unstable/encoding/Yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = join(HERE, "..", "..", ".github", "workflows", "release.yml");
const SOURCE = readFileSync(WORKFLOW_PATH, "utf8");

interface Job {
  needs?: unknown;
  environment?: unknown;
  permissions?: unknown;
  "timeout-minutes"?: unknown;
  steps?: Array<Record<string, unknown>>;
}

interface Workflow {
  on?: Record<string, unknown>;
  permissions?: unknown;
  concurrency?: Record<string, unknown>;
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

function grantsOf(job: Job): Record<string, string> {
  const permissions = job.permissions;
  if (permissions === undefined || typeof permissions === "string") return {};
  return permissions as Record<string, string>;
}

function jobNamesWhere(predicate: (job: Job) => boolean): string[] {
  return Object.entries(jobs)
    .filter(([, job]) => predicate(job))
    .map(([name]) => name);
}

function publishes(job: Job): boolean {
  return stepsOf(job).some((step) => /npm\s+publish/.test(String(step.run ?? "")));
}

test("TestREQ_CB_DOC_003_release_triggers_only_on_version_tags", () => {
  const on = workflow.on ?? {};
  const push = on.push as { tags?: unknown; branches?: unknown } | undefined;
  assert.deepEqual(
    Array.isArray(push?.tags) ? push.tags.map(String) : [],
    ["v*"],
    "the release must be triggered by v* tag pushes only",
  );
  assert.equal(push?.branches, undefined, "a push branch filter would let a main-branch push publish");
  for (const [event, value] of Object.entries(on)) {
    const branches = (value as { branches?: unknown } | undefined)?.branches;
    assert.equal(branches, undefined, `event ${event} must not be scoped to branches`);
  }
});

test("TestREQ_CB_DOC_003_top_level_permissions_are_read_only", () => {
  const permissions = workflow.permissions;
  assert.notEqual(permissions, "write-all", "write-all must never be the default grant");
  if (typeof permissions === "string") {
    assert.equal(permissions, "read-all", "the only string form allowed at top level is read-all");
    return;
  }
  assert.ok(permissions && typeof permissions === "object", "a top-level permissions block must be declared");
  const grants = permissions as Record<string, string>;
  assert.ok(Object.keys(grants).length > 0, "the top-level permissions block must not be empty");
  for (const [scope, access] of Object.entries(grants)) {
    assert.ok(
      access === "read" || access === "none",
      `top-level grant ${scope} must be read-only or none, got ${access}`,
    );
  }
});

test("TestREQ_CB_DOC_003_publish_job_is_the_production_approval_gate", () => {
  const gated = jobNamesWhere((job) => job.environment !== undefined);
  assert.deepEqual(gated, ["publish"], "exactly one job may run under an environment gate");
  const publish = jobs.publish!;
  assert.equal(publish.environment, "production", "the publishing job must use the production environment");
  assert.ok(publishes(publish), "the approval-gated job must be the one that publishes to npm");
  assert.equal(publish.needs, "verify", "publishing must depend on the verification job");
  assert.deepEqual(jobNamesWhere(publishes), ["publish"], "exactly one job may run npm publish");
});

test("TestREQ_CB_DOC_003_job_level_least_privilege", () => {
  const writeScopes = (job: Job): string[] =>
    Object.entries(grantsOf(job))
      .filter(([, access]) => access === "write")
      .map(([scope]) => scope)
      .sort();

  assert.deepEqual(writeScopes(jobs.verify!), [], "the verify job must hold no write grant");
  assert.deepEqual(writeScopes(jobs.publish!), ["id-token"], "only the publish job may request id-token: write");
  assert.deepEqual(writeScopes(jobs["github-release"]!), ["contents"], "only the release job may write contents");
  assert.deepEqual(
    jobNamesWhere((job) => grantsOf(job)["id-token"] === "write"),
    ["publish"],
    "exactly one job may request OIDC id-token",
  );
  assert.deepEqual(
    jobNamesWhere((job) => grantsOf(job).contents === "write"),
    ["github-release"],
    "exactly one job may write repository contents",
  );
  assert.notDeepEqual(
    jobNamesWhere((job) => grantsOf(job)["id-token"] === "write"),
    jobNamesWhere((job) => grantsOf(job).contents === "write"),
    "the OIDC job and the contents-writing job must be distinct",
  );
});

test("TestREQ_CB_DOC_003_every_action_is_pinned_to_a_commit_sha", () => {
  const uses = allSteps()
    .map((step) => String(step.uses ?? ""))
    .filter((value) => value.length > 0);
  assert.ok(uses.length > 0, "the release pipeline must use actions");
  for (const reference of uses) {
    assert.match(reference, /^[^@\s]+@[0-9a-f]{40}$/, `${reference} must pin a full 40-hex commit SHA`);
  }
});

test("TestREQ_CB_DOC_003_sbom_is_generated_as_cyclonedx_and_uploaded", () => {
  const sbom = runCommands().filter((command) => /npm(?:\.cmd)?\s+sbom/.test(command));
  assert.ok(sbom.length > 0, "an npm sbom step must exist");
  assert.ok(
    sbom.some((command) => /--sbom-format[= ]cyclonedx/.test(command)),
    "the SBOM must be generated in CycloneDX format",
  );
  assert.ok(
    sbom.some((command) => command.includes("sbom.cdx.json")),
    "the SBOM must be written to sbom.cdx.json",
  );

  const upload = allSteps().find((step) => /^actions\/upload-artifact@/.test(String(step.uses ?? "")));
  assert.ok(upload, "the SBOM must be uploaded as a workflow artifact");
  const withBlock = upload.with as Record<string, unknown> | undefined;
  assert.equal(withBlock?.path, "sbom.cdx.json", "the uploaded path must be the generated SBOM");
  assert.equal(Number(withBlock?.["retention-days"]), 90, "the SBOM artifact must be retained for 90 days");
});

test("TestREQ_CB_DOC_003_github_release_is_created_with_the_sbom", () => {
  const commands = runCommands().filter((command) => command.includes("gh release create"));
  assert.equal(commands.length, 1, "exactly one gh release create step must exist");
  const command = commands[0]!;
  assert.ok(command.includes("--verify-tag"), "the release must refuse to run for a tag that does not exist");
  assert.ok(command.includes("--notes-file"), "the release must use the extracted changelog section");
  assert.ok(command.includes("sbom.cdx.json"), "the SBOM must be attached to the release");

  const job = jobs["github-release"]!;
  assert.ok(
    stepsOf(job).some((step) => /^actions\/download-artifact@/.test(String(step.uses ?? ""))),
    "the release job must download the SBOM artifact",
  );
  const notes = stepsOf(job).find((step) => String(step.run ?? "").includes("notes.md"));
  assert.ok(notes, "release notes must be extracted into notes.md");
  assert.match(String(notes.run ?? ""), /node -e/, "notes extraction must use a node -e one-liner");

  const releaseStep = stepsOf(job).find((step) => String(step.run ?? "").includes("gh release create"));
  const env = releaseStep?.env as Record<string, unknown> | undefined;
  assert.match(String(env?.GH_TOKEN ?? ""), /secrets\.GITHUB_TOKEN/, "gh must authenticate with GITHUB_TOKEN");
});

test("TestREQ_CB_DOC_003_tag_version_and_changelog_gates", () => {
  const derives = (command: string) => /REF_NAME|GITHUB_REF_NAME/.test(command);

  const versionGate = runCommands().find((command) => command.includes("package.json") && derives(command));
  assert.ok(versionGate, "a step must compare the pushed tag against package.json");
  assert.match(versionGate, /version/i, "the gate must read the package.json version field");
  assert.ok(versionGate.includes("::error::"), "the mismatch must fail with a ::error:: annotation");
  assert.match(versionGate, /\bexit 1\b/, "the mismatch must exit non-zero");

  const changelogGate = runCommands().find((command) => command.includes("CHANGELOG.md") && derives(command));
  assert.ok(changelogGate, "a step must check CHANGELOG.md for the released version");
  assert.ok(changelogGate.includes("::error::"), "a missing changelog entry must fail with a ::error:: annotation");
  assert.match(changelogGate, /\bexit 1\b/, "a missing changelog entry must exit non-zero");
});

test("TestREQ_CB_DOC_003_publish_is_serialized_and_every_job_is_bounded", () => {
  const concurrency = workflow.concurrency ?? {};
  assert.equal(concurrency["cancel-in-progress"], false, "a publish must never be cancelled mid-flight");
  assert.match(String(concurrency.group ?? ""), /github\.ref_name/, "the concurrency group must be per tag");

  for (const [name, job] of Object.entries(jobs)) {
    const timeout = job["timeout-minutes"];
    assert.equal(typeof timeout, "number", `job ${name} must declare a numeric timeout-minutes`);
    assert.ok(Number(timeout) > 0, `job ${name} must bound its runtime`);
  }
  assert.deepEqual(
    {
      verify: jobs.verify!["timeout-minutes"],
      publish: jobs.publish!["timeout-minutes"],
      "github-release": jobs["github-release"]!["timeout-minutes"],
    },
    { verify: 20, publish: 15, "github-release": 10 },
    "each stage must keep its documented timeout budget",
  );
});
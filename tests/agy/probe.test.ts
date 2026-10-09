/**
 * Deterministic oracle for the agy ProviderProbe and registry integration
 * (REQ-CB-AGY-001, design D11/D12).
 *
 * Proves, without a real CLI or filesystem:
 *  1. `detect` resolves the configured command through an injectable PATH probe.
 *  2. `version` runs `agy --version` and parses an injected semver-ish output.
 *  3. `health` is a cached-credentials existence check: absent token ->
 *     unavailable, present token -> healthy. The opt-in `agy -p` ping is the
 *     only path that spends quota, and it is off unless explicitly enabled.
 *     The probe's I/O seam exposes no file-reading member at all, so token
 *     contents can never be read or logged.
 *  4. The registry binding exposes the `agy` provider with the pinned 14-slug
 *     model catalog and capability-honest flags (no interactive approval, no
 *     mid-turn steer), and the ack gate refuses registration inputs missing any
 *     acknowledged constraint.
 *  5. Resume accounting: seeding the mapper's cumulative baseline from the
 *     out-of-band ledger keeps a resumed turn from double-counting usage.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Model } from "@opencode/plugin";

import { AGY_CONSTRAINTS } from "../../src/config/schema.ts";
import { AgyEventMapper } from "../../src/agy/event-mapper.ts";
import type { AgyCommandResult, AgyProbeIo } from "../../src/agy/probe.ts";
import {
  AGY_DEFAULT_PING_ARGS,
  AGY_MODEL_SLUGS,
  AGY_OAUTH_TOKEN_RELATIVE_PATH,
  AGY_PROVIDER_CAPABILITY_FLAGS,
  AgyProbe,
  AgyUsageBaselineLedger,
  agyOAuthTokenPath,
  agyRegistrationEnabled,
  parseAgyVersion,
  primeAgyResumeBaseline,
  registerAgyProvider,
} from "../../src/agy/probe.ts";
import { getProviderCatalog } from "../../src/provider/registration.ts";
import { createProviderRegistry, inspectCapabilities } from "../../src/provider/registry.ts";
import type { CliTransport, SessionHandle, SessionStore, ToolChannel } from "../../src/provider/seams.ts";
import { EMPTY_USAGE } from "../../src/provider/seams.ts";

// ---------------------------------------------------------------------------
// Recording probe I/O. `pathExists` never reads; there is no read member.
// ---------------------------------------------------------------------------

interface RecordedRun {
  readonly command: string;
  readonly args: readonly string[];
}

interface FakeProbeIo extends AgyProbeIo {
  readonly resolved: string[];
  readonly existed: string[];
  readonly run: (command: string, args: readonly string[]) => Promise<AgyCommandResult>;
  readonly runs: RecordedRun[];
}

function createFakeProbeIo(options: {
  readonly executable?: string | undefined;
  readonly existingPaths?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly runResult?: AgyCommandResult;
}): FakeProbeIo {
  const resolved: string[] = [];
  const existed: string[] = [];
  const runs: RecordedRun[] = [];
  const existing = new Set(options.existingPaths ?? []);
  const result = options.runResult ?? { code: 0, stdout: "", stderr: "" };

  return {
    resolved,
    existed,
    runs,
    async resolveExecutable(command) {
      resolved.push(command);
      return options.executable;
    },
    async pathExists(targetPath) {
      existed.push(targetPath);
      return existing.has(targetPath);
    },
    getEnv: (name) => options.env?.[name],
    async run(command, args) {
      runs.push({ command, args });
      return result;
    },
  };
}

const HOME = "/home/operator";
const TOKEN_PATH = agyOAuthTokenPath(HOME);

// ---------------------------------------------------------------------------
// Seam stand-ins for the registration test.
// ---------------------------------------------------------------------------

const noopTransport: CliTransport = {
  buildArgv: () => [],
  spawn: () => Promise.reject(new Error("spawn unused in probe test")),
  writeFrame: () => Promise.resolve(),
  readLines: () => (async function* empty() {})(),
  captureStderr: () => Promise.resolve(""),
  mapExitCode: (code, stderr) => ({
    code,
    kind: "transport/exit",
    fatal: code !== 0,
    message: stderr.length > 0 ? stderr : `exit ${code}`,
  }),
  watchdog: () => ({ arm() {}, disarm() {} }),
};

const noopSessions: SessionStore = {
  capture: () => undefined,
  serialize: (handle) => JSON.stringify(handle),
  deserialize: (value) => JSON.parse(value) as SessionHandle,
  resumeArgs: () => [],
};

const noopTools: ToolChannel = { registerHostTools: () => Promise.resolve() };

function registerFakeAgy() {
  return registerAgyProvider(createProviderRegistry(), {
    transport: noopTransport,
    eventMapper: new AgyEventMapper(),
    sessions: noopSessions,
    tools: noopTools,
    probe: new AgyProbe({ io: createFakeProbeIo({ executable: "/usr/local/bin/agy" }) }),
  });
}

// ---------------------------------------------------------------------------
// Probe.
// ---------------------------------------------------------------------------

describe("REQ-CB-AGY-001 AgyProbe detection, version and health", () => {
  it("TestREQ_CB_AGY_001_probe_detects_binary_on_path", async () => {
    const detectedIo = createFakeProbeIo({ executable: "/Users/operator/.local/bin/agy" });
    const probe = new AgyProbe({ command: "agy", io: detectedIo });
    assert.equal(await probe.detect(), true);
    assert.deepEqual(detectedIo.resolved, ["agy"]);

    const missingIo = createFakeProbeIo({ executable: undefined });
    assert.equal(await new AgyProbe({ io: missingIo }).detect(), false);
  });

  it("TestREQ_CB_AGY_001_probe_parses_version_from_injected_output", async () => {
    const io = createFakeProbeIo({ runResult: { code: 0, stdout: "1.3.2\n", stderr: "" } });
    const probe = new AgyProbe({ io });
    assert.equal(await probe.version(), "1.3.2");
    assert.deepEqual(io.runs, [{ command: "agy", args: ["--version"] }]);

    const prefixed = createFakeProbeIo({
      runResult: { code: 0, stdout: "agy version v1.4.0-beta.1\n", stderr: "" },
    });
    assert.equal(await new AgyProbe({ io: prefixed }).version(), "1.4.0-beta.1");

    const failed = createFakeProbeIo({
      runResult: { code: 127, stdout: "", stderr: "command not found" },
    });
    assert.equal(await new AgyProbe({ io: failed }).version(), undefined);

    const unparsable = createFakeProbeIo({
      runResult: { code: 0, stdout: "no version here", stderr: "" },
    });
    assert.equal(await new AgyProbe({ io: unparsable }).version(), undefined);

    assert.equal(parseAgyVersion("v2.0.0+build.7"), "2.0.0+build.7");
  });

  it("TestREQ_CB_AGY_001_probe_health_is_token_presence_only_and_never_reads", async () => {
    // No token, default io -> unavailable; the command is never executed.
    const absentIo = createFakeProbeIo({ existingPaths: [] });
    const absent = new AgyProbe({ homeDir: HOME, io: absentIo });
    assert.equal(await absent.health(), "unavailable");
    assert.deepEqual(absentIo.existed, [TOKEN_PATH]);
    assert.deepEqual(absentIo.runs, []);

    // Token present, ping off (default) -> healthy, and still no quota spent.
    const presentIo = createFakeProbeIo({ existingPaths: [TOKEN_PATH] });
    const present = new AgyProbe({ homeDir: HOME, io: presentIo });
    assert.equal(await present.health(), "healthy");
    assert.deepEqual(presentIo.existed, [TOKEN_PATH]);
    assert.deepEqual(presentIo.runs, []);

    // Env-based home resolution (HOME, then USERPROFILE) uses the same path.
    const envIo = createFakeProbeIo({ existingPaths: [TOKEN_PATH], env: { HOME } });
    assert.equal(await new AgyProbe({ io: envIo }).health(), "healthy");
    assert.deepEqual(envIo.existed, [TOKEN_PATH]);
  });

  it("TestREQ_CB_AGY_001_probe_health_ping_is_opt_in_and_spends_quota_only_then", async () => {
    const pingArgs = AGY_DEFAULT_PING_ARGS;
    const okIo = createFakeProbeIo({
      existingPaths: [TOKEN_PATH],
      runResult: { code: 0, stdout: "pong", stderr: "" },
    });
    const healthy = new AgyProbe({ homeDir: HOME, io: okIo, cheapPing: true });
    assert.equal(await healthy.health(), "healthy");
    assert.deepEqual(okIo.runs, [{ command: "agy", args: [...pingArgs] }]);

    const failIo = createFakeProbeIo({
      existingPaths: [TOKEN_PATH],
      runResult: { code: 1, stdout: "", stderr: "quota" },
    });
    const degraded = new AgyProbe({ homeDir: HOME, io: failIo, cheapPing: true });
    assert.equal(await degraded.health(), "degraded");

    // Ping stays off for an absent token: health short-circuits before running.
    const absentPingIo = createFakeProbeIo({ existingPaths: [] });
    const absentPing = new AgyProbe({ homeDir: HOME, io: absentPingIo, cheapPing: true });
    assert.equal(await absentPing.health(), "unavailable");
    assert.deepEqual(absentPingIo.runs, []);
  });

  it("TestREQ_CB_AGY_001_probe_io_has_no_file_read_capability", () => {
    const io: AgyProbeIo = createFakeProbeIo({});
    assert.deepEqual(
      Object.keys(io).filter((key) => key !== "resolved" && key !== "existed" && key !== "runs"),
      ["resolveExecutable", "pathExists", "getEnv", "run"],
    );
    assert.equal("readFile" in io, false);
    assert.equal("readToken" in io, false);
    assert.equal(AGY_OAUTH_TOKEN_RELATIVE_PATH, ".gemini/antigravity-cli/antigravity-oauth-token");
  });
});

// ---------------------------------------------------------------------------
// Registry integration.
// ---------------------------------------------------------------------------

describe("REQ-CB-AGY-001 registry binding", () => {
  it("TestREQ_CB_AGY_001_registry_exposes_agy_provider_models_and_capabilities", () => {
    const registry = createProviderRegistry();
    const registration = registerAgyProvider(registry, {
      transport: noopTransport,
      eventMapper: new AgyEventMapper(),
      sessions: noopSessions,
      tools: noopTools,
    });

    assert.equal(registry.has("agy"), true);
    assert.equal(registry.get("agy")?.id, "agy");
    assert.equal(registry.resolve(["agy"]).length, 1);

    const catalog = getProviderCatalog(registry, "agy");
    assert.ok(catalog);
    assert.equal(catalog.providerId, "agy");
    assert.equal(catalog.models.length, 14);
    assert.deepEqual(
      catalog.models.map((model: Model.Info) => model.id),
      [...AGY_MODEL_SLUGS],
    );
    for (const model of catalog.models) {
      assert.equal(model.providerID, "agy");
      assert.equal(model.modelID, model.id);
      assert.equal(model.capabilities.tools, true);
      assert.deepEqual(model.capabilities.input, ["text"]);
    }

    assert.deepEqual(inspectCapabilities(registration.provider), {
      id: "agy",
      supportsInteractiveApproval: false,
      supportsMidTurnSteer: false,
    });
    assert.deepEqual(AGY_PROVIDER_CAPABILITY_FLAGS, {
      supportsInteractiveApproval: false,
      supportsMidTurnSteer: false,
    });
  });

  it("TestREQ_CB_AGY_001_registration_gate_requires_enabled_and_acknowledged", () => {
    const allIds = AGY_CONSTRAINTS.map((constraint) => constraint.id);

    assert.equal(agyRegistrationEnabled({ enabled: false, acknowledgedConstraints: allIds }), false);
    assert.equal(agyRegistrationEnabled({ enabled: true, acknowledgedConstraints: [] }), false);
    assert.equal(
      agyRegistrationEnabled({ enabled: true, acknowledgedConstraints: allIds.slice(1) }),
      false,
    );
    assert.equal(agyRegistrationEnabled({ enabled: true, acknowledgedConstraints: allIds }), true);
  });

  it("TestREQ_CB_AGY_001_models_catalog_is_the_pinned_fourteen_slugs", () => {
    assert.equal(AGY_MODEL_SLUGS.length, 14);
    assert.equal(new Set(AGY_MODEL_SLUGS).size, 14);
    assert.ok(AGY_MODEL_SLUGS.includes("gemini-3.8-flash-high"));
    assert.ok(AGY_MODEL_SLUGS.includes("claude-sonnet-4-6"));
    assert.ok(AGY_MODEL_SLUGS.includes("gpt-oss-120b-medium"));
  });
});

// ---------------------------------------------------------------------------
// Resume accounting (integration duty handed off to cb-26).
// ---------------------------------------------------------------------------

describe("REQ-CB-AGY-001 resume usage baseline", () => {
  it("TestREQ_CB_AGY_001_resume_baseline_prevents_double_counting", () => {
    const handle: SessionHandle = { provider: "agy", conversationRef: "conv-1" };
    const ledger = new AgyUsageBaselineLedger();
    const persisted = { inputTokens: 100, outputTokens: 40, cacheReadTokens: 5, cacheWriteTokens: 0 };
    ledger.record(handle, persisted);

    const mapper = new AgyEventMapper();
    const seeded = primeAgyResumeBaseline(mapper, handle, ledger.provider());
    assert.deepEqual(seeded, persisted);
    assert.deepEqual(mapper.sessionBaseline, persisted);

    // A resumed turn ends at a cumulative total; only the delta may surface.
    const result = mapper.toTurnResult([
      { event: "result", conversation_id: "conv-1", result: { status: "SUCCESS", response: "hi", usage: { input_tokens: 160, output_tokens: 70, cache_read_tokens: 9 } } },
    ]);
    assert.deepEqual(result.usage, {
      inputTokens: 60,
      outputTokens: 30,
      cacheReadTokens: 4,
      cacheWriteTokens: 0,
    });
  });

  it("TestREQ_CB_AGY_001_resume_without_baseline_defaults_to_empty", () => {
    const handle: SessionHandle = { provider: "agy", conversationRef: "conv-2" };
    const mapper = new AgyEventMapper();
    assert.deepEqual(primeAgyResumeBaseline(mapper, handle), EMPTY_USAGE);
    assert.deepEqual(mapper.sessionBaseline, EMPTY_USAGE);

    const ledger = new AgyUsageBaselineLedger();
    assert.equal(ledger.get(handle), undefined);
    ledger.record(handle, { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 });
    assert.deepEqual(ledger.get(handle), {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    });
    // Mutating a returned copy never reaches the ledger (defensive copies).
    const copy = ledger.get(handle);
    if (copy !== undefined) (copy as { inputTokens: number }).inputTokens = 999;
    assert.equal(ledger.get(handle)?.inputTokens, 1);

    ledger.clear(handle);
    assert.equal(ledger.get(handle), undefined);
  });

  it("TestREQ_CB_AGY_001_registration_defaults_to_a_fresh_ledger", () => {
    const registration = registerFakeAgy();
    const handle: SessionHandle = { provider: "agy", conversationRef: "conv-3" };
    registration.baselines.record(handle, {
      inputTokens: 7,
      outputTokens: 8,
      cacheReadTokens: 9,
      cacheWriteTokens: 10,
    });
    assert.deepEqual(registration.usageBaselineProvider(handle), {
      inputTokens: 7,
      outputTokens: 8,
      cacheReadTokens: 9,
      cacheWriteTokens: 10,
    });
  });
});

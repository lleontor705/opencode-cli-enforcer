import test from "node:test";
import assert from "node:assert/strict";

import type {
  CliTransport,
  EventMapper,
  Provider,
  ProviderProbe,
  SessionHandle,
  SessionStore,
  ToolChannel,
  TurnUsage,
} from "../../src/provider/seams.js";
import { EMPTY_USAGE, usageDelta } from "../../src/provider/seams.js";
import { createProviderRegistry, inspectCapabilities } from "../../src/provider/registry.js";

// ---------------------------------------------------------------------------
// Shared no-op seam implementations used to assemble fake providers.
// ---------------------------------------------------------------------------

const noopTransport: CliTransport = {
  buildArgv: () => [],
  spawn: () => Promise.reject(new Error("spawn not used in contract test")),
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

const noopTools: ToolChannel = {
  registerHostTools: () => Promise.resolve(),
};

function healthyProbe(version: string): ProviderProbe {
  return {
    detect: () => Promise.resolve(true),
    version: () => Promise.resolve(version),
    health: () => Promise.resolve("healthy"),
  };
}

// ---------------------------------------------------------------------------
// Fake second provider ("acme") with its own native event shape and a
// cumulative-per-session usage counter, mirroring the agy semantics the seams
// must be able to normalize.
// ---------------------------------------------------------------------------

interface AcmeRawEvent {
  readonly type: string;
  readonly text?: string;
  readonly totalInput?: number;
  readonly totalOutput?: number;
  readonly conversation?: string;
}

interface AcmeNormalizedEvent {
  readonly type: string;
  readonly text?: string;
}

const ACME_SESSION_BASELINE: TurnUsage = { ...EMPTY_USAGE, inputTokens: 40, outputTokens: 10 };

function createAcmeMapper(): EventMapper<AcmeRawEvent, AcmeNormalizedEvent> {
  return {
    map(raw) {
      if (raw.type === "noise") {
        return undefined;
      }
      return { type: raw.type, text: raw.text };
    },
    toTurnResult(events) {
      const last = events.at(-1);
      const cumulative = {
        inputTokens: last?.totalInput ?? 0,
        outputTokens: last?.totalOutput ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      return {
        status: "completed",
        text: events.map((event) => event.text ?? "").join(""),
        usage: usageDelta(cumulative, ACME_SESSION_BASELINE),
        sessionId: last?.conversation ?? "acme-default",
      };
    },
  };
}

function createAcmeProvider(): Provider {
  return {
    id: "acme",
    transport: noopTransport,
    eventMapper: createAcmeMapper(),
    sessions: noopSessions,
    tools: noopTools,
    permissions: { supportsInteractiveApproval: true },
    steering: { supportsMidTurnSteer: true },
    probe: healthyProbe("acme-cli 1.0.0"),
  };
}

/** Provider with agy-shaped capability flags: no interactive approval, no mid-turn steer. */
function createAgyLikeProvider(): Provider {
  return {
    id: "agy",
    transport: noopTransport,
    eventMapper: createAcmeMapper(),
    sessions: noopSessions,
    tools: noopTools,
    permissions: { supportsInteractiveApproval: false },
    steering: { supportsMidTurnSteer: false },
    probe: healthyProbe("agy-cli 1.3.2"),
  };
}

test("TestREQ_CB_SEAM_001_seams_are_provider_agnostic", async () => {
  const registry = createProviderRegistry([createAcmeProvider()]);

  // A non-Claude implementation registers through the same entry point.
  const agyLike = createAgyLikeProvider();
  registry.register(agyLike);
  assert.deepEqual(registry.list().map((provider) => provider.id), ["acme", "agy"]);

  // Core wiring resolves enabled ids and consumes only seam members.
  const wired = registry.resolve(["acme", "agy"]);
  assert.equal(wired.length, 2);
  assert.equal(wired[0]?.id, "acme");
  assert.equal(wired[1]?.id, "agy");

  for (const provider of wired) {
    assert.equal(typeof provider.transport.buildArgv, "function");
    assert.equal(typeof provider.eventMapper.toTurnResult, "function");
    assert.equal(typeof provider.sessions.capture, "function");
    assert.equal(typeof provider.tools.registerHostTools, "function");
    assert.equal(typeof provider.permissions.supportsInteractiveApproval, "boolean");
    assert.equal(typeof provider.steering.supportsMidTurnSteer, "boolean");
    assert.equal(typeof provider.probe.detect, "function");
    assert.equal(await provider.probe.detect(), true);
  }

  assert.deepEqual(inspectCapabilities(wired[0] as Provider), {
    id: "acme",
    supportsInteractiveApproval: true,
    supportsMidTurnSteer: true,
  });

  assert.throws(() => registry.resolve(["missing"]), /provider not registered: missing/);
  assert.throws(() => registry.register(createAcmeProvider()), /already registered: acme/);
});

test("TestREQ_CB_SEAM_001_agy_capability_flags_are_representable", () => {
  const capabilities = inspectCapabilities(createAgyLikeProvider());
  assert.deepEqual(capabilities, {
    id: "agy",
    supportsInteractiveApproval: false,
    supportsMidTurnSteer: false,
  });
});

test("TestREQ_CB_SEAM_001_usage_is_normalized_at_the_seam", () => {
  const mapper = createAcmeMapper();
  const result = mapper.toTurnResult([
    { type: "step", text: "hello ", totalInput: 140, totalOutput: 30, conversation: "conv-1" },
    { type: "noise" },
    { type: "result", text: "world", totalInput: 180, totalOutput: 42, conversation: "conv-1" },
  ]);

  assert.equal(result.status, "completed");
  assert.equal(result.text, "hello world");
  assert.equal(result.sessionId, "conv-1");
  // Cumulative-per-session counters (180/42) minus the session baseline (40/10).
  assert.deepEqual(result.usage, {
    inputTokens: 140,
    outputTokens: 32,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.deepEqual(EMPTY_USAGE, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});

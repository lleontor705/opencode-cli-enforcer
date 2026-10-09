/**
 * Capability-honest adapter contract oracles for the agy (Google Antigravity
 * CLI) Wave B adapter (REQ-CB-AGY-001, design D11/D12).
 *
 * The sibling agy test files prove each module in isolation. This file proves
 * the *composition* the seams promise, and that the capability downgrade is
 * honest rather than papered over:
 *
 *  1. transport + mapper: a scripted agy stdout stream is read by the cb-21
 *     transport, parsed, and folded by the cb-22 mapper into per-turn
 *     `TurnResult`s whose usage is a delta against the running baseline — two
 *     turns of one conversation sum to the cumulative total exactly once.
 *  2. resume end-to-end at the seam: cb-23 `planTurn` -> `resumeArgs` -> cb-21
 *     `buildArgv` -> cb-22 `resetSession` primed from the cb-25 ledger; the
 *     resumed turn reports only its own delta, never the prior session total.
 *  3. capability contract: frozen flags across every module, no reasoning
 *     stream, no partial tool input, no mid-turn steer (steers queue and drain
 *     at the turn boundary), and never a control frame on the wire.
 *  4. channel contract: verbatim schemas, dry-run manifest default, fail-closed
 *     permission flags.
 *  5. runner contract: loopback-only binding, bearer auth, and `isError` on
 *     failure at the summary level (the full stdio round trip lives in
 *     tests/agy/runner.test.ts).
 *  6. fixtures: the committed agy stream fixtures are schema-versioned, cover
 *     the init/step_update/result event classes, and replay deterministically.
 *  7. recorder pipeline: the record-agy-streams.mjs scrub/header/write path is
 *     deterministic and hermetic (no live CLI).
 *
 * Every oracle is deterministic: no wall-clock ordering, injected spawners and
 * deadline-bounded network calls only.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { BridgeError } from "../../src/errors/taxonomy.ts";
import type { AgyChildProcessLike, AgyReadableLike } from "../../src/agy/transport.ts";
import { AGY_TRANSPORT_DEFAULT_COMMAND, AgyTransport, assertWritableAgyFrame } from "../../src/agy/transport.ts";
import type { AgyRawEvent } from "../../src/agy/event-mapper.ts";
import { AGY_MAPPER_CAPABILITIES, AgyEventMapper, parseAgyLine } from "../../src/agy/event-mapper.ts";
import { AGY_PROVIDER_ID, AgySessionStore } from "../../src/agy/session-store.ts";
import {
  AGY_MCP_SERVER_DEFAULT_NAME,
  AGY_PERMISSION_BYPASS_FLAG,
  AgyPermissionPolicy,
  AgySteeringPolicy,
  AgyToolChannel,
  qualifiedToolName,
} from "../../src/agy/channel.ts";
import {
  AGY_PROVIDER_CAPABILITY_FLAGS,
  AgyUsageBaselineLedger,
  createAgyProvider,
  primeAgyResumeBaseline,
} from "../../src/agy/probe.ts";
import {
  AGY_HOST_BRIDGE_LOOPBACK_HOST,
  isLoopbackHostname,
  resolveRunnerEndpoint,
  startAgyHostBridge,
} from "../../src/agy/runner.ts";
import type { HostTool, SessionHandle, SpawnedCli, TurnUsage } from "../../src/provider/seams.ts";
import { EMPTY_USAGE } from "../../src/provider/seams.ts";
import { inspectCapabilities } from "../../src/provider/registry.ts";
import {
  AGY_STREAM_SCHEMA_VERSION,
  assertFixtureHeader,
  listFixtures,
  loadFixture,
  parseFixtureText,
  recordScenario,
} from "../lib/record-agy-streams.mjs";

// ---------------------------------------------------------------------------
// Scripted child (injected spawner; the unit tier never spawns a real process).
// ---------------------------------------------------------------------------

class FakeWritable {
  readonly writes: string[] = [];
  ended = false;

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }

  end(chunk?: string): unknown {
    if (typeof chunk === "string") this.writes.push(chunk);
    this.ended = true;
    return this;
  }
}

function readableFrom(chunks: readonly string[]): AgyReadableLike {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

class FakeChild implements AgyChildProcessLike {
  readonly pid = 5150;
  readonly stdin = new FakeWritable();
  readonly stdout: AgyReadableLike | null;
  readonly stderr: AgyReadableLike | null;
  killed = false;

  private readonly exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];

  constructor(options: { stdout?: readonly string[]; stderr?: readonly string[] } = {}) {
    this.stdout = options.stdout === undefined ? null : readableFrom(options.stdout);
    this.stderr = options.stderr === undefined ? null : readableFrom(options.stderr);
  }

  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "exit" | "error",
    listener:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ): unknown {
    if (event === "exit") {
      this.exitListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    } else {
      this.errorListeners.push(listener as (error: Error) => void);
    }
    return this;
  }

  emitExit(code: number | null): void {
    for (const listener of [...this.exitListeners]) listener(code, null);
  }

  kill(_signal?: NodeJS.Signals): boolean {
    this.killed = true;
    return true;
  }
}

function isBridgeCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof BridgeError && error.code === code;
}

// ---------------------------------------------------------------------------
// Frame builders and helpers.
// ---------------------------------------------------------------------------

function init(conversation: string, tools: readonly string[] = []): AgyRawEvent {
  return {
    event: "init",
    conversation_id: conversation,
    init: { tools, permission_mode: "request-review", model: "gemini-3.8-flash-medium" },
  };
}

function step(conversation: string, index: number, state: "ACTIVE" | "DONE", type: string, extra: Record<string, unknown> = {}): AgyRawEvent {
  return { event: "step_update", step_update: { conversation_id: conversation, step_index: index, state, step_type: type, ...extra } };
}

function result(conversation: string, response: string, usage: Record<string, number>, numTurns: number): AgyRawEvent {
  return { event: "result", result: { conversation_id: conversation, status: "SUCCESS", response, num_turns: numTurns, usage } };
}

/** Split a flat event array into turns at each terminal `result` frame. */
function splitTurns(frames: readonly AgyRawEvent[]): AgyRawEvent[][] {
  const turns: AgyRawEvent[][] = [];
  let current: AgyRawEvent[] = [];
  for (const frame of frames) {
    current.push(frame);
    if (frame.event === "result") {
      turns.push(current);
      current = [];
    }
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

function sumUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

function hostTool(name: string, inputSchema: unknown, call: () => Promise<{ content: string; isError?: boolean }>): HostTool {
  return { descriptor: { name, description: `${name} tool`, inputSchema }, call };
}

const CONVERSATION = "6b1d0a5e-3c44-4f2a-9b71-2d5c8e0f9a13";

// Two turns of one conversation with cumulative-per-session usage, mirroring the
// committed multi-turn-resume fixture.
const TURN_ONE: readonly AgyRawEvent[] = [
  init(CONVERSATION, ["run_command"]),
  step(CONVERSATION, 0, "DONE", "user_input"),
  step(CONVERSATION, 1, "DONE", "agent_response", { text_delta: "first answer", usage: { input_tokens: 100, output_tokens: 20 } }),
  result(CONVERSATION, "first answer", { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0 }, 1),
];
const TURN_TWO: readonly AgyRawEvent[] = [
  step(CONVERSATION, 2, "DONE", "user_input"),
  step(CONVERSATION, 3, "DONE", "agent_response", { text_delta: "second answer", usage: { input_tokens: 40, output_tokens: 10, cache_read_tokens: 100 } }),
  result(CONVERSATION, "second answer", { input_tokens: 140, output_tokens: 30, cache_read_tokens: 100 }, 2),
];

const TURN_ONE_USAGE: TurnUsage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };
const TURN_TWO_USAGE: TurnUsage = { inputTokens: 40, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 0 };

// ---------------------------------------------------------------------------
// 1. transport + mapper composition.
// ---------------------------------------------------------------------------

test("TestREQ_CB_AGY_001_capability_honest_adapter_transport_to_mapper_two_turns", async () => {
  const unknown = { event: "future_thing", future: true };
  const stdout = [[...TURN_ONE, unknown, ...TURN_TWO].map((frame) => JSON.stringify(frame)).join("\n")];
  const child = new FakeChild({ stdout });
  const transport = new AgyTransport({ spawn: () => child });

  const cli: SpawnedCli = await transport.spawn({ command: AGY_TRANSPORT_DEFAULT_COMMAND, args: [] });
  const raw: AgyRawEvent[] = [];
  for await (const line of transport.readLines(cli)) raw.push(parseAgyLine(line));

  // The transport's forward-compatibility filter is what the mapper folds: an
  // unrecognized-but-well-formed event never reaches it.
  assert.ok(!raw.some((event) => event.event === "future_thing"), "unknown events are filtered before the mapper");

  const mapper = new AgyEventMapper();
  const turns = splitTurns(raw).map((events) => mapper.toTurnResult(events));
  assert.equal(turns.length, 2);

  assert.deepEqual(turns[0].usage, TURN_ONE_USAGE, "turn 1 delta starts from the empty baseline");
  assert.deepEqual(turns[1].usage, TURN_TWO_USAGE, "turn 2 delta subtracts the running baseline");
  assert.equal(turns[0].status, "completed");
  assert.equal(turns[1].status, "completed");
  assert.equal(turns[0].sessionId, CONVERSATION);
  assert.equal(turns[1].sessionId, CONVERSATION);

  const deltaSum = sumUsage(turns[0].usage, turns[1].usage);
  assert.deepEqual(deltaSum, mapper.sessionBaseline, "per-turn deltas sum to the session total exactly once");
  assert.deepEqual(deltaSum, { inputTokens: 140, outputTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 0 });
});

// ---------------------------------------------------------------------------
// 2. Resume flow end-to-end at the seam.
// ---------------------------------------------------------------------------

test("TestREQ_CB_AGY_001_capability_honest_adapter_resume_seam_never_double_counts", async () => {
  const store = new AgySessionStore();
  const ledger = new AgyUsageBaselineLedger();
  const handle: SessionHandle = { provider: AGY_PROVIDER_ID, conversationRef: CONVERSATION };

  // Turn 1 ran on a fresh mapper; its ending cumulative becomes the ledger entry.
  const firstMapper = new AgyEventMapper();
  const firstTurn = firstMapper.toTurnResult([...TURN_ONE]);
  assert.deepEqual(firstTurn.usage, TURN_ONE_USAGE);
  ledger.record(handle, firstMapper.sessionBaseline);

  // cb-23 planTurn -> resumeArgs -> cb-21 argv.
  const plan = store.planTurn({ handle });
  assert.equal(plan.transition, "reuse");
  assert.deepEqual(plan.resumeArgs, ["--conversation", CONVERSATION]);
  const argv = new AgyTransport().buildArgv({ model: "gemini-3.8-flash-medium", session: plan.handle ?? undefined });
  const flagIndex = argv.indexOf("--conversation");
  assert.ok(flagIndex >= 0, "the resumed argv must carry --conversation");
  assert.equal(argv[flagIndex + 1], CONVERSATION);

  // cb-25 ledger primes the mapper baseline; the resumed turn reports only its delta.
  const resumedMapper = new AgyEventMapper();
  const seeded = primeAgyResumeBaseline(resumedMapper, handle, ledger.provider());
  assert.deepEqual(seeded, TURN_ONE_USAGE);
  const resumedTurn = resumedMapper.toTurnResult([...TURN_TWO]);
  assert.deepEqual(resumedTurn.usage, TURN_TWO_USAGE, "a resumed turn must not re-report the prior cumulative total");

  // The two turns still account for the whole session exactly once.
  assert.deepEqual(sumUsage(firstTurn.usage, resumedTurn.usage), resumedMapper.sessionBaseline);
});

test("TestREQ_CB_AGY_001_capability_honest_adapter_stale_history_clean_starts_and_drops_baseline", () => {
  const store = new AgySessionStore();
  const handle: SessionHandle = { provider: AGY_PROVIDER_ID, conversationRef: CONVERSATION };

  const plan = store.planTurn({ handle, historyStale: true });
  assert.equal(plan.transition, "clean-start");
  assert.equal(plan.handle, null);
  assert.deepEqual(plan.resumeArgs, []);

  // A clean-start is a fresh conversation: no --conversation flag and an empty baseline.
  const argv = new AgyTransport().buildArgv({ model: "m", session: plan.handle ?? undefined });
  assert.ok(!argv.includes("--conversation"));
  const mapper = new AgyEventMapper();
  mapper.resetSession();
  assert.deepEqual(mapper.sessionBaseline, EMPTY_USAGE);
});

// ---------------------------------------------------------------------------
// 3. Capability contract: frozen flags + missing-pillar degradation.
// ---------------------------------------------------------------------------

test("TestREQ_CB_AGY_001_capability_honest_adapter_seams_unchanged", async () => {
  const provider = createAgyProvider({
    transport: new AgyTransport(),
    eventMapper: new AgyEventMapper(),
    sessions: new AgySessionStore(),
    tools: new AgyToolChannel(),
  });

  // All seven Wave A seam members are present on the real agy implementations.
  assert.equal(typeof provider.transport.buildArgv, "function");
  assert.equal(typeof provider.transport.spawn, "function");
  assert.equal(typeof provider.transport.writeFrame, "function");
  assert.equal(typeof provider.transport.readLines, "function");
  assert.equal(typeof provider.transport.captureStderr, "function");
  assert.equal(typeof provider.transport.mapExitCode, "function");
  assert.equal(typeof provider.transport.watchdog, "function");
  assert.equal(typeof provider.eventMapper.map, "function");
  assert.equal(typeof provider.eventMapper.toTurnResult, "function");
  assert.equal(typeof provider.sessions.capture, "function");
  assert.equal(typeof provider.sessions.serialize, "function");
  assert.equal(typeof provider.sessions.deserialize, "function");
  assert.equal(typeof provider.sessions.resumeArgs, "function");
  assert.equal(typeof provider.tools.registerHostTools, "function");
  assert.equal(typeof provider.permissions.supportsInteractiveApproval, "boolean");
  assert.equal(typeof provider.steering.supportsMidTurnSteer, "boolean");
  assert.equal(typeof provider.probe.detect, "function");
  assert.equal(typeof provider.probe.version, "function");
  assert.equal(typeof provider.probe.health, "function");

  assert.deepEqual(inspectCapabilities(provider), {
    id: "agy",
    supportsInteractiveApproval: false,
    supportsMidTurnSteer: false,
  });
});

test("TestREQ_CB_AGY_001_capability_honest_adapter_capability_flags_are_frozen_and_honest", () => {
  assert.equal(Object.isFrozen(AGY_MAPPER_CAPABILITIES), true);
  assert.equal(Object.isFrozen(AGY_PROVIDER_CAPABILITY_FLAGS), true);

  const mapper = new AgyEventMapper();
  assert.deepEqual(mapper.capabilities, AGY_MAPPER_CAPABILITIES);
  assert.equal(AGY_MAPPER_CAPABILITIES.reasoningStream, false);
  assert.equal(AGY_MAPPER_CAPABILITIES.partialToolInput, false);
  assert.equal(AGY_MAPPER_CAPABILITIES.streamingGranularity, "step");
  assert.equal(AGY_MAPPER_CAPABILITIES.usageAccounting, "cumulative-normalized-at-seam");

  const steering = new AgySteeringPolicy();
  const permission = new AgyPermissionPolicy();
  assert.equal(AGY_MAPPER_CAPABILITIES.midTurnSteer, false);
  assert.equal(steering.supportsMidTurnSteer, AGY_MAPPER_CAPABILITIES.midTurnSteer);
  assert.equal(permission.supportsInteractiveApproval, AGY_PROVIDER_CAPABILITY_FLAGS.supportsInteractiveApproval);
  assert.equal(steering.supportsMidTurnSteer, AGY_PROVIDER_CAPABILITY_FLAGS.supportsMidTurnSteer);
});

test("TestREQ_CB_AGY_001_capability_honest_adapter_missing_pillars_degrade_observably", async () => {
  const fixture = loadFixture("tool-invocation");
  const mapper = new AgyEventMapper();
  const normalized = fixture.frames.flatMap((frame) => mapper.mapLine(JSON.stringify(frame)));

  // No reasoning stream and no partial tool input: the tool call arrives whole.
  const kinds = normalized.map((event) => event.kind);
  assert.ok(!kinds.some((kind) => kind.startsWith("reasoning")), "agy has no thinking stream");
  assert.deepEqual(kinds, ["session", "tool-call", "text-delta"]);

  const toolCalls = normalized.filter((event): event is Extract<(typeof normalized)[number], { kind: "tool-call" }> => event.kind === "tool-call");
  assert.equal(toolCalls.length, 1);
  assert.deepEqual(toolCalls[0].input, { CommandLine: "echo hello_headless_demo" }, "the whole parameters block arrives at once");
  assert.equal(toolCalls[0].isError, false);

  // No mid-turn steer: steers queue and drain at the turn boundary.
  const steering = new AgySteeringPolicy();
  steering.beginTurn();
  steering.steer("first correction");
  steering.steer("second correction");
  assert.equal(steering.pendingCount, 2, "mid-turn steers are buffered, never dropped");

  const frames = steering.drainAtBoundary();
  assert.deepEqual(frames, [
    { event: "user", message: { content: "first correction" } },
    { event: "user", message: { content: "second correction" } },
  ]);
  for (const frame of frames) assert.doesNotThrow(() => assertWritableAgyFrame(frame));
  assert.equal(steering.pendingCount, 0);

  // Permission is declarative, not interactive: the default policy allows nothing.
  const permission = new AgyPermissionPolicy({ allowToolNames: ["read"] });
  assert.equal(permission.toolAllowed("read"), true);
  assert.equal(permission.toolAllowed("bash"), false, "a tool absent from the allow rules is denied");
  assert.deepEqual(permission.deriveEnforcement().argvFlags, [], "allow rules alone never widen argv");
});

test("TestREQ_CB_AGY_001_capability_honest_adapter_control_frames_are_never_written", async () => {
  const child = new FakeChild();
  const transport = new AgyTransport({ spawn: () => child });
  const cli = await transport.spawn({ command: AGY_TRANSPORT_DEFAULT_COMMAND, args: [] });

  const steering = new AgySteeringPolicy();
  steering.steer("queued steer");
  const frames = steering.drainAtBoundary();
  for (const frame of frames) await transport.writeFrame(cli, frame);
  assert.equal(child.stdin.writes.length, 1, "a drained steer is the only frame that reaches the child");

  await assert.rejects(
    transport.writeFrame(cli, { event: "control_request", message: { content: "x" } }),
    isBridgeCode("CB_TRANSPORT_FATAL_FRAME"),
  );
  await assert.rejects(
    transport.writeFrame(cli, { event: "user", message: { content: "/model" } }),
    isBridgeCode("CB_TRANSPORT_FATAL_FRAME"),
  );
  assert.equal(child.stdin.writes.length, 1, "a fatal frame must never reach the child");
});

// ---------------------------------------------------------------------------
// 4. Channel contract: verbatim schemas, dry-run default, fail-closed flags.
// ---------------------------------------------------------------------------

const READ_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
};

async function connectClient(channel: AgyToolChannel): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agy-adapter-test", version: "1.0.0" });
  await Promise.all([channel.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("TestREQ_CB_AGY_001_capability_honest_adapter_channel_contract", async () => {
  const channel = new AgyToolChannel({ runnerCommand: ["node", "agy-runner.js"] });
  await channel.registerHostTools([hostTool("read", READ_SCHEMA, async () => ({ content: "body" }))]);

  // Schemas reach the manifest (and the wire) verbatim.
  assert.equal(channel.manifest.tools[0].inputSchema, READ_SCHEMA);
  assert.equal(channel.manifest.tools[0].qualifiedName, qualifiedToolName(AGY_MCP_SERVER_DEFAULT_NAME, "read"));
  assert.equal(channel.manifest.serverName, AGY_MCP_SERVER_DEFAULT_NAME);
  assert.equal(channel.manifest.transport, "stdio");

  // Registration defaults to a dry-run manifest: no user-level config mutation.
  const registration = channel.manifest.registration;
  assert.equal(registration.scope, "user");
  assert.equal(registration.applied, false);
  assert.deepEqual(registration.argv, ["agy", "mcp", "add", "--type", "stdio", "opencode-host", "node", "agy-runner.js"]);

  const client = await connectClient(channel);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), ["read"]);
  assert.deepEqual(listed.tools[0]?.inputSchema, READ_SCHEMA, "the spawned server serves the schema verbatim");
  await client.close();

  // Fail-closed permission flags.
  const permission = new AgyPermissionPolicy();
  assert.equal(permission.supportsInteractiveApproval, false);
  assert.equal(permission.toolAllowed("read"), false, "the default policy allows nothing");
  assert.deepEqual(permission.deriveEnforcement().argvFlags, []);
  assert.equal(AGY_PERMISSION_BYPASS_FLAG, "--dangerously-skip-permissions");
});

// ---------------------------------------------------------------------------
// 5. Runner contract (summary level; full stdio e2e in runner.test.ts).
// ---------------------------------------------------------------------------

test("TestREQ_CB_AGY_001_capability_honest_adapter_runner_loopback_bearer_and_iserror", async (t) => {
  for (const host of ["127.0.0.1", "::1", "localhost"]) assert.equal(isLoopbackHostname(host), true, host);
  for (const host of ["example.com", "10.1.2.3", "0.0.0.0"]) assert.equal(isLoopbackHostname(host), false, host);
  assert.throws(() => resolveRunnerEndpoint(["http://evil.example.com:9000", "tok"]), /non-loopback/);
  assert.throws(() => resolveRunnerEndpoint(["file:///tmp/sock", "tok"]), /http\(s\)/);
  assert.throws(() => resolveRunnerEndpoint([], {}), /requires a bridge url/);
  assert.throws(() => resolveRunnerEndpoint(["http://127.0.0.1:1"], {}), /requires a bridge token/);

  const channel = new AgyToolChannel({
    permission: new AgyPermissionPolicy({ allowToolNames: ["read"] }),
    runnerCommand: ["node", "agy-runner.js"],
  });
  await channel.registerHostTools([
    hostTool("read", READ_SCHEMA, async () => ({ content: "body" })),
    hostTool("bash", READ_SCHEMA, async () => ({ content: "must-not-run" })),
  ]);

  const bridge = await startAgyHostBridge();
  t.after(() => bridge.close());
  await bridge.attach(channel);

  assert.equal(bridge.host, AGY_HOST_BRIDGE_LOOPBACK_HOST, "the bridge must bind loopback only");
  assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+$/);

  const deadline = AbortSignal.timeout(5000);
  const unauthenticated = await fetch(`${bridge.url}/tools/list`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: deadline,
  });
  assert.equal(unauthenticated.status, 401, "a request without the bearer token must be rejected");

  const authorized = await fetch(`${bridge.url}/tools/list`, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.token}` },
    body: "{}",
    signal: deadline,
  });
  assert.equal(authorized.status, 200);

  // Failure surfaces as an isError result, never a hang: a denied tool is denied
  // at the MCP boundary and reported back through the bridge.
  const denied = await fetch(`${bridge.url}/tools/call`, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "bash", arguments: {} }),
    signal: deadline,
  });
  const deniedBody = (await denied.json()) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(deniedBody.isError, true);
  assert.match(deniedBody.content[0]?.text ?? "", /denied/);
});

// ---------------------------------------------------------------------------
// 6. Committed fixtures.
// ---------------------------------------------------------------------------

const REQUIRED_FIXTURES = ["text-turn", "tool-invocation", "multi-turn-resume"];

test("TestREQ_CB_AGY_001_capability_honest_adapter_fixtures_cover_event_classes", () => {
  const names = listFixtures();
  for (const name of REQUIRED_FIXTURES) assert.ok(names.includes(name), `agy fixture "${name}" must be committed`);

  const classes = new Set<string>();
  for (const name of names) {
    const { header, frames } = loadFixture(name);
    assert.ok(header, `agy fixture "${name}" must carry a header`);
    assert.equal(header?.schemaVersion, AGY_STREAM_SCHEMA_VERSION);
    assert.equal(header?.name, name);
    for (const frame of frames) classes.add(String((frame as { event?: unknown }).event));
  }
  for (const required of ["init", "step_update", "result"]) {
    assert.ok(classes.has(required), `committed fixtures must cover the "${required}" event class`);
  }

  assert.throws(
    () => assertFixtureHeader({ fixture: "agy-stream", schemaVersion: 99 }, "future"),
    /schema version 99 is not supported/,
  );
});

test("TestREQ_CB_AGY_001_capability_honest_adapter_fixtures_replay_deterministically", () => {
  for (const name of REQUIRED_FIXTURES) {
    const first = replayFixture(name);
    const second = replayFixture(name);
    assert.deepEqual(second, first, `${name} must replay identically`);
  }
});

test("TestREQ_CB_AGY_001_capability_honest_adapter_multi_turn_fixture_normalizes_usage", () => {
  const { frames } = loadFixture("multi-turn-resume");
  const turns = splitTurns(frames as AgyRawEvent[]);
  assert.equal(turns.length, 2);

  const mapper = new AgyEventMapper();
  const [first, second] = turns.map((events) => mapper.toTurnResult(events));
  assert.deepEqual(first.usage, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.deepEqual(second.usage, { inputTokens: 40, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 0 });
  assert.deepEqual(sumUsage(first.usage, second.usage), mapper.sessionBaseline);
});

function replayFixture(name: string): unknown[] {
  const { frames } = loadFixture(name);
  const mapper = new AgyEventMapper();
  return splitTurns(frames as AgyRawEvent[]).map((events) => mapper.toTurnResult(events));
}

// ---------------------------------------------------------------------------
// 7. Recorder pipeline (hermetic; no live CLI).
// ---------------------------------------------------------------------------

test("TestREQ_CB_AGY_001_capability_honest_adapter_recorder_writes_scrubbed_fixture", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cb-agy-record-"));
  const workdir = join(dir, "workdir");
  const conversation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  async function* fakeSession(): AsyncGenerator<unknown> {
    yield {
      event: "init",
      conversation_id: conversation,
      init: { cwd: workdir, tools: ["run_command"], permission_mode: "request-review" },
    };
    yield {
      event: "step_update",
      step_update: { conversation_id: conversation, step_index: 0, state: "DONE", step_type: "agent_response", text_delta: `wrote ${join(workdir, "file.txt")}` },
    };
    yield {
      event: "result",
      result: { conversation_id: conversation, status: "SUCCESS", response: "ok", usage: { input_tokens: 1, output_tokens: 1 } },
    };
  }

  const recorded = await recordScenario({
    name: "recorded-probe",
    prompt: "probe",
    runSession: fakeSession,
    fixturesDir: dir,
    workdir,
    now: () => "2026-10-09T00:00:00.000Z",
  });

  assert.equal(recorded.count, 3);
  const body = readFileSync(join(dir, "recorded-probe.jsonl"), "utf8");
  const parsed = parseFixtureText(body);
  assert.equal(parsed.header?.schemaVersion, AGY_STREAM_SCHEMA_VERSION);
  assert.equal(parsed.header?.name, "recorded-probe");
  assert.equal(parsed.header?.source, "recorded");
  assert.equal(parsed.header?.recordedAt, "2026-10-09T00:00:00.000Z");

  const initFrame = parsed.frames[0] as { conversation_id: string; init: Record<string, unknown> };
  assert.ok(!("cwd" in initFrame.init), "the absolute cwd must not survive into a committed fixture");
  assert.match(initFrame.conversation_id, /^00000000-0000-4000-8000-\d{12}$/, "conversation ids are scrubbed");
  const text = (parsed.frames[1] as { step_update: { text_delta: string } }).step_update.text_delta;
  assert.ok(!text.includes(workdir), "the scratch path must be scrubbed");
  assert.ok(text.includes("/workdir/file.txt"));

  assert.doesNotThrow(() => assertFixtureHeader(parsed.header, "recorded-probe"));
});

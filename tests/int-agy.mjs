/**
 * End-to-end integration oracle for the agy (Google Antigravity CLI) Wave B
 * adapter (cb-27; spec pins cortex:opencode-cli-enforcer#589/#595/#598/#600;
 * REQ-CB-AGY-001, REQ-CB-DOC-001).
 *
 * Two tiers are selected at load time so the suite is deterministic with or
 * without a working, authenticated agy installation:
 *
 * 1. On-disk tier (always runs): composes the Wave B adapter over the cb-26
 *    committed fixtures, with no real agy child.
 *      (a) a fake spawn serves `tests/fixtures/agy-streams/*.jsonl` frames
 *          through the real cb-21 transport, parsed and folded by the cb-22
 *          mapper into per-turn `TurnResult`s, with cumulative-per-session usage
 *          normalized to turn deltas;
 *      (b) resume end-to-end at the seam: cb-23 planTurn -> resumeArgs ->
 *          cb-21 argv -> cb-25 baseline ledger -> cb-22 resetSession;
 *      (c) a host-tool round trip through the cb-24 channel plus the cb-29
 *          loopback runner (a real stdio MCP child) with verbatim schemas and
 *          fail-closed permission;
 *      (d) the real plugin default export (`src/index.ts`) with agy enabled:
 *          the host-tool loopback wiring starts and `cleanup()` is a re-entrant
 *          zero-leak teardown.
 * 2. Real-CLI tier (`AGY_BRIDGE_INTEGRATION=1` and a discoverable `agy`): the
 *    same transport drives the actual binary for a synthetic probe turn plus a
 *    `--conversation` resume, asserting init/result capture, conversation_id
 *    persistence, and per-turn delta usage. A present-but-unauthenticated binary
 *    skips cleanly with the operator action (the cb-17 skip-guard pattern).
 *
 * `src/` is never modified: an integration failure is the oracle failing, not a
 * patch. Every await is deadline-bounded and no oracle asserts wall-clock order.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const RUNNER_ENTRY = join(ROOT, "src", "agy", "runner.ts");

// ---------------------------------------------------------------------------
// Environment gate: probe agy before any tier decision.
// ---------------------------------------------------------------------------

function commandPath(command) {
  const probe = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout.trim().length > 0 ? probe.stdout.trim() : null;
}

function commandVersion(path) {
  if (path === null) return null;
  const probe = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 10_000 });
  return probe.status === 0 && probe.stdout.trim().length > 0 ? probe.stdout.trim() : null;
}

const AGY_PATH = commandPath("agy");
const AGY_VERSION = commandVersion(AGY_PATH);
const INTEGRATION_ENABLED = process.env.AGY_BRIDGE_INTEGRATION === "1";
const REAL_CLI = INTEGRATION_ENABLED && AGY_PATH !== null;
/** Model slug that exists in the pinned agy catalog (src/agy/probe.ts). */
const REAL_MODEL = "gemini-3.6-flash-low";

const SKIP_REAL = REAL_CLI
  ? false
  : `agy CLI unavailable (AGY_BRIDGE_INTEGRATION=${process.env.AGY_BRIDGE_INTEGRATION ?? "unset"}, ` +
    `agy=${AGY_PATH ?? "absent"}, version=${AGY_VERSION ?? "n/a"}) — operator action: install the agy CLI ` +
    `(cached subscription credentials) and re-run with AGY_BRIDGE_INTEGRATION=1`;

// Dynamic imports (never static) so the gate above runs first.
const { AgyTransport, assertWritableAgyFrame } = await import("../src/agy/transport.ts");
const { AgyEventMapper, parseAgyLine } = await import("../src/agy/event-mapper.ts");
const { AGY_PROVIDER_ID, AgySessionStore } = await import("../src/agy/session-store.ts");
const {
  AGY_MCP_SERVER_DEFAULT_NAME,
  AgyPermissionPolicy,
  AgySteeringPolicy,
  AgyToolChannel,
  qualifiedToolName,
} = await import("../src/agy/channel.ts");
const { startAgyHostBridge } = await import("../src/agy/runner.ts");
const { AgyUsageBaselineLedger, primeAgyResumeBaseline } = await import("../src/agy/probe.ts");
const { loadFixture } = await import("./lib/record-agy-streams.mjs");
const { default: plugin } = await import("../src/index.ts");

const CONVERSATION = "9ec58bfd-4d67-4f5e-83a5-9d907e9c6b1f";
const READ_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Fixture-driven transport harness (fake spawn; never a real process).
// ---------------------------------------------------------------------------

function readableFrom(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function createFakeWritable() {
  return {
    writes: [],
    ended: false,
    write(chunk) {
      this.writes.push(chunk);
      return true;
    },
    end(chunk) {
      if (typeof chunk === "string") this.writes.push(chunk);
      this.ended = true;
      return this;
    },
  };
}

function createFakeChild({ stdoutChunks = [], stderrChunks = [] } = {}) {
  const exitListeners = [];
  const errorListeners = [];
  const child = {
    pid: 4242,
    stdin: createFakeWritable(),
    stdout: readableFrom(stdoutChunks),
    stderr: readableFrom(stderrChunks),
    killed: false,
    once(event, listener) {
      if (event === "exit") exitListeners.push(listener);
      else errorListeners.push(listener);
      return child;
    },
    kill() {
      child.killed = true;
      return true;
    },
  };
  return child;
}

/** Read the terminal `result` frame out of a parsed turn, if one is present. */
function resultFrame(events) {
  return events.find((event) => event.event === "result") ?? null;
}

function splitTurns(frames) {
  const turns = [];
  let current = [];
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

function sumUsage(a, b) {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

async function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`oracle deadline exceeded (${ms}ms): ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Serve one fixture's frames through the real cb-21 transport: build argv, write
 * the single `user` frame, and read back every forwarded NDJSON line.
 */
async function driveFixtureFrames(frames, { model = "gemini-3.8-flash-medium" } = {}) {
  const stdout = frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n";
  const child = createFakeChild({ stdoutChunks: [stdout] });
  const transport = new AgyTransport({ spawn: () => child });
  const cli = await transport.spawn({ command: "agy", args: transport.buildArgv({ model }) });
  await transport.writeFrame(cli, { event: "user", message: { content: "fixture turn" } });

  const raw = [];
  for await (const line of transport.readLines(cli)) raw.push(parseAgyLine(line));
  return { transport, cli, child, raw };
}

// ---------------------------------------------------------------------------
// On-disk tier — fixtures -> provider turn -> TurnResult.
// ---------------------------------------------------------------------------

test("TestREQ_CB_AGY_001_int_agy_fixture_turn_maps_to_turn_result", async () => {
  const { frames } = loadFixture("multi-turn-resume");
  const { transport, cli, child, raw } = await driveFixtureFrames(frames);

  assert.equal(raw.length, frames.length, "the transport forwards every known fixture frame");
  assert.equal(child.stdin.writes.length, 1, "exactly one user frame reaches the child");

  const mapper = new AgyEventMapper();
  const turns = splitTurns(raw).map((events) => mapper.toTurnResult(events));
  assert.equal(turns.length, 2, "the fixture holds two turns of one conversation");

  assert.equal(turns[0].status, "completed");
  assert.equal(turns[0].text, "first answer");
  assert.equal(turns[1].text, "second answer");
  assert.equal(turns[0].sessionId, CONVERSATION);
  assert.equal(turns[1].sessionId, CONVERSATION);

  assert.deepEqual(turns[0].usage, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.deepEqual(
    turns[1].usage,
    { inputTokens: 40, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 0 },
    "turn 2 is a delta against the running session baseline, not the cumulative total",
  );
  assert.deepEqual(
    sumUsage(turns[0].usage, turns[1].usage),
    mapper.sessionBaseline,
    "per-turn deltas sum to the session total exactly once",
  );

  // The stdin hard filter: a control frame or slash command never reaches the child.
  await assert.rejects(
    transport.writeFrame(cli, { event: "control_request", message: { content: "x" } }),
    (error) => error.code === "CB_TRANSPORT_FATAL_FRAME",
  );
  await assert.rejects(
    transport.writeFrame(cli, { event: "user", message: { content: "/model" } }),
    (error) => error.code === "CB_TRANSPORT_FATAL_FRAME",
  );
  assert.equal(child.stdin.writes.length, 1, "a fatal frame is rejected before any byte is written");
});

// ---------------------------------------------------------------------------
// On-disk tier — resume seam: handle capture -> argv -> baseline -> delta.
// ---------------------------------------------------------------------------

test("TestREQ_CB_AGY_001_int_agy_resume_seam_never_double_counts", async () => {
  const store = new AgySessionStore();
  const ledger = new AgyUsageBaselineLedger();

  const { frames } = loadFixture("multi-turn-resume");
  const initFrame = frames.find((frame) => frame.event === "init");

  // The wire discriminator is `event`; the cb-22 mapper owns parsing it, so the
  // integration path derives the opaque handle from the mapper's captured
  // session id rather than re-parsing the raw frame at the seam boundary.
  const sessionEvent = new AgyEventMapper()
    .mapLine(JSON.stringify(initFrame))
    .find((event) => event.kind === "session");
  assert.ok(sessionEvent, "the mapper must surface the init frame as a session event");
  assert.equal(sessionEvent.sessionId, CONVERSATION);
  const handle = { provider: AGY_PROVIDER_ID, conversationRef: sessionEvent.sessionId };

  const serialized = store.serialize(handle);
  assert.deepEqual(store.deserialize(serialized), handle, "the opaque handle round trips through JSON");

  const plan = store.planTurn({ handle });
  assert.equal(plan.transition, "reuse");
  assert.deepEqual(plan.resumeArgs, ["--conversation", CONVERSATION]);

  const argv = new AgyTransport().buildArgv({ model: "gemini-3.8-flash-medium", session: plan.handle ?? undefined });
  const flagIndex = argv.indexOf("--conversation");
  assert.ok(flagIndex >= 0, "the resumed argv must carry --conversation");
  assert.equal(argv[flagIndex + 1], CONVERSATION);

  const firstMapper = new AgyEventMapper();
  const firstTurn = firstMapper.toTurnResult(splitTurns(frames)[0]);
  assert.deepEqual(firstTurn.usage, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
  ledger.record(handle, firstMapper.sessionBaseline);

  const resumedMapper = new AgyEventMapper();
  const seeded = primeAgyResumeBaseline(resumedMapper, handle, ledger.provider());
  assert.equal(seeded.inputTokens, 100, "the ledger seeds the mapper with the last cumulative total");
  const resumedTurn = resumedMapper.toTurnResult(splitTurns(frames)[1]);
  assert.deepEqual(
    resumedTurn.usage,
    { inputTokens: 40, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 0 },
    "a resumed turn reports only its own delta",
  );

  // A host history rewrite degrades to clean-start: no resume flag, empty baseline.
  const stalePlan = store.planTurn({ handle, historyStale: true });
  assert.equal(stalePlan.transition, "clean-start");
  assert.equal(stalePlan.handle, null);
  assert.deepEqual(stalePlan.resumeArgs, []);
  const cleanArgv = new AgyTransport().buildArgv({ model: "m", session: stalePlan.handle ?? undefined });
  assert.ok(!cleanArgv.includes("--conversation"), "a clean-start drops the conversation handle");
});

// ---------------------------------------------------------------------------
// On-disk tier — host-tool round trip: channel + loopback runner (stdio).
// ---------------------------------------------------------------------------

function inheritedEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function hostTool(name, inputSchema, call) {
  return { descriptor: { name, description: `${name} tool`, inputSchema }, call };
}

test(
  "TestREQ_CB_AGY_001_int_agy_host_tool_round_trip_through_loopback_runner",
  { timeout: 30000 },
  async (t) => {
    const channel = new AgyToolChannel({
      permission: new AgyPermissionPolicy({ allowToolNames: ["read"] }),
      runnerCommand: [process.execPath, "--import", "tsx", RUNNER_ENTRY],
    });
    await channel.registerHostTools([
      hostTool("read", READ_SCHEMA, async (input) => ({ content: `read:${input.path}` })),
      hostTool("bash", READ_SCHEMA, async () => ({ content: "must-not-run" })),
    ]);

    const bridge = await startAgyHostBridge();
    t.after(() => bridge.close());
    await bridge.attach(channel);

    assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+$/, "the bridge binds loopback only");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", RUNNER_ENTRY, bridge.url, bridge.token],
      env: inheritedEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "int-agy-runner", version: "1.0.0" });
    t.after(() => client.close());
    await withDeadline(client.connect(transport), 20000, "runner connect");

    const listed = await withDeadline(client.listTools(), 10000, "runner listTools");
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["bash", "read"]);
    const read = listed.tools.find((tool) => tool.name === "read");
    assert.deepEqual(read?.inputSchema, READ_SCHEMA, "the host schema reaches agy verbatim");

    const allowed = await withDeadline(client.callTool({ name: "read", arguments: { path: "a.txt" } }), 10000, "read call");
    assert.ok(!allowed.isError);
    assert.equal(allowed.content[0].text, "read:a.txt");

    const denied = await withDeadline(client.callTool({ name: "bash", arguments: { path: "x" } }), 10000, "denied call");
    assert.equal(denied.isError, true, "a tool outside the declarative allow rules is denied at the MCP boundary");
    assert.match(denied.content[0].text, /denied/);

    assert.equal(channel.manifest.serverName, AGY_MCP_SERVER_DEFAULT_NAME);
    assert.equal(channel.manifest.tools[0].qualifiedName, qualifiedToolName(AGY_MCP_SERVER_DEFAULT_NAME, "read"));
  },
);

// ---------------------------------------------------------------------------
// On-disk tier — real plugin export with agy enabled + zero-leak cleanup.
// ---------------------------------------------------------------------------

function createFakeHost(options = {}) {
  const notifications = [];
  const hooks = [];
  const transforms = [];

  const editor = {
    records: [],
    get(providerID) {
      return this.records.find((record) => record.provider.id === providerID);
    },
    list() {
      return this.records;
    },
    add(input) {
      this.records.push({ provider: input.info, models: input.models });
    },
    update() {},
    remove() {},
    models: { set() {}, update() {}, remove() {} },
  };

  const ctx = {
    options: options.options ?? {},
    location: { directory: ROOT },
    event: {
      subscribe: () => ({ dispose: async () => {} }),
      notify: (message, level) => notifications.push({ message, level }),
    },
    tool: {
      list: async () =>
        options.tools ?? [
          {
            name: "read",
            description: "Read a file.",
            input: READ_SCHEMA,
            execute: async () => ({ content: "host-body" }),
          },
        ],
    },
    provider: {
      transform: async (callback) => {
        transforms.push(callback);
        return { dispose: async () => {} };
      },
    },
    aisdk: {
      hook: async (name, callback, hookOptions) => {
        hooks.push({ name, callback, options: hookOptions });
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async (name, callback, hookOptions) => {
        hooks.push({ name, callback, options: hookOptions });
        return { dispose: async () => {} };
      },
    },
  };

  return {
    ctx,
    editor,
    hooks,
    reload() {
      for (const callback of [...transforms]) callback(editor);
    },
    fire(name, input, providerID) {
      for (const hook of hooks) {
        if (hook.name !== name) continue;
        const scope = hook.options?.providerID;
        if (scope === undefined || scope === providerID) hook.callback(input);
      }
    },
  };
}

const AGY_ENABLED_OPTIONS = {
  providers: {
    agy: {
      enabled: true,
      acknowledgedConstraints: [
        "tos-third-party-access-ambiguity",
        "fatal-control-frames",
        "no-mid-turn-steer",
        "auto-allowed-workspace-writes",
      ],
    },
  },
};

test("TestREQ_CB_AGY_001_int_agy_plugin_export_agy_wiring_and_zero_leak_cleanup", async () => {
  const host = createFakeHost({ options: AGY_ENABLED_OPTIONS });
  const cleanup = await plugin.setup(host.ctx);
  assert.equal(typeof cleanup, "function", "plugin.setup must return a cleanup");

  await host.reload();
  const record = host.editor.get("claude");
  assert.ok(record, "the Wave A provider transform still registers with agy enabled");

  const [model] = record.models;
  const attach = { model, sdk: {}, options: {} };
  host.fire("language", attach, "claude");
  assert.equal(attach.language?.specificationVersion, "v3", "the claude adapter still attaches");

  // Zero-leak teardown, including the agy host-tool loopback wiring started above.
  await assert.doesNotReject(cleanup(), "cleanup must resolve with zero leaks");
  await assert.doesNotReject(cleanup(), "cleanup must be re-entrant");
});

test("TestREQ_CB_CFG_001_int_agy_enabled_without_acknowledgment_fails_closed", async () => {
  const host = createFakeHost({ options: { providers: { agy: { enabled: true } } } });
  await assert.rejects(plugin.setup(host.ctx), /acknowledgedConstraints/);
  assert.equal(host.editor.list().length, 0, "nothing may be registered when the gate rejects");
  assert.equal(host.hooks.length, 0, "no hook may be touched when the gate rejects");
});

// ---------------------------------------------------------------------------
// On-disk tier — steering queues at the turn boundary (never a mid-turn write).
// ---------------------------------------------------------------------------

test("TestREQ_CB_AGY_001_int_agy_steer_queues_to_turn_boundary", async () => {
  const child = createFakeChild();
  const transport = new AgyTransport({ spawn: () => child });
  const cli = await transport.spawn({ command: "agy", args: transport.buildArgv({ model: "m" }) });

  const steering = new AgySteeringPolicy();
  steering.beginTurn();
  steering.steer("first correction");
  steering.steer("second correction");
  assert.equal(steering.pendingCount, 2, "mid-turn steers are buffered, never written into a live turn");
  assert.equal(child.stdin.writes.length, 0);

  steering.endTurn();
  const frames = steering.drainAtBoundary();
  assert.deepEqual(frames, [
    { event: "user", message: { content: "first correction" } },
    { event: "user", message: { content: "second correction" } },
  ]);
  for (const frame of frames) {
    assert.doesNotThrow(() => assertWritableAgyFrame(frame));
    await transport.writeFrame(cli, frame);
  }
  assert.equal(child.stdin.writes.length, 2, "drained steers are the only frames that reach the child");
  assert.equal(steering.pendingCount, 0);
});

// ---------------------------------------------------------------------------
// Real-CLI tier — the actual agy binary (opt-in).
// ---------------------------------------------------------------------------

function authHint(text) {
  return /authenticat|log ?in|sign ?in|oauth|credential|unauthor|api key|subscription/i.test(text);
}

function rawText(events) {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

async function runRealTurn({ transport, prompt, conversationId }) {
  const session = conversationId ? { provider: AGY_PROVIDER_ID, conversationRef: conversationId } : undefined;
  const cli = await transport.spawn({ command: AGY_PATH, args: transport.buildArgv({ model: REAL_MODEL, session }) });
  const raw = [];
  let stderr = "";
  try {
    await transport.writeFrame(cli, { event: "user", message: { content: prompt } });
    for await (const line of transport.readLines(cli)) {
      const event = parseAgyLine(line);
      raw.push(event);
      if (event.event === "result") break;
    }
  } finally {
    cli.kill();
    stderr = await withDeadline(transport.captureStderr(cli), 10000, "capture agy stderr").catch(() => "");
  }
  return { raw, stderr };
}

test(
  "TestREQ_CB_AGY_001_int_agy_real_cli_probe_and_resume",
  { skip: SKIP_REAL, timeout: 240000 },
  async (t) => {
    const transport = new AgyTransport({ printTimeoutMs: 120_000 });
    const store = new AgySessionStore();
    const ledger = new AgyUsageBaselineLedger();

    let first;
    try {
      first = await withDeadline(
        runRealTurn({ transport, prompt: "Reply with exactly: bridge-probe-ok. Nothing else." }),
        150_000,
        "real agy turn 1",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (authHint(message)) {
        t.skip(`agy present but not usable: ${message} — operator action: run 'agy' once to complete OAuth login`);
        return;
      }
      throw error;
    }

    if (resultFrame(first.raw) === null && authHint(`${first.stderr}\n${rawText(first.raw)}`)) {
      t.skip("agy present but not authenticated — operator action: complete agy OAuth login and re-run with AGY_BRIDGE_INTEGRATION=1");
      return;
    }

    const initFrame = first.raw.find((event) => event.event === "init");
    const firstResult = resultFrame(first.raw);
    assert.ok(initFrame, "the real agy stream must open with an init frame");
    assert.ok(firstResult, "the real agy stream must close with a result frame");
    assert.equal(firstResult.result.status, "SUCCESS", "an authenticated probe turn succeeds");

    const firstMapper = new AgyEventMapper();
    const firstTurn = firstMapper.toTurnResult([...first.raw]);
    assert.equal(firstTurn.status, "completed");
    assert.match(firstTurn.text, /bridge-probe-ok/i);
    assert.equal(firstTurn.sessionId, initFrame.conversation_id, "the conversation id is captured from init/result");
    assert.ok(firstTurn.usage.inputTokens > 0, "a real turn reports input usage");
    assert.ok(firstTurn.usage.outputTokens > 0, "a real turn reports output usage");

    const handle = { provider: AGY_PROVIDER_ID, conversationRef: initFrame.conversation_id };
    ledger.record(handle, firstMapper.sessionBaseline);

    const plan = store.planTurn({ handle });
    assert.equal(plan.transition, "reuse");
    const argv = transport.buildArgv({ model: REAL_MODEL, session: plan.handle ?? undefined });
    assert.ok(argv.includes("--conversation"), "the resumed turn passes --conversation");

    const second = await withDeadline(
      runRealTurn({
        transport,
        prompt: "Reply with exactly: bridge-probe-ok. Nothing else.",
        conversationId: initFrame.conversation_id,
      }),
      150_000,
      "real agy turn 2",
    );
    const secondResult = resultFrame(second.raw);
    assert.ok(secondResult, "the resumed turn must close with a result frame");
    assert.equal(
      secondResult.result.conversation_id,
      initFrame.conversation_id,
      "the conversation id persists across the resume",
    );
    assert.ok(
      Number(secondResult.result.num_turns) >= 2,
      "the resumed conversation reports its accumulated turn count",
    );

    const resumedMapper = new AgyEventMapper();
    primeAgyResumeBaseline(resumedMapper, handle, ledger.provider());
    const resumedTurn = resumedMapper.toTurnResult([...second.raw]);
    assert.equal(resumedTurn.status, "completed");
    assert.match(resumedTurn.text, /bridge-probe-ok/i);
    assert.equal(resumedTurn.sessionId, initFrame.conversation_id);

    const cumulative = secondResult.result.usage?.input_tokens ?? 0;
    assert.ok(resumedTurn.usage.inputTokens > 0, "the resumed turn reports its own input delta");
    assert.ok(
      resumedTurn.usage.inputTokens < cumulative,
      "the resumed turn delta is strictly smaller than the cumulative session total (no double counting)",
    );
  },
);

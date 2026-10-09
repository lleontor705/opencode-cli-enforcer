/**
 * End-to-end integration oracle for the claude-bridge plugin (cb-17, spec pins
 * cortex:opencode-cli-enforcer#589/#592/#595/#600; REQ-CB-PROV-002,
 * REQ-CB-TOOL-002/004).
 *
 * Three tiers are selected at load time so the suite is deterministic with or
 * without a Claude Code installation:
 *
 * 1. Wiring tier (always runs): drives the real plugin default export
 *    (`src/index.ts`) through an in-memory host and proves config resolution,
 *    the provider transform, the aisdk language attach, the session-header
 *    hook, the compaction registration, and a re-entrant zero-leak cleanup.
 * 2. Fixture tier (no CLI): the published `@anthropic-ai/claude-agent-sdk`
 *    `query` is replaced with a scripted parked query through `node:module`
 *    `registerHooks`, so the *real* plugin wiring and adapter run `doStream`
 *    over recorded frames from `tests/fixtures/sdk-streams/` (cb-16) with no
 *    child process. This is the tier the "real CLI impractical" case requires.
 * 3. Real-CLI tier (`CLAUDE_BRIDGE_INTEGRATION=1` and a working, authenticated
 *    `claude`): the same objects run against the actual child. Absent the flag
 *    or the binary the tier skips and names the operator action.
 *
 * Every await is deadline-bounded (the cb-14 pattern) and no oracle asserts on
 * wall-clock ordering. `src/` is never modified: an integration failure is the
 * oracle failing, not a patch.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

// ---------------------------------------------------------------------------
// Environment gate: probe before importing anything that pulls in the SDK.
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

const CLAUDE_PATH = commandPath("claude");
const CLAUDE_VERSION = commandVersion(CLAUDE_PATH);
const INTEGRATION_ENABLED = process.env.CLAUDE_BRIDGE_INTEGRATION === "1";
const REAL_CLI = INTEGRATION_ENABLED && CLAUDE_PATH !== null && CLAUDE_VERSION !== null;
const CAN_STUB = typeof registerHooks === "function";

const SKIP_FIXTURE = REAL_CLI
  ? "real claude CLI present; the fixture-stubbed transport tier is superseded by the real-CLI tier"
  : CAN_STUB
    ? false
    : "node:module registerHooks unavailable (needs Node >= 22.15) — cannot stub the SDK; operator action: run on Node >= 22.15 or install the claude CLI";

const SKIP_REAL = REAL_CLI
  ? false
  : `claude CLI unavailable (CLAUDE_BRIDGE_INTEGRATION=${process.env.CLAUDE_BRIDGE_INTEGRATION ?? "unset"}, ` +
    `claude=${CLAUDE_PATH ?? "absent"}, version=${CLAUDE_VERSION ?? "n/a"}) — operator action: install a working, ` +
    `authenticated claude CLI and re-run with CLAUDE_BRIDGE_INTEGRATION=1`;

// ---------------------------------------------------------------------------
// Scripted SDK transport: armed before the first src import so the plugin's
// own `query` binding resolves to the fake. `attachPrompt` drains the parked
// prompt stream so queued acks settle exactly as the SDK's stdin pump would.
// ---------------------------------------------------------------------------

let armedScript = null;
globalThis.__claudeBridgeTestQuery = (params) => {
  if (armedScript === null) throw new Error("claude-bridge test: a query was spawned with no armed script");
  armedScript.attachPrompt(params.prompt);
  return armedScript.handle;
};

if (!REAL_CLI && CAN_STUB) {
  const stubSource =
    "export function query(params) { return globalThis.__claudeBridgeTestQuery(params); }";
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@anthropic-ai/claude-agent-sdk") {
        return { url: `data:text/javascript,${encodeURIComponent(stubSource)}`, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}

// Dynamic imports (never static) so registerHooks is installed first.
const { default: plugin } = await import("../src/index.ts");
const { ToolRendezvous } = await import("../src/mcp/rendezvous.ts");
const { createClaudeBridgeLanguageModelFactory, RendezvousScopes, SESSION_ID_HEADER } = await import(
  "../src/provider/language-model.ts"
);
const { projectClaudeCodeModels } = await import("../src/provider/models.ts");
const { DEFAULT_CONFIG } = await import("../src/config/schema.ts");
const { loadFixture } = await import("./lib/replay.mjs");

assert.equal(SESSION_ID_HEADER, "x-opencode-session");

const TURN_ONE_FRAMES = loadFixture("parallel-tools").frames;
const TURN_TWO_FRAMES = loadFixture("text-turn").frames;

// ---------------------------------------------------------------------------
// Fake in-memory OpenCode host.
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
    location: { directory: options.directory ?? ROOT },
    event: {
      subscribe: () => ({ dispose: async () => {} }),
      notify: (message, level) => notifications.push({ message, level }),
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
    notifications,
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

// ---------------------------------------------------------------------------
// Scripted parked query: yields armed frames, holds otherwise, and reports
// interrupt/close so the adapter and teardown path behave as with a live child.
// ---------------------------------------------------------------------------

function createScriptedQuery() {
  const queue = [];
  let wake = null;
  let closed = false;
  const state = { spawnCount: 0, interrupted: false, closed: false, promptAcks: 0 };

  async function* frames() {
    for (;;) {
      if (queue.length === 0) {
        if (closed) return;
        await new Promise((resolve) => {
          wake = resolve;
        });
        continue;
      }
      yield queue.shift();
    }
  }

  const kick = () => {
    const resume = wake;
    wake = null;
    if (resume !== null) resume();
  };
  const close = () => {
    state.closed = true;
    closed = true;
    kick();
  };

  const handle = frames();
  handle.interrupt = async () => {
    state.interrupted = true;
    close();
  };
  handle.close = close;

  return {
    handle,
    state,
    push(...items) {
      queue.push(...items);
      kick();
    },
    attachPrompt(prompt) {
      state.spawnCount += 1;
      (async () => {
        try {
          for await (const _message of prompt) state.promptAcks += 1;
        } catch {
          // Teardown fails the prompt stream; the drain simply unwinds.
        }
      })();
    },
  };
}

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

function userPrompt(text) {
  return [{ role: "user", content: [{ type: "text", text }] }];
}

function toolResultPrompt(calls, valueOf) {
  return [
    { role: "user", content: [{ type: "text", text: "Continue." }] },
    {
      role: "assistant",
      content: calls.map((call) => ({
        type: "tool-call",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
      })),
    },
    {
      role: "tool",
      content: calls.map((call) => ({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "text", value: valueOf(call) },
      })),
    },
  ];
}

async function collectStream(stream) {
  const reader = stream.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
}

function textOf(parts) {
  return parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("");
}

function finishOf(parts) {
  return parts.find((part) => part.type === "finish");
}

function toolCallsOf(parts) {
  return parts.filter((part) => part.type === "tool-call");
}

/** A missing settle is a fast assertion failure, never a hung run (cb-14). */
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

function authFailure(parts) {
  const error = parts.find((part) => part.type === "error");
  if (!error) return null;
  const message = String(error.error?.message ?? error.error ?? "");
  return /login|log in|authenticat|api key|credential|unauthor|401|403|subscription|oauth/i.test(message)
    ? message
    : null;
}

const HOST_TOOL_PREFIX = "mcp__opencode__";
function resolveToolName(name) {
  return name.startsWith(HOST_TOOL_PREFIX) ? name.slice(HOST_TOOL_PREFIX.length) : name;
}

const READ_TOOL = {
  name: "read",
  description: "Read a file.",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

// ---------------------------------------------------------------------------
// Tier 1 — wiring of the real plugin default export.
// ---------------------------------------------------------------------------

test("TestREQ_CB_PROV_002_int_bridge_plugin_wiring_and_zero_leak_cleanup", async () => {
  const host = createFakeHost();
  const cleanup = await plugin.setup(host.ctx);
  assert.equal(typeof cleanup, "function", "plugin.setup must return a cleanup");

  await host.reload();
  const record = host.editor.get("claude-bridge");
  assert.ok(record, "the provider transform must register the claude-bridge provider");
  assert.equal(record.provider.name, "Claude Code");
  assert.ok(record.models.length >= 1);

  await host.reload();
  await host.reload();
  assert.equal(
    host.editor.list().filter((candidate) => candidate.provider.id === "claude-bridge").length,
    1,
    "the provider transform must stay idempotent across re-entrant reloads",
  );

  const [model] = record.models;
  assert.ok(model);
  const attach = { model, sdk: {}, options: {} };
  host.fire("language", attach, "claude-bridge");
  assert.ok(attach.language, "a claude-bridge request must receive the custom adapter");
  assert.equal(attach.language.provider, "claude-bridge");
  assert.equal(attach.language.specificationVersion, "v3");
  assert.equal(typeof attach.language.doStream, "function");

  const foreign = { model, sdk: {}, options: {} };
  host.fire("language", foreign, "anthropic");
  assert.equal(foreign.language, undefined, "a foreign provider id must never receive the adapter");

  const request = { sessionID: "ses-int-wiring", agent: "build", model, kind: "primary", headers: {} };
  host.fire("model.request", request, "claude-bridge");
  assert.equal(
    request.headers[SESSION_ID_HEADER],
    "ses-int-wiring",
    "the session id must be pinned onto the request headers",
  );

  assert.ok(
    host.hooks.some((hook) => hook.name === "compaction"),
    "the compaction hook must be registered",
  );

  await assert.doesNotReject(cleanup(), "cleanup must resolve with zero leaks");
  await assert.doesNotReject(cleanup(), "cleanup must be re-entrant");
});

test("TestREQ_CB_CFG_001_int_bridge_invalid_options_fail_before_any_registration", async () => {
  const host = createFakeHost({ options: { providers: { claude: { enabled: "yes" } } } });
  await assert.rejects(plugin.setup(host.ctx), /providers\.claude\.enabled/);
  assert.equal(host.editor.list().length, 0, "nothing may be registered when config resolution throws");
  assert.equal(host.hooks.length, 0, "no hook may be touched when config resolution throws");
});

// ---------------------------------------------------------------------------
// Tier 2 — fixture-driven multi-turn + tool round trip.
// ---------------------------------------------------------------------------

test(
  "TestREQ_CB_TOOL_002_int_bridge_plugin_export_multi_turn_tool_round_trip",
  { skip: SKIP_FIXTURE },
  async () => {
    const script = createScriptedQuery();
    armedScript = script;
    const host = createFakeHost();
    const cleanup = await plugin.setup(host.ctx);
    await host.reload();

    const [model] = host.editor.get("claude-bridge").models;
    const attach = { model, sdk: {}, options: {} };
    host.fire("language", attach, "claude-bridge");
    const language = attach.language;
    const headers = { [SESSION_ID_HEADER]: "ses-int-fixture" };

    const turn1 = await language.doStream({
      prompt: userPrompt("Read a.txt and b.txt, then answer."),
      headers,
    });
    script.push(...TURN_ONE_FRAMES);
    const parts1 = await withDeadline(collectStream(turn1.stream), 5_000, "fixture turn 1");

    const calls = toolCallsOf(parts1);
    assert.deepEqual(calls.map((call) => call.toolName), ["read", "read"]);
    assert.deepEqual(calls.map((call) => call.toolCallId), ["toolu_alpha", "toolu_beta"]);
    assert.equal(finishOf(parts1)?.finishReason.unified, "tool-calls");
    assert.equal(script.state.spawnCount, 1, "the parked query must be spawned exactly once");

    // The host executes the tools and returns results on the next prompt; the
    // adapter must deliver them into the *parked* query, not respawn.
    const turn2 = await language.doStream({
      prompt: toolResultPrompt(calls, (call) =>
        call.toolCallId === "toolu_alpha" ? "A" : "B",
      ),
      headers,
    });
    script.push(...TURN_TWO_FRAMES);
    const parts2 = await withDeadline(collectStream(turn2.stream), 5_000, "fixture turn 2");

    assert.equal(finishOf(parts2)?.finishReason.unified, "stop");
    assert.equal(textOf(parts2), "Hello world");
    assert.equal(script.state.spawnCount, 1, "delivery must not respawn the query");

    await assert.doesNotReject(cleanup(), "cleanup after a tool round trip must leave zero leaks");
  },
);

test(
  "TestREQ_CB_TOOL_004_int_bridge_tool_result_delivery_resolves_the_parked_handler",
  { skip: SKIP_FIXTURE },
  async () => {
    const script = createScriptedQuery();
    armedScript = script;
    const rendezvous = new ToolRendezvous();
    const scopes = new RendezvousScopes();
    const [model] = projectClaudeCodeModels();

    const language = createClaudeBridgeLanguageModelFactory({
      rendezvousScopes: scopes,
      resolveToolName,
      hostTools: [READ_TOOL],
      childEnv: DEFAULT_CONFIG.childEnv,
      cwd: ROOT,
    })(model);
    const headers = { [SESSION_ID_HEADER]: "ses-int-round-trip" };
    const scope = scopes.get("ses-int-round-trip");

    const turn1 = await language.doStream({ prompt: userPrompt("read"), headers });
    script.push(...TURN_ONE_FRAMES);
    const parts1 = await withDeadline(collectStream(turn1.stream), 5_000, "round-trip turn 1");
    const calls = toolCallsOf(parts1);
    assert.equal(calls.length, 2);

    // The in-process MCP server would park each tools/call here.
    const parkedAlpha = scope.awaitToolResult("toolu_alpha", "read");
    const parkedBeta = scope.awaitToolResult("toolu_beta", "read");

    const turn2 = await language.doStream({
      prompt: toolResultPrompt(calls, (call) =>
        call.toolCallId === "toolu_alpha" ? "ALPHA-CONTENT" : "BETA-CONTENT",
      ),
      headers,
    });
    script.push(...TURN_TWO_FRAMES);
    await withDeadline(collectStream(turn2.stream), 5_000, "round-trip turn 2");

    const [alpha, beta] = await withDeadline(
      Promise.all([parkedAlpha, parkedBeta]),
      5_000,
      "parked handlers settle",
    );
    assert.equal(alpha.content[0].text, "ALPHA-CONTENT");
    assert.equal(beta.content[0].text, "BETA-CONTENT");
    assert.equal(scope.pendingToolCallCount, 0);
    assert.equal(scope.pendingResultCount, 0);
  },
);

// ---------------------------------------------------------------------------
// Tier 3 — real claude CLI.
// ---------------------------------------------------------------------------

test(
  "TestREQ_CB_PROV_002_int_bridge_real_cli_single_and_multi_turn",
  { skip: SKIP_REAL },
  async (t) => {
    const host = createFakeHost();
    const cleanup = await plugin.setup(host.ctx);
    await host.reload();

    const [model] = host.editor.get("claude-bridge").models;
    const attach = { model, sdk: {}, options: {} };
    host.fire("language", attach, "claude-bridge");
    const language = attach.language;
    const headers = { [SESSION_ID_HEADER]: "ses-int-real-smoke" };

    const first = await language.doStream({
      prompt: userPrompt("Reply with exactly the word ALPHA and nothing else."),
      headers,
    });
    const parts1 = await withDeadline(collectStream(first.stream), 120_000, "real CLI turn 1");
    const unauthenticated = authFailure(parts1);
    if (unauthenticated !== null) {
      await cleanup();
      t.skip(`claude CLI present but not usable: ${unauthenticated}`);
      return;
    }
    assert.equal(finishOf(parts1)?.finishReason.unified, "stop");
    assert.match(textOf(parts1), /ALPHA/i);

    const second = await language.doStream({
      prompt: [
        { role: "user", content: [{ type: "text", text: "Reply with exactly the word ALPHA and nothing else." }] },
        { role: "assistant", content: [{ type: "text", text: textOf(parts1) }] },
        { role: "user", content: [{ type: "text", text: "Now reply with exactly the word BETA and nothing else." }] },
      ],
      headers,
    });
    const parts2 = await withDeadline(collectStream(second.stream), 120_000, "real CLI turn 2");
    assert.equal(finishOf(parts2)?.finishReason.unified, "stop");
    assert.match(textOf(parts2), /BETA/i);

    await assert.doesNotReject(cleanup());
  },
);

test(
  "TestREQ_CB_TOOL_004_int_bridge_real_cli_tool_round_trip",
  { skip: SKIP_REAL },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "cb-int-tool-"));
    const controller = new AbortController();
    try {
      const scratch = join(dir, "scratch.txt");
      writeFileSync(scratch, "SCRATCH-CONTENT\n");

      const rendezvous = new ToolRendezvous();
      const [model] = projectClaudeCodeModels();
      const language = createClaudeBridgeLanguageModelFactory({
        rendezvous,
        resolveToolName,
        hostTools: [READ_TOOL],
        childEnv: DEFAULT_CONFIG.childEnv,
        cwd: dir,
      })(model);

      const first = await language.doStream({
        prompt: userPrompt(`Use the read tool to read ${scratch}, then reply with its exact contents.`),
        abortSignal: controller.signal,
      });
      const parts1 = await withDeadline(collectStream(first.stream), 120_000, "real tool turn 1");
      const unauthenticated = authFailure(parts1);
      if (unauthenticated !== null) {
        t.skip(`claude CLI present but not usable: ${unauthenticated}`);
        return;
      }
      const calls = toolCallsOf(parts1).filter((call) => call.toolName === "read");
      assert.ok(calls.length >= 1, "the model must call the served read tool");

      const second = await language.doStream({
        prompt: toolResultPrompt(calls, () => "SCRATCH-CONTENT"),
        abortSignal: controller.signal,
      });
      const parts2 = await withDeadline(collectStream(second.stream), 120_000, "real tool turn 2");
      assert.match(textOf(parts2), /SCRATCH-CONTENT/);
    } finally {
      controller.abort();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

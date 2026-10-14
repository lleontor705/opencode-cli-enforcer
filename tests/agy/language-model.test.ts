/**
 * agy (Google Antigravity CLI) LanguageModelV3 adapter oracles (cb-38/cb-39;
 * REQ-CB-AGY-001, REQ-CB-PROV-002, REQ-CB-ERR-001; closes the agy adapter-review
 * W1/W2 gaps and the cb-38 empty-stream follow-up).
 *
 * The adapter is driven through the real cb-21 transport over a scripted child,
 * so every oracle exercises the shipped chain — argv construction, the stdin
 * hard filter, the forward-compatibility line filter, the cb-22 mapper and the
 * cb-25 usage ledger — with no real process and no wall-clock ordering.
 *
 *  1. parts in order: the cb-26 `text-turn` fixture renders
 *     `stream-start` -> text block -> `finish`, with the mapper's per-turn delta
 *     usage on the finish frame and the prompt delivered as one `user` frame.
 *  2. step granularity: the `tool-invocation` fixture yields a whole `tool-call`
 *     (never `tool-input-*`) marked `providerExecuted`, because agy runs tools
 *     itself through its MCP client.
 *  3. abort: an `abortSignal` mid-stream kills the child and ends the step with
 *     an `error` part — never a hang.
 *  4. resume: the conversation id captured from turn one comes back as
 *     `--conversation` on turn two, whose finish reports its own delta rather
 *     than the cumulative session total.
 *  5. dead child: a child that exits without emitting a single frame — exit 2, an
 *     auth-shaped stderr, or a transport blip — ends the stream with exactly one
 *     classified `error` part, never an empty silent stream.
 *  6. failed result: a `result` frame carrying a non-completed status drops the
 *     handle, so the next turn clean-starts with no `--conversation`.
 *  7. fail-loud: an adapter without its transport binding rejects on first use
 *     instead of emitting an empty stream.
 *  8. registration: the agy catalog + `language` hook bind through the guarded
 *     cb-05 seams (idempotent editor, providerID-scoped hook), so non-agy models
 *     are never touched.
 *  9. plugin entry wiring: agy enabled registers the catalog + hook and cleanup
 *     is clean.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { AgyChildProcessLike, AgyReadableLike } from "../../src/agy/transport.ts";
import { AgyTransport } from "../../src/agy/transport.ts";
import { AgySessionStore } from "../../src/agy/session-store.ts";
import {
  AGY_MODEL_SLUGS,
  AGY_PROVIDER_ID,
  AgyUsageBaselineLedger,
  createAgyProviderCatalog,
  projectAgyModels,
} from "../../src/agy/probe.ts";
import {
  AGY_LANGUAGE_MODEL_UNBOUND_CODE,
  createAgyLanguageModel,
  createAgyLanguageModelFactory,
} from "../../src/agy/language-model.ts";
import { bindLanguageModel, bindProviderEditor } from "../../src/provider/registration.ts";
import { loadFixture } from "../lib/record-agy-streams.mjs";

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

interface FakeChildOptions {
  /** stderr text, delivered as one chunk; omitted means no stderr pipe. */
  readonly stderr?: string;
  /** Exit code of a child that is already dead when it is spawned. */
  readonly exitCode?: number;
}

class FakeChild implements AgyChildProcessLike {
  readonly pid = 4242;
  readonly stdin = new FakeWritable();
  readonly stdout: AgyReadableLike | null;
  readonly stderr: AgyReadableLike | null;
  killed = false;

  private readonly deadExitCode: number | undefined;

  constructor(stdout: AgyReadableLike | null, options: FakeChildOptions = {}) {
    this.stdout = stdout;
    this.stderr = options.stderr === undefined ? null : readableFrom([options.stderr]);
    this.deadExitCode = options.exitCode;
  }

  /**
   * A child scripted with an exit code is dead on arrival, so `exitCode()`
   * resolves as soon as the transport subscribes. Without one the child stays
   * alive, which is what the stalling abort oracle needs.
   */
  once(event: "exit" | "error", listener: (...args: never[]) => void): unknown {
    if (event === "exit" && this.deadExitCode !== undefined) {
      (listener as (code: number | null) => void)(this.deadExitCode);
    }
    return this;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

/** Child that streams `lines`, then stalls until killed (for the abort oracle). */
function stallingChild(lines: readonly string[]): FakeChild {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stdout: AgyReadableLike = {
    async *[Symbol.asyncIterator]() {
      for (const line of lines) yield line;
      await gate;
    },
  };
  const child = new FakeChild(stdout);
  const originalKill = child.kill.bind(child);
  child.kill = () => {
    release();
    return originalKill();
  };
  return child;
}

interface ScriptedSpawn {
  readonly input: { readonly command: string; readonly args: readonly string[] };
  readonly child: FakeChild;
}

/** Transport whose injected spawner returns one scripted child per turn. */
function scriptedTransport(scripts: readonly (readonly string[])[]): {
  transport: AgyTransport;
  spawned: ScriptedSpawn[];
} {
  const spawned: ScriptedSpawn[] = [];
  let index = 0;
  const transport = new AgyTransport({
    spawn: (input) => {
      const chunk = (scripts[index] ?? []).map((line) => `${line}\n`);
      index += 1;
      const child = new FakeChild(readableFrom(chunk));
      spawned.push({ input, child });
      return child;
    },
  });
  return { transport, spawned };
}

interface DeadChildSpec {
  readonly exitCode: number;
  /** stderr the dead child leaves behind; omitted means no stderr pipe. */
  readonly stderr?: string;
}

/**
 * Transport whose injected spawner returns a child that emits no stdout at all
 * and is already dead: unauthenticated agy, an expired token, or a fatal frame.
 */
function deadChildTransport(turns: readonly DeadChildSpec[]): {
  transport: AgyTransport;
  spawned: ScriptedSpawn[];
} {
  const spawned: ScriptedSpawn[] = [];
  let index = 0;
  const transport = new AgyTransport({
    spawn: (input) => {
      const spec = turns[index] ?? { exitCode: 0 };
      index += 1;
      const child = new FakeChild(readableFrom([]), {
        exitCode: spec.exitCode,
        ...(spec.stderr !== undefined ? { stderr: spec.stderr } : {}),
      });
      spawned.push({ input, child });
      return child;
    },
  });
  return { transport, spawned };
}

function fixtureLines(name: string): string[] {
  const { frames } = loadFixture(name);
  return frames.map((frame: unknown) => JSON.stringify(frame));
}

/** Split flat fixture frames into turns at each terminal `result` frame. */
function splitTurns(name: string): string[][] {
  const { frames } = loadFixture(name);
  const turns: unknown[][] = [];
  let current: unknown[] = [];
  for (const frame of frames) {
    current.push(frame);
    if ((frame as { event?: string }).event === "result") {
      turns.push(current);
      current = [];
    }
  }
  if (current.length > 0) turns.push(current);
  return turns.map((turn) => turn.map((frame) => JSON.stringify(frame)));
}

const MODEL = projectAgyModels()[0];

function buildConfig(transport: AgyTransport, baselines = new AgyUsageBaselineLedger()) {
  return {
    transport,
    sessions: new AgySessionStore(),
    usageBaselines: baselines,
    command: "agy",
  };
}

async function collect(stream: ReadableStream<{ type: string }>): Promise<Array<Record<string, unknown>>> {
  const reader = stream.getReader();
  const parts: Array<Record<string, unknown>> = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value as Record<string, unknown>);
  }
  return parts;
}

function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms);
      timer.unref?.();
    }),
  ]);
}

const USER_PROMPT = {
  prompt: [{ role: "user", content: [{ type: "text", text: "say hello" }] }],
};

// ---------------------------------------------------------------------------
// 1. Parts in order, delta usage on finish.
// ---------------------------------------------------------------------------

test("TestREQ_CB_AGY_001_language_model_streams_fixture_turn_as_lmv3_parts", async () => {
  const { transport, spawned } = scriptedTransport([fixtureLines("text-turn")]);
  const baselines = new AgyUsageBaselineLedger();
  const model = createAgyLanguageModel(MODEL, buildConfig(transport, baselines));

  const { stream } = await model.doStream(USER_PROMPT);
  const parts = await collect(stream);

  assert.deepEqual(
    parts.map((part) => part.type),
    ["stream-start", "text-start", "text-delta", "text-delta", "text-end", "finish"],
  );

  const deltas = parts.filter((part) => part.type === "text-delta");
  assert.deepEqual(deltas.map((part) => part.delta), ["Hello", " world"]);
  assert.equal(deltas[0].id, deltas[1].id, "deltas of one agy step block share their text id");

  const finish = parts[parts.length - 1];
  assert.deepEqual(finish.finishReason, { unified: "stop", raw: "SUCCESS" });
  assert.deepEqual(finish.usage, {
    inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 12, text: 12, reasoning: undefined },
  });

  // Capability honesty: no reasoning stream, no partial tool input.
  const types = parts.map((part) => part.type);
  assert.ok(!types.some((type) => String(type).startsWith("reasoning")), "agy has no thinking stream");
  assert.ok(
    !types.some((type) => String(type).startsWith("tool-input")),
    "agy never streams partial tool input",
  );

  // The prompt went out as exactly one writable `user` frame, with the model slug on argv.
  assert.equal(spawned.length, 1);
  const written = spawned[0].child.stdin.writes;
  assert.equal(written.length, 1);
  assert.deepEqual(JSON.parse(written[0]), { event: "user", message: { content: "say hello" } });
  const argv = spawned[0].input.args;
  assert.ok(argv.includes("--model"), "the model slug must be pinned on argv");
  assert.equal(argv[argv.indexOf("--model") + 1], MODEL.id);
  assert.ok(!argv.includes("--conversation"), "a fresh conversation must not carry a resume flag");
});

// ---------------------------------------------------------------------------
// 2. Step granularity: whole tool call, provider-executed.
// ---------------------------------------------------------------------------

test("TestREQ_CB_AGY_001_language_model_emits_whole_tool_call_at_step_granularity", async () => {
  const { transport } = scriptedTransport([fixtureLines("tool-invocation")]);
  const model = createAgyLanguageModel(MODEL, buildConfig(transport));

  const { stream } = await model.doStream(USER_PROMPT);
  const parts = await collect(stream);

  const toolCalls = parts.filter((part) => part.type === "tool-call");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].toolName, "run_command");
  assert.equal(toolCalls[0].providerExecuted, true, "agy runs the tool itself; the host must not re-dispatch");
  assert.deepEqual(JSON.parse(String(toolCalls[0].input)), { CommandLine: "echo hello_headless_demo" });

  assert.deepEqual(
    parts.map((part) => part.type),
    ["stream-start", "tool-call", "text-start", "text-delta", "text-end", "finish"],
  );
});

// ---------------------------------------------------------------------------
// 3. Abort mid-stream kills the child and ends with an error part.
// ---------------------------------------------------------------------------

test("TestREQ_CB_AGY_001_language_model_abort_mid_stream_kills_child_and_errors", async () => {
  const lines = fixtureLines("text-turn").slice(0, 4);
  const child = stallingChild(lines.map((line) => `${line}\n`));
  const transport = new AgyTransport({ spawn: () => child });
  const model = createAgyLanguageModel(MODEL, buildConfig(transport));

  const controller = new AbortController();
  const { stream } = await model.doStream({ ...USER_PROMPT, abortSignal: controller.signal });
  const reader = stream.getReader();

  const seen: Array<Record<string, unknown>> = [];
  for (;;) {
    const { done, value } = await reader.read();
    assert.equal(done, false, "the stream must not end before the abort");
    seen.push(value as Record<string, unknown>);
    if ((value as { type: string }).type === "text-delta") break;
  }

  controller.abort();

  await withDeadline(
    (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        seen.push(value as Record<string, unknown>);
      }
    })(),
    2_000,
    "aborted agy stream",
  );

  const last = seen[seen.length - 1];
  assert.equal(last.type, "error");
  assert.equal((last.error as { code: string }).code, "CB_STREAM_ABORTED");
  assert.ok(!seen.some((part) => part.type === "finish"), "an aborted turn emits no finish frame");
  assert.equal(child.killed, true, "abort must kill the agy child");
});

// ---------------------------------------------------------------------------
// 4. Resume across turns: --conversation argv + delta usage, never double-counted.
// ---------------------------------------------------------------------------

test("TestREQ_CB_AGY_001_language_model_resumes_conversation_with_delta_usage", async () => {
  const turns = splitTurns("multi-turn-resume");
  assert.equal(turns.length, 2);
  const { transport, spawned } = scriptedTransport(turns);
  const baselines = new AgyUsageBaselineLedger();
  const model = createAgyLanguageModel(MODEL, buildConfig(transport, baselines));

  const first = await collect((await model.doStream(USER_PROMPT)).stream);
  const firstFinish = first[first.length - 1];
  assert.deepEqual(firstFinish.usage, {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 20, text: 20, reasoning: undefined },
  });

  const second = await collect((await model.doStream(USER_PROMPT)).stream);
  const secondFinish = second[second.length - 1];
  assert.deepEqual(
    secondFinish.usage,
    {
      inputTokens: { total: 140, noCache: 40, cacheRead: 100, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: undefined },
    },
    "the resumed turn reports its own delta, not the cumulative session total",
  );

  const conversation = "9ec58bfd-4d67-4f5e-83a5-9d907e9c6b1f";
  const secondArgv = spawned[1].input.args;
  const flagIndex = secondArgv.indexOf("--conversation");
  assert.ok(flagIndex >= 0, "the resumed turn must pass --conversation");
  assert.equal(secondArgv[flagIndex + 1], conversation);
  assert.ok(!spawned[0].input.args.includes("--conversation"), "turn one starts a fresh conversation");
});

// ---------------------------------------------------------------------------
// 5. Dead child: no stdout frame at all is still a classified failure.
// ---------------------------------------------------------------------------

test("TestREQ_CB_ERR_001_language_model_dead_child_auth_stderr_errors_without_hanging", async () => {
  const { transport, spawned } = deadChildTransport([
    { exitCode: 1, stderr: "agy: authentication required; run `agy login` and retry.\n" },
  ]);
  const model = createAgyLanguageModel(MODEL, buildConfig(transport));

  const { stream } = await model.doStream(USER_PROMPT);
  const parts = await withDeadline(collect(stream), 2_000, "dead-child agy stream");

  assert.deepEqual(
    parts.map((part) => part.type),
    ["stream-start", "error"],
    "a frame-less child must end with exactly one error part, never an empty stream",
  );
  const error = parts[1].error as { category: string; code: string; message: string; retryable: boolean };
  assert.equal(error.category, "transport");
  assert.match(error.message, /agy authentication required/);
  assert.equal(error.retryable, false, "a retry cannot mint credentials");

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].child.killed, true, "a settled turn still reaps its child");
});

test("TestREQ_CB_ERR_001_language_model_dead_child_exit_2_reports_fatal_frame", async () => {
  const { transport } = deadChildTransport([{ exitCode: 2 }]);
  const model = createAgyLanguageModel(MODEL, buildConfig(transport));

  const parts = await withDeadline(
    collect((await model.doStream(USER_PROMPT)).stream),
    2_000,
    "fatal-frame agy stream",
  );

  assert.deepEqual(parts.map((part) => part.type), ["stream-start", "error"]);
  const error = parts[1].error as { category: string; code: string; message: string };
  assert.equal(error.category, "transport");
  assert.equal(error.code, "CB_TRANSPORT_FATAL_FRAME");
  assert.match(error.message, /exited 2 with no stream frame/);
});

test("TestREQ_CB_ERR_001_language_model_dead_child_keeps_cb21_transient_classification", async () => {
  const { transport } = deadChildTransport([{ exitCode: 1, stderr: "Error: read ECONNRESET\n" }]);
  const model = createAgyLanguageModel(MODEL, buildConfig(transport));

  const parts = await withDeadline(
    collect((await model.doStream(USER_PROMPT)).stream),
    2_000,
    "transient dead-child agy stream",
  );

  const error = parts[parts.length - 1].error as { code: string; message: string; retryable: boolean };
  assert.equal(error.code, "CB_TRANSPORT_TRANSIENT", "a blip keeps the cb-21 exit map's classification");
  assert.equal(error.retryable, true);
  assert.match(error.message, /ECONNRESET/);
});

// ---------------------------------------------------------------------------
// 6. A failed result frame drops the handle: the next turn clean-starts.
// ---------------------------------------------------------------------------

/** The multi-turn fixture's first turn with its terminal `result` forced to ERROR. */
function failedResultTurn(): string[] {
  return splitTurns("multi-turn-resume")[0].map((line) => {
    const frame = JSON.parse(line) as { event?: string; result?: Record<string, unknown> };
    if (frame.event !== "result") return line;
    return JSON.stringify({
      ...frame,
      result: { ...frame.result, status: "ERROR", error: "upstream model error" },
    });
  });
}

test("TestREQ_CB_ERR_001_language_model_failed_result_drops_handle_for_clean_start", async () => {
  const [resumedTurn] = splitTurns("multi-turn-resume").slice(1);
  const { transport, spawned } = scriptedTransport([failedResultTurn(), resumedTurn]);
  const baselines = new AgyUsageBaselineLedger();
  const model = createAgyLanguageModel(MODEL, buildConfig(transport, baselines));

  const first = await collect((await model.doStream(USER_PROMPT)).stream);
  assert.equal(first[first.length - 1].type, "error");
  assert.ok(!first.some((part) => part.type === "finish"), "a failed result is terminal for its turn");

  const second = await collect((await model.doStream(USER_PROMPT)).stream);
  assert.ok(
    !spawned[1].input.args.includes("--conversation"),
    "a failed turn's conversation must not be resumed (cb-23 clean-start)",
  );
  assert.deepEqual(
    second[second.length - 1].usage,
    {
      inputTokens: { total: 240, noCache: 140, cacheRead: 100, cacheWrite: 0 },
      outputTokens: { total: 30, text: 30, reasoning: undefined },
    },
    "a clean-started turn measures its own cumulative, not a delta against the dropped handle",
  );
});

// ---------------------------------------------------------------------------
// 7. Fail-loud without a transport binding.
// ---------------------------------------------------------------------------

test("TestREQ_CB_AGY_001_language_model_unbound_fails_loud", async () => {
  const model = createAgyLanguageModel(MODEL, {});
  await assert.rejects(
    model.doStream(USER_PROMPT),
    new RegExp(AGY_LANGUAGE_MODEL_UNBOUND_CODE),
    "an unbound adapter must reject instead of emitting an empty stream",
  );
});

// ---------------------------------------------------------------------------
// 8. Registration: idempotent, agy-scoped, non-agy models untouched.
// ---------------------------------------------------------------------------

function createRegistrationHost() {
  const transforms: Array<(editor: unknown) => void> = [];
  const hooks: Array<{ name: string; callback: (input: unknown) => void; options?: { providerID?: string } }> = [];

  const editor = {
    records: [] as Array<{ provider: { id: string }; models: readonly unknown[] }>,
    get(providerID: string) {
      return this.records.find((record) => record.provider.id === providerID);
    },
    add(input: { info: { id: string }; models: readonly unknown[] }) {
      this.records.push({ provider: input.info, models: input.models });
    },
  };

  const ctx = {
    provider: {
      transform: async (callback: (editor: unknown) => void) => {
        transforms.push(callback);
        return { dispose: async () => {} };
      },
    },
    aisdk: {
      hook: async (
        name: string,
        callback: (input: unknown) => void,
        options?: { providerID?: string },
      ) => {
        hooks.push({ name, callback, options });
        return { dispose: async () => {} };
      },
    },
  };

  return {
    ctx,
    editor,
    reload() {
      for (const callback of [...transforms]) callback(editor);
    },
    fire(name: string, input: unknown, providerID: string) {
      for (const hook of hooks) {
        if (hook.name !== name) continue;
        const scope = hook.options?.providerID;
        if (scope === undefined || scope === providerID) hook.callback(input);
      }
    },
  };
}

test("TestREQ_CB_AGY_001_language_model_registration_is_idempotent_and_agy_scoped", async () => {
  const host = createRegistrationHost();
  const factory = createAgyLanguageModelFactory(buildConfig(new AgyTransport()));
  const catalog = createAgyProviderCatalog(factory);

  assert.equal(catalog.providerId, AGY_PROVIDER_ID);
  assert.equal(catalog.models.length, AGY_MODEL_SLUGS.length, "the full pinned agy catalog must register");

  await bindProviderEditor(host.ctx as never, catalog);
  await bindLanguageModel(host.ctx as never, catalog);

  host.reload();
  host.reload();
  assert.equal(
    host.editor.records.filter((record) => record.provider.id === AGY_PROVIDER_ID).length,
    1,
    "a hot-reload must not stack a second agy provider record",
  );
  assert.equal(host.editor.records.length, 1, "the agy transform registers only its own provider");

  const agyModel = projectAgyModels()[0];
  const attach: Record<string, unknown> = { model: agyModel, sdk: {}, options: {} };
  host.fire("language", attach, AGY_PROVIDER_ID);
  const language = attach.language as { provider: string; specificationVersion: string; modelId: string };
  assert.equal(language.provider, AGY_PROVIDER_ID);
  assert.equal(language.specificationVersion, "v3");
  assert.equal(language.modelId, agyModel.id);

  const claudeAttach: Record<string, unknown> = { model: { id: "claude-opus-4-7" }, sdk: {}, options: {} };
  host.fire("language", claudeAttach, "claude-bridge");
  assert.equal(claudeAttach.language, undefined, "the agy hook must not touch a non-agy model");
});

// ---------------------------------------------------------------------------
// 9. Plugin entry wiring: agy enabled registers catalog + hook; cleanup is clean.
// ---------------------------------------------------------------------------

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

function createPluginHost(options: Record<string, unknown>) {
  const notifications: unknown[] = [];
  const hooks: Array<{ name: string; callback: (input: unknown) => void; options?: { providerID?: string } }> = [];
  const transforms: Array<(editor: unknown) => void> = [];

  const editor = {
    records: [] as Array<{ provider: { id: string }; models: readonly unknown[] }>,
    get(providerID: string) {
      return this.records.find((record) => record.provider.id === providerID);
    },
    list() {
      return this.records;
    },
    add(input: { info: { id: string }; models: readonly unknown[] }) {
      this.records.push({ provider: input.info, models: input.models });
    },
    update() {},
    remove() {},
    models: { set() {}, update() {}, remove() {} },
  };

  const ctx = {
    options,
    location: { directory: process.cwd() },
    event: {
      subscribe: () => ({ dispose: async () => {} }),
      notify: (message: string, level: string) => notifications.push({ message, level }),
    },
    tool: {
      list: async () => [
        { name: "read", description: "Read a file.", input: { type: "object" }, execute: async () => ({ content: "body" }) },
      ],
    },
    provider: {
      transform: async (callback: (editor: unknown) => void) => {
        transforms.push(callback);
        return { dispose: async () => {} };
      },
    },
    aisdk: {
      hook: async (
        name: string,
        callback: (input: unknown) => void,
        hookOptions?: { providerID?: string },
      ) => {
        hooks.push({ name, callback, options: hookOptions });
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async (
        name: string,
        callback: (input: unknown) => void,
        hookOptions?: { providerID?: string },
      ) => {
        hooks.push({ name, callback, options: hookOptions });
        return { dispose: async () => {} };
      },
    },
  };

  return {
    ctx,
    editor,
    reload() {
      for (const callback of [...transforms]) callback(editor);
    },
    fire(name: string, input: unknown, providerID: string) {
      for (const hook of hooks) {
        if (hook.name !== name) continue;
        const scope = hook.options?.providerID;
        if (scope === undefined || scope === providerID) hook.callback(input);
      }
    },
  };
}

test("TestREQ_CB_AGY_001_language_model_plugin_wiring_registers_agy_with_clean_teardown", async (t) => {
  const { default: plugin } = await import("../../src/index.ts");
  const host = createPluginHost(AGY_ENABLED_OPTIONS);

  const cleanup = await plugin.setup(host.ctx as never);
  assert.equal(typeof cleanup, "function");
  // The setup owns a loopback host bridge; tear it down even if an assertion
  // below fails, or the leaked server would keep the test process alive.
  t.after(() => cleanup());

  host.reload();
  host.reload();
  const agyRecord = host.editor.records.filter((record) => record.provider.id === AGY_PROVIDER_ID);
  assert.equal(agyRecord.length, 1, "the agy provider must register exactly once across reloads");
  assert.equal(agyRecord[0].models.length, AGY_MODEL_SLUGS.length);
  assert.ok(
    host.editor.records.some((record) => record.provider.id === "claude-bridge"),
    "the Wave A clamp provider must still register with agy enabled",
  );

  const agyModel = projectAgyModels()[0];
  const attach: Record<string, unknown> = { model: agyModel, sdk: {}, options: {} };
  host.fire("language", attach, AGY_PROVIDER_ID);
  const language = attach.language as { provider: string; specificationVersion: string };
  assert.equal(language.provider, AGY_PROVIDER_ID, "the agy model must attach the agy adapter");
  assert.equal(language.specificationVersion, "v3");

  await assert.doesNotReject(cleanup(), "cleanup must resolve with zero leaks");
  await assert.doesNotReject(cleanup(), "cleanup must be re-entrant");
});

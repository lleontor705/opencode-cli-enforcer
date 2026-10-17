/**
 * Oracles for the three cross-file seams closed by cb-28 (REQ-CB-TOOL-003,
 * REQ-CB-ERR-001, REQ-CB-CMPR-001; design D3/D9).
 *
 * The load-bearing proof is the concurrency defect cb-15 surfaced: one shared
 * `ToolRendezvous` let a single session's abort release every other session's
 * parked `tools/call`. These oracles drive two real adapter instances through a
 * scripted SDK query so the release scope is asserted on live state, not on a
 * mock. Two supporting seams are covered too: the spawn-tracking callback that
 * keeps `LiveQueries`/`reportLeaks` live, and the compaction `abortSignal` path
 * down to the SDK `abortController`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { LanguageModelV3, LanguageModelV3Prompt } from "@ai-sdk/provider";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionCompaction } from "@opencode/plugin/promise/session";

import { projectClaudeCodeModels } from "../../src/provider/models.js";
import {
  createClaudeBridgeLanguageModelFactory,
  RendezvousScopes,
  SESSION_ID_HEADER,
  type ClaudeBridgeSpawn,
  type HostToolDefinition,
} from "../../src/provider/language-model.js";
import type { QuerySpawner } from "../../src/provider/query-lifecycle.js";
import type { ClaudeRawEvent } from "../../src/stream/mapping.js";
import {
  LiveQueries,
  TeardownLeakError,
  reportLeaks,
  teardownQuery,
} from "../../src/errors/teardown.js";
import type { BridgeError } from "../../src/errors/taxonomy.js";
import {
  buildSummarizerOptions,
  createCompactionHandler,
  type SummarizerSpawner,
} from "../../src/session/compaction.js";

// ---------------------------------------------------------------------------
// Scripted SDK query: never spawns a child, parks until released.
// ---------------------------------------------------------------------------

interface QueryControl {
  interrupted: boolean;
  closed: boolean;
  release: () => void;
}

interface SpawnedScript {
  readonly control: QueryControl;
  readonly query: Query;
}

function scriptedQuery(): SpawnedScript {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const control: QueryControl = { interrupted: false, closed: false, release: () => release() };

  async function* generate(): AsyncGenerator<SDKMessage, void> {
    await gate;
  }

  const query = Object.assign(generate(), {
    interrupt: async () => {
      control.interrupted = true;
      release();
    },
    close: () => {
      control.closed = true;
      release();
    },
  }) as unknown as Query;

  return { control, query };
}

function makeSpawner(): { spawn: QuerySpawner; spawned: SpawnedScript[] } {
  const spawned: SpawnedScript[] = [];
  const spawn: QuerySpawner = () => {
    const entry = scriptedQuery();
    spawned.push(entry);
    return entry.query;
  };
  return { spawn, spawned };
}

const HOST_TOOL: HostToolDefinition = {
  name: "bash",
  description: "run a shell command",
  inputSchema: { type: "object" },
};

function makeLanguage(
  spawn: QuerySpawner,
  scopes: RendezvousScopes,
  onSpawn?: (spawn: ClaudeBridgeSpawn) => void,
): LanguageModelV3 {
  const [model] = projectClaudeCodeModels();
  assert.ok(model, "the catalog must expose at least one claude model");
  const factory = createClaudeBridgeLanguageModelFactory({
    spawnImpl: spawn,
    rendezvousScopes: scopes,
    hostTools: [HOST_TOOL],
    ...(onSpawn !== undefined ? { onSpawn } : {}),
  });
  return factory(model);
}

function userPrompt(text: string): LanguageModelV3Prompt {
  return [{ role: "user", content: [{ type: "text", text }] }];
}

async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("oracle deadline exceeded: condition never held");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
// REQ-CB-TOOL-003: the rendezvous release is bounded to one session.
// ---------------------------------------------------------------------------

test("TestREQ_CB_TOOL_003_session_abort_does_not_release_another_session_handler", async () => {
  const scopes = new RendezvousScopes();
  const { spawn, spawned } = makeSpawner();
  const sessionA = makeLanguage(spawn, scopes);
  const sessionB = makeLanguage(spawn, scopes);
  const abortA = new AbortController();
  const abortB = new AbortController();

  await sessionA.doStream({
    prompt: userPrompt("session a"),
    abortSignal: abortA.signal,
    headers: { [SESSION_ID_HEADER]: "session-a" },
  });
  await sessionB.doStream({
    prompt: userPrompt("session b"),
    abortSignal: abortB.signal,
    headers: { [SESSION_ID_HEADER]: "session-b" },
  });

  assert.equal(spawned.length, 2, "each session must park its own SDK query");

  const scopeA = scopes.get("session-a");
  const scopeB = scopes.get("session-b");
  assert.notEqual(scopeA, scopeB, "two sessions must not share a rendezvous store");

  const parkedA = scopeA.awaitToolResult("toolu_a", "bash");
  const parkedB = scopeB.awaitToolResult("toolu_b", "bash");
  assert.equal(scopeA.pendingToolCallCount, 1);
  assert.equal(scopeB.pendingToolCallCount, 1);

  abortA.abort();

  assert.equal(scopeA.pendingToolCallCount, 0, "session A abort must release A's parked handler");
  assert.equal(scopeB.pendingToolCallCount, 1, "session B parked handler must remain parked");
  assert.equal(spawned[0]?.control.interrupted, true, "session A's SDK query is interrupted");
  assert.equal(spawned[1]?.control.interrupted, false, "session B's SDK query must be untouched");

  const releasedA = await parkedA;
  assert.equal(releasedA.isError, true, "the aborted handler resolves with an error result, never rejects");

  // Session B still completes on its own result, independent of A's abort.
  assert.equal(scopeB.deliverToolResult("toolu_b", { content: [{ type: "text", text: "ok" }] }), true);
  const deliveredB = await parkedB;
  assert.equal(deliveredB.content[0]?.text, "ok");
  assert.equal(scopeB.pendingToolCallCount, 0);
  assert.equal(scopeA.pendingResultCount, 0, "A's abort must not buffer state for B");

  abortB.abort();
});

// ---------------------------------------------------------------------------
// REQ-CB-ERR-001: the spawn-tracking seam keeps the live-query ledger live.
// ---------------------------------------------------------------------------

test("TestREQ_CB_ERR_001_spawn_tracking_feeds_live_queries_and_leak_check", async () => {
  const scopes = new RendezvousScopes();
  const { spawn } = makeSpawner();
  const live = new LiveQueries();
  const tracked: ClaudeBridgeSpawn[] = [];
  const language = makeLanguage(spawn, scopes, (entry) => {
    tracked.push(entry);
    live.track(entry.context);
  });
  const abort = new AbortController();

  await language.doStream({
    prompt: userPrompt("track me"),
    abortSignal: abort.signal,
    headers: { [SESSION_ID_HEADER]: "session-tracked" },
  });

  assert.equal(tracked.length, 1, "a spawn must reach the tracking callback");
  const entry = tracked[0]!;
  assert.equal(entry.sessionKey, "session-tracked");
  assert.equal(entry.rendezvous, scopes.get("session-tracked"), "the seam exposes the resolved scope");
  assert.equal(live.has(entry.context), true, "the entry can track the live context");

  // Still tracked => the unreleased-context leak check is live and fail-loud.
  assert.throws(
    () => reportLeaks("tracking-oracle", { context: entry.context, rendezvous: entry.rendezvous, liveQueries: live }),
    (error: unknown) =>
      error instanceof TeardownLeakError &&
      error.leaks.some((leak) => leak.includes("unreleased query context")),
  );

  teardownQuery({ context: entry.context, rendezvous: entry.rendezvous, liveQueries: live });
  assert.equal(live.has(entry.context), false, "teardown releases the tracked context");
  assert.doesNotThrow(() =>
    reportLeaks("tracking-oracle", { context: entry.context, rendezvous: entry.rendezvous, liveQueries: live }),
  );

  abort.abort();
});

// ---------------------------------------------------------------------------
// REQ-CB-CMPR-001: a cancelled compaction aborts the lane promptly.
// ---------------------------------------------------------------------------

function compactionInput(): SessionCompaction {
  return {
    sessionID: "ses_compaction",
    agent: "build",
    model: { providerID: "claude", modelID: "claude-sonnet-4" },
    system: [{ type: "text", text: "You are a coding assistant." }],
    messages: [
      { id: "m1", role: "user", content: [{ type: "text", text: "Implement the parser." }] },
      { id: "m2", role: "assistant", content: [{ type: "text", text: "Parser implemented." }] },
    ],
    options: {},
    tools: {},
  } as unknown as SessionCompaction;
}

function assistantMessage(text: string): SDKMessage {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    session_id: "summarizer-session",
    uuid: "summarizer-assistant",
  } as unknown as SDKMessage;
}

test("TestREQ_CB_CMPR_001_summarizer_options_bridge_the_signal", () => {
  const abort = new AbortController();
  const options = buildSummarizerOptions({ signal: abort.signal });

  assert.ok(options.abortController, "the signal must map onto the SDK abortController");
  assert.equal(options.abortController!.signal.aborted, false);
  abort.abort();
  assert.equal(options.abortController!.signal.aborted, true, "cancellation must propagate promptly");
});

test("TestREQ_CB_CMPR_001_compaction_abort_leaves_result_unset", async () => {
  const bridged: AbortController[] = [];
  let releaseGate: (() => void) | null = null;
  const spawn: SummarizerSpawner = (params) => {
    const controller = params.options.abortController;
    if (controller !== undefined) bridged.push(controller);
    return (async function* () {
      yield assistantMessage("partial summary");
      await new Promise<void>((resolve) => {
        releaseGate = resolve;
        controller?.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    })();
  };

  const failures: BridgeError[] = [];
  const handler = createCompactionHandler({ spawn, reportFailure: (error) => failures.push(error) });
  const abort = new AbortController();
  const input = compactionInput();
  (input.options as Record<string, unknown>).abortSignal = abort.signal;

  // Avoid an unhandled rejection if the lane throws before we await it.
  const running = handler(input);
  await waitFor(() => releaseGate !== null);

  assert.equal(bridged.length, 1, "the lane must bridge the host signal to the SDK child");
  assert.equal(bridged[0]!.signal.aborted, false);

  abort.abort();
  await running;

  assert.equal(bridged[0]!.signal.aborted, true, "cancellation must reach the SDK child promptly");
  assert.equal(input.result, undefined, "an aborted compaction must leave result unset");
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.code, "CB_STREAM_ABORTED");
});

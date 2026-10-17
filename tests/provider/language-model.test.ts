/**
 * Oracles for the custom LanguageModelV3 adapter (REQ-CB-PROV-002, D1/D6).
 *
 * The pump is exercised through an injected scripted query, so no Claude Code
 * child is ever spawned. Three contract points are covered here plus the
 * cb-08 STRM-001..003 fixtures replayed through the adapter:
 *
 * - a claude request streams from the SDK pump (never a native HTTP
 *   provider), abortSignal aborts the query and ends with an error part, and a
 *   foreign provider id never receives the custom language model;
 * - a tool-using step finishes at the SDK tool boundary so OpenCode can execute
 *   the tool, and the next step delivers the tool result into the parked query.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { Model } from "@opencode/plugin";
import type { LanguageModelV3, LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { ToolRendezvous } from "../../src/mcp/rendezvous.js";
import { ClaudeEventMapper, renderNormalizedEvents } from "../../src/stream/mapping.js";
import type { ClaudeRawEvent, NormalizedClaudeEvent } from "../../src/stream/mapping.js";
import { projectClaudeCodeModels } from "../../src/provider/models.js";
import {
  createClaudeBridgeLanguageModel,
  createClaudeBridgeLanguageModelFactory,
  type ClaudeBridgeLanguageModelConfig,
  type HostToolDefinition,
} from "../../src/provider/language-model.js";
import { registerClaudeBridge, type ClaudeBridgeContext } from "../../src/provider/registration.js";
import type { QuerySpawner } from "../../src/provider/query-lifecycle.js";

// ---------------------------------------------------------------------------
// Scripted SDK query: yields fixture messages, then parks until aborted.
// ---------------------------------------------------------------------------

interface QueryControl {
  readonly script: ClaudeRawEvent[];
  readonly hold: boolean;
  interrupted: boolean;
  closed: boolean;
  release: (() => void) | null;
}

function scriptedQuery(control: QueryControl): Query {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  control.release = release;

  async function* generate(): AsyncGenerator<SDKMessage, void> {
    for (const message of control.script) yield message as unknown as SDKMessage;
    if (control.hold) await gate;
  }

  const iterator = generate();
  return Object.assign(iterator, {
    interrupt: async () => {
      control.interrupted = true;
      release();
    },
    close: () => {
      control.closed = true;
      release();
    },
  }) as unknown as Query;
}

interface Harness {
  readonly language: LanguageModelV3;
  readonly control: QueryControl;
  readonly queries: readonly Query[];
  readonly rendezvous: ToolRendezvous;
  readonly model: Model.Info;
}

interface HarnessOptions {
  readonly hold?: boolean;
  readonly hostTools?: readonly HostToolDefinition[];
  readonly rendezvous?: ToolRendezvous;
}

function makeHarness(script: ClaudeRawEvent[], options: HarnessOptions = {}): Harness {
  const control: QueryControl = {
    script,
    hold: options.hold ?? false,
    interrupted: false,
    closed: false,
    release: null,
  };
  const queries: Query[] = [];
  const rendezvous = options.rendezvous ?? new ToolRendezvous();
  const spawnImpl: QuerySpawner = () => {
    const query = scriptedQuery(control);
    queries.push(query);
    return query;
  };
  const [model] = projectClaudeCodeModels();
  assert.ok(model, "the catalog must expose at least one claude model");

  const config: ClaudeBridgeLanguageModelConfig = {
    spawnImpl,
    rendezvous,
    ...(options.hostTools !== undefined ? { hostTools: options.hostTools } : {}),
  };
  return { language: createClaudeBridgeLanguageModel(model, config), control, queries, rendezvous, model };
}

function streamEvent(event: Record<string, unknown>): ClaudeRawEvent {
  return { type: "stream_event", event } as unknown as ClaudeRawEvent;
}

function userPrompt(text: string): LanguageModelV3Prompt {
  return [{ role: "user", content: [{ type: "text", text }] }];
}

async function collectStream(
  stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3StreamPart[]> {
  const reader = stream.getReader();
  const parts: LanguageModelV3StreamPart[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
}

function directRender(fixture: readonly ClaudeRawEvent[]): LanguageModelV3StreamPart[] {
  const mapper = new ClaudeEventMapper();
  const normalized: NormalizedClaudeEvent[] = [];
  for (const raw of fixture) normalized.push(...mapper.map(raw));
  return renderNormalizedEvents(normalized);
}

async function replayThroughAdapter(
  fixture: readonly ClaudeRawEvent[],
): Promise<LanguageModelV3StreamPart[]> {
  const { language } = makeHarness([...fixture]);
  const { stream } = await language.doStream({ prompt: userPrompt("go") });
  return collectStream(stream);
}

function partTypes(parts: readonly LanguageModelV3StreamPart[]): string[] {
  return parts.map((part) => part.type);
}

// ---------------------------------------------------------------------------
// REQ-CB-PROV-002: the custom LanguageModelV3 seam.
// ---------------------------------------------------------------------------

test("TestREQ_CB_PROV_002_language_model_v3_seam sources its stream from the SDK pump", async () => {
  const fixture: ClaudeRawEvent[] = [
    streamEvent({ type: "message_start", message: { id: "m1" } }),
    streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
    streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
    streamEvent({ type: "content_block_stop", index: 0 }),
    streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    streamEvent({ type: "message_stop" }),
    { type: "result", subtype: "success", is_error: false, result: "", usage: { input_tokens: 3, output_tokens: 2 } },
  ];

  const harness = makeHarness(fixture);
  const { stream } = await harness.language.doStream({ prompt: userPrompt("hi") });
  const parts = await collectStream(stream);

  assert.equal(harness.language.provider, "claude");
  assert.equal(harness.language.specificationVersion, "v3");
  assert.equal(harness.language.modelId, harness.model.id);
  assert.equal(harness.queries.length, 1, "the stream must be sourced from the SDK query pump, not HTTP");
  assert.deepEqual(partTypes(parts), ["stream-start", "text-start", "text-delta", "text-end", "finish"]);

  const delta = parts.find((part) => part.type === "text-delta") as { delta: string };
  assert.equal(delta.delta, "Hello");
  const finish = parts.at(-1) as { finishReason: { unified: string } };
  assert.equal(finish.finishReason.unified, "stop");
});

test("TestREQ_CB_PROV_002_language_model_v3_seam aborts the query and ends with an error part", async () => {
  const fixture: ClaudeRawEvent[] = [
    streamEvent({ type: "message_start", message: { id: "m1" } }),
    streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
    streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
  ];

  const harness = makeHarness(fixture, { hold: true });
  const controller = new AbortController();
  const { stream } = await harness.language.doStream({
    prompt: userPrompt("hi"),
    abortSignal: controller.signal,
  });

  const reader = stream.getReader();
  const parts: LanguageModelV3StreamPart[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    if (value.type === "text-delta") break;
  }
  assert.ok(parts.some((part) => part.type === "text-delta"), "the turn must stream before aborting");

  controller.abort();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }

  assert.equal(harness.control.interrupted, true, "abortSignal must abort the underlying SDK query");
  assert.equal(parts.at(-1)?.type, "error", "the aborted stream must end with an error part, never a hang");
});

test("TestREQ_CB_PROV_002_language_model_v3_seam is scoped by providerID", async () => {
  const hooks: Array<{ name: string; callback: (input: LanguageHookInput) => void; options?: { providerID?: string } }> = [];
  const ctx = {
    provider: { transform: async () => ({ dispose: async () => {} }) },
    aisdk: {
      hook: async (name: string, callback: (input: LanguageHookInput) => void, options?: { providerID?: string }) => {
        hooks.push({ name, callback, options });
        return { dispose: async () => {} };
      },
    },
  } as unknown as ClaudeBridgeContext;

  const spawnImpl: QuerySpawner = () => {
    throw new Error("the hook test never streams");
  };
  await registerClaudeBridge(ctx, {
    languageModelFactory: createClaudeBridgeLanguageModelFactory({ spawnImpl }),
  });

  const languageHook = hooks.find((hook) => hook.name === "language");
  assert.ok(languageHook, "registerClaudeBridge must bind a language hook");
  assert.deepEqual(languageHook.options, { providerID: "claude" });

  const [model] = projectClaudeCodeModels();
  assert.ok(model);

  const bridgeInput: LanguageHookInput = { model, sdk: {}, options: {} };
  fireLanguage(hooks, bridgeInput, "claude");
  assert.ok(bridgeInput.language, "a claude request must receive the custom language model");
  assert.equal(bridgeInput.language.provider, "claude");
  assert.equal(bridgeInput.language.specificationVersion, "v3");

  const foreignInput: LanguageHookInput = { model, sdk: {}, options: {} };
  fireLanguage(hooks, foreignInput, "anthropic");
  assert.equal(foreignInput.language, undefined, "a foreign provider must not attach the custom model");
});

interface LanguageHookInput {
  readonly model: Model.Info;
  readonly sdk: unknown;
  readonly options: Record<string, unknown>;
  language?: LanguageModelV3 | undefined;
}

function fireLanguage(
  hooks: ReadonlyArray<{ name: string; callback: (input: LanguageHookInput) => void; options?: { providerID?: string } }>,
  input: LanguageHookInput,
  providerID: string,
): void {
  for (const hook of hooks) {
    if (hook.name !== "language") continue;
    const scope = hook.options?.providerID;
    if (scope === undefined || scope === providerID) hook.callback(input);
  }
}

// ---------------------------------------------------------------------------
// REQ-CB-TOOL-005: the adapter drives tool delivery through the parked query.
// ---------------------------------------------------------------------------

test("TestREQ_CB_TOOL_005_adapter_finishes_at_tool_boundary_and_delivers_results", async () => {
  const fixture: ClaudeRawEvent[] = [
    { type: "system", subtype: "init", session_id: "sess_1" },
    streamEvent({ type: "message_start", message: { id: "m1" } }),
    streamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "bash", input: {} },
    }),
    streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } }),
    streamEvent({ type: "content_block_stop", index: 0 }),
    streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
    streamEvent({ type: "message_stop" }),
  ];

  const rendezvous = new ToolRendezvous();
  const harness = makeHarness(fixture, {
    hold: true,
    rendezvous,
    hostTools: [{ name: "bash", description: "run a shell command", inputSchema: { type: "object" } }],
  });

  const { stream } = await harness.language.doStream({ prompt: userPrompt("run ls") });
  const parts = await collectStream(stream);
  assert.deepEqual(partTypes(parts), [
    "stream-start",
    "tool-input-start",
    "tool-input-delta",
    "tool-input-end",
    "tool-call",
    "finish",
  ]);
  const finish = parts.at(-1) as { finishReason: { unified: string } };
  assert.equal(finish.finishReason.unified, "tool-calls", "a tool-using step must finish at the tool boundary");

  const parked = rendezvous.awaitToolResult("toolu_1", "bash");
  const controller = new AbortController();
  await harness.language.doStream({
    prompt: [
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "toolu_1", toolName: "bash", output: { type: "text", value: "file" } }],
      },
    ],
    abortSignal: controller.signal,
  });

  const result = await parked;
  assert.equal(result.content[0]?.text, "file");
  assert.equal(rendezvous.pendingToolCallCount, 0);
  controller.abort();
});

// ---------------------------------------------------------------------------
// REQ-CB-STRM-001..003: fixtures replay green through the adapter.
// ---------------------------------------------------------------------------

test("TestREQ_CB_STRM_001_replays_through_the_adapter", async () => {
  const fixture: ClaudeRawEvent[] = [
    streamEvent({
      type: "message_start",
      message: {
        id: "msg_A",
        usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
      },
    }),
    streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
    streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
    streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } }),
    streamEvent({ type: "content_block_stop", index: 0 }),
    streamEvent({ type: "content_block_start", index: 1, content_block: { type: "thinking" } }),
    streamEvent({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "weighing options" } }),
    streamEvent({ type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "sig-123" } }),
    streamEvent({ type: "content_block_stop", index: 1 }),
    streamEvent({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_01", name: "bash", input: {} } }),
    streamEvent({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"command":' } }),
    streamEvent({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"ls"}' } }),
    streamEvent({ type: "content_block_stop", index: 2 }),
    streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 25 } }),
    streamEvent({ type: "message_stop" }),
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      session_id: "sess_1",
      usage: { input_tokens: 10, output_tokens: 25, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
    },
  ];

  const direct = directRender(fixture);
  const replayed = await replayThroughAdapter(fixture);
  assert.deepEqual(replayed, [{ type: "stream-start", warnings: [] }, ...direct]);
});

test("TestREQ_CB_STRM_002_replays_through_the_adapter", async () => {
  const fixture: ClaudeRawEvent[] = [
    streamEvent({ type: "message_start", message: { id: "m1" } }),
    streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
    streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "abc" } }),
    {
      type: "assistant",
      message: { id: "m2", model: "claude-sonnet", content: [{ type: "text", text: "full answer" }], usage: { input_tokens: 4, output_tokens: 4 } },
    } as ClaudeRawEvent,
    {
      type: "assistant",
      message: { id: "m3", model: "claude-sonnet", content: [{ type: "text", text: "more" }], usage: { output_tokens: 6 } },
    } as ClaudeRawEvent,
  ];

  const direct = directRender(fixture);
  // The abandoned "abc" text block's start/delta were already emitted before CC
  // restarted; only its record is dropped, so both real messages follow.
  assert.deepEqual(partTypes(direct), [
    "text-start",
    "text-delta",
    "text-start",
    "text-delta",
    "text-end",
    "text-start",
    "text-delta",
    "text-end",
  ]);

  const replayed = await replayThroughAdapter(fixture);
  assert.deepEqual(replayed, [{ type: "stream-start", warnings: [] }, ...direct]);
});

test("TestREQ_CB_STRM_003_replays_through_the_adapter", async () => {
  const fixture: ClaudeRawEvent[] = [
    {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1_700_000_000 },
    } as ClaudeRawEvent,
    { type: "result", subtype: "success", is_error: true, result: "You're out of extra usage", usage: { input_tokens: 2, output_tokens: 3 } } as ClaudeRawEvent,
  ];

  const direct = directRender(fixture);
  assert.deepEqual(partTypes(direct), ["error"]);

  const replayed = await replayThroughAdapter(fixture);
  assert.deepEqual(replayed, [{ type: "stream-start", warnings: [] }, ...direct]);
});

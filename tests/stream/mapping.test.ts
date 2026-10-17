import test from "node:test";
import assert from "node:assert/strict";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

import type { ClaudeRawEvent, NormalizedClaudeEvent } from "../../src/stream/mapping.js";
import {
  ClaudeEventMapper,
  renderNormalizedEvents,
  toLanguageModelV3Usage,
} from "../../src/stream/mapping.js";
import type { BridgeMessage } from "../../src/stream/convert.js";
import { convertMessages, projectPrompt, sanitizeToolId } from "../../src/stream/convert.js";

// ---------------------------------------------------------------------------
// Fixture builders.
// ---------------------------------------------------------------------------

function streamEvent(event: Record<string, unknown>): ClaudeRawEvent {
  return { type: "stream_event", event } as unknown as ClaudeRawEvent;
}

function collect(mapper: ClaudeEventMapper, raws: readonly ClaudeRawEvent[]): NormalizedClaudeEvent[] {
  const out: NormalizedClaudeEvent[] = [];
  for (const raw of raws) out.push(...mapper.map(raw));
  return out;
}

function partTypes(parts: readonly LanguageModelV3StreamPart[]): string[] {
  return parts.map((part) => part.type);
}

function errorMessage(part: LanguageModelV3StreamPart): string {
  const error = (part as { error?: { message?: string } }).error;
  return String(error?.message ?? "");
}

// ---------------------------------------------------------------------------
// REQ-CB-STRM-001: SDK events -> LMV3 parts.
// ---------------------------------------------------------------------------

test("TestREQ_CB_STRM_001_sdk_events_to_lmv3_parts", () => {
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

  const mapper = new ClaudeEventMapper();
  const normalized = collect(mapper, fixture);
  const parts = renderNormalizedEvents(normalized);

  // Parts appear in the same order the SDK emitted their source events.
  assert.deepEqual(partTypes(parts), [
    "text-start",
    "text-delta",
    "text-delta",
    "text-end",
    "reasoning-start",
    "reasoning-delta",
    "reasoning-end",
    "tool-input-start",
    "tool-input-delta",
    "tool-input-delta",
    "tool-input-end",
    "tool-call",
    "finish",
  ]);

  const textDeltas = parts.filter((p) => p.type === "text-delta") as Array<{ delta: string }>;
  assert.equal(textDeltas.map((p) => p.delta).join(""), "Hello world");

  const reasoningDelta = parts.find((p) => p.type === "reasoning-delta") as { delta: string; id: string };
  assert.equal(reasoningDelta.delta, "weighing options");

  const reasoningEnd = parts.find((p) => p.type === "reasoning-end") as {
    providerMetadata?: Record<string, Record<string, unknown>>;
  };
  assert.equal(reasoningEnd.providerMetadata?.["claude"]?.signature, "sig-123");

  const toolCall = parts.find((p) => p.type === "tool-call") as {
    toolCallId: string;
    toolName: string;
    input: string;
  };
  assert.equal(toolCall.toolCallId, "toolu_01");
  assert.equal(toolCall.toolName, "bash");
  assert.deepEqual(JSON.parse(toolCall.input), { command: "ls" });

  const finish = parts.find((p) => p.type === "finish") as {
    usage: unknown;
    finishReason: { unified: string; raw: string | undefined };
  };
  assert.deepEqual(finish.usage, {
    inputTokens: { total: 15, noCache: 10, cacheRead: 3, cacheWrite: 2 },
    outputTokens: { total: 25, text: 25, reasoning: undefined },
  });
  assert.equal(finish.finishReason.unified, "tool-calls");
  assert.equal(finish.finishReason.raw, "tool_use");

  const turn = mapper.toTurnResult(fixture);
  assert.equal(turn.status, "completed");
  assert.equal(turn.text, "Hello world");
  assert.equal(turn.sessionId, "sess_1");
  assert.deepEqual(turn.usage, { inputTokens: 10, outputTokens: 25, cacheReadTokens: 3, cacheWriteTokens: 2 });
});

test("TestREQ_CB_STRM_001_parallel_tool_calls_get_distinct_sanitized_ids", () => {
  const mapper = new ClaudeEventMapper();
  const normalized = collect(mapper, [
    streamEvent({ type: "message_start", message: { id: "m1" } }),
    streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu/AAA", name: "read", input: {} } }),
    streamEvent({ type: "content_block_stop", index: 0 }),
    streamEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu/BBB", name: "write", input: {} } }),
    streamEvent({ type: "content_block_stop", index: 1 }),
    streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
    streamEvent({ type: "message_stop" }),
    { type: "result", subtype: "success", is_error: false, result: "", usage: { input_tokens: 5, output_tokens: 9 } },
  ]);

  const calls = renderNormalizedEvents(normalized).filter((p) => p.type === "tool-call") as Array<{ toolCallId: string }>;
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].toolCallId, calls[1].toolCallId);
  assert.deepEqual(calls.map((c) => c.toolCallId), ["toolu_AAA", "toolu_BBB"]);
  // Deterministic sanitization removes the characters Anthropic rejects.
  assert.equal(sanitizeToolId("toolu/AAA", new Map()), "toolu_AAA");
});

test("TestREQ_CB_STRM_001_usage_mapping_matches_reference", () => {
  assert.deepEqual(toLanguageModelV3Usage({ inputTokens: 7, outputTokens: 11, cacheReadTokens: 2, cacheWriteTokens: 5 }), {
    inputTokens: { total: 14, noCache: 7, cacheRead: 2, cacheWrite: 5 },
    outputTokens: { total: 11, text: 11, reasoning: undefined },
  });
});

// ---------------------------------------------------------------------------
// REQ-CB-STRM-002: synthetic + abandoned blocks.
// ---------------------------------------------------------------------------

test("TestREQ_CB_STRM_002_synthetic_and_abandoned_dropped", () => {
  // A `<synthetic>` assistant message alone emits nothing.
  const bare = new ClaudeEventMapper();
  const syntheticOnly = bare.map({
    type: "assistant",
    message: {
      id: "s1",
      model: "<synthetic>",
      content: [{ type: "text", text: "API Error: rate limited" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  } as ClaudeRawEvent);
  assert.deepEqual(syntheticOnly, []);
  assert.deepEqual(renderNormalizedEvents(syntheticOnly), []);

  // A synthetic report after an open stream drops its abandoned partial blocks
  // and still emits no stream part of its own.
  const overStream = new ClaudeEventMapper();
  overStream.map(streamEvent({ type: "message_start", message: { id: "m1" } }));
  overStream.map(streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }));
  overStream.map(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }));
  const syntheticAfterStream = overStream.map({
    type: "assistant",
    message: { id: "m2", model: "<synthetic>", content: [{ type: "text", text: "API Error" }] },
  } as ClaudeRawEvent);
  assert.equal(syntheticAfterStream.filter((e) => e.kind !== "stream-reset").length, 0);
  assert.deepEqual(renderNormalizedEvents(syntheticAfterStream), []);

  // A non-streaming fallback under a new id mid-stream drops the abandoned
  // blocks exactly once, and a later message never drops again.
  const fallback = new ClaudeEventMapper();
  const normalized = collect(fallback, [
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
  ]);

  assert.equal(normalized.filter((e) => e.kind === "stream-reset").length, 1);
  const texts = fallback.query.turnBlocks.filter((b) => b.type === "text").map((b) => String(b.text));
  assert.deepEqual(texts, ["full answer", "more"]);
});

// ---------------------------------------------------------------------------
// REQ-CB-STRM-003: rate-limit correlation, dedupe and is_error.
// ---------------------------------------------------------------------------

test("TestREQ_CB_STRM_003_rate_limit_and_is_error", () => {
  // 45% twice lands in the same 5% bucket: notify the host once.
  let notifications = 0;
  const warned = new ClaudeEventMapper({ notify: () => { notifications += 1; } });
  const first = warned.map({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed_warning", utilization: 0.45, surpassedThreshold: 0.4, rateLimitType: "five_hour" },
  } as ClaudeRawEvent);
  const second = warned.map({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed_warning", utilization: 0.45, surpassedThreshold: 0.4, rateLimitType: "five_hour" },
  } as ClaudeRawEvent);
  assert.equal(notifications, 1);
  assert.equal(first.filter((e) => e.kind === "rate-limit").length, 1);
  assert.equal(second.length, 0);

  // A rejection followed by the failure it caused: the error carries the context.
  const correlated = new ClaudeEventMapper();
  correlated.map({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1_700_000_000 },
  } as ClaudeRawEvent);
  const correlatedEvents = correlated.map({
    type: "result",
    subtype: "success",
    is_error: true,
    result: "You're out of extra usage",
    usage: { input_tokens: 2, output_tokens: 3 },
  } as ClaudeRawEvent);
  const correlatedParts = renderNormalizedEvents(correlatedEvents);
  assert.deepEqual(partTypes(correlatedParts), ["error"]);
  assert.match(errorMessage(correlatedParts[0]), /Claude rate limit \(five_hour\)/);
  assert.match(errorMessage(correlatedParts[0]), /You're out of extra usage/);

  // is_error on a success-shaped result with no rejection is a plain failure.
  const failed = new ClaudeEventMapper();
  const failedParts = renderNormalizedEvents(
    failed.map({ type: "result", subtype: "success", is_error: true, result: "boom" } as ClaudeRawEvent),
  );
  assert.deepEqual(partTypes(failedParts), ["error"]);
  assert.equal(errorMessage(failedParts[0]), "boom");
  assert.equal(
    failed.toTurnResult([{ type: "result", subtype: "success", is_error: true, result: "boom" }]).status,
    "failed",
  );
});

// ---------------------------------------------------------------------------
// convert.ts: conversion, sanitization and fail-loud projection.
// ---------------------------------------------------------------------------

test("TestREQ_CB_STRM_001_convert_merges_parallel_tool_results", () => {
  const messages: BridgeMessage[] = [
    {
      role: "assistant",
      provider: "claude",
      content: [
        { type: "thinking", thinking: "plan", thinkingSignature: "sig-1" },
        { type: "toolCall", id: "toolu/A", name: "read", arguments: { path: "a" } },
        { type: "toolCall", id: "toolu/B", name: "read", arguments: { path: "b" } },
      ],
    },
    { role: "toolResult", toolCallId: "toolu/A", content: "A ok" },
    { role: "toolResult", toolCallId: "toolu/B", content: "B ok" },
  ];

  const { anthropicMessages, dropped } = convertMessages(messages);
  assert.equal(anthropicMessages.length, 2);

  const assistant = anthropicMessages[0].content;
  assert.ok(Array.isArray(assistant));
  assert.equal(assistant[0].type, "thinking");
  assert.equal(assistant[0].signature, "sig-1");
  assert.equal(assistant[1].id, "toolu_A");
  assert.equal(assistant[2].id, "toolu_B");

  // Both parallel results land in ONE user message, directly after their turn.
  assert.equal(anthropicMessages[1].role, "user");
  const user = anthropicMessages[1].content;
  assert.ok(Array.isArray(user));
  assert.equal(user.length, 2);
  assert.equal(user[0].tool_use_id, "toolu_A");
  assert.equal(user[1].tool_use_id, "toolu_B");
  assert.equal(dropped.thinking, 0);
});

test("TestREQ_CB_STRM_001_convert_drops_foreign_thinking_signature", () => {
  const { anthropicMessages, dropped } = convertMessages([
    {
      role: "assistant",
      provider: "some-other-provider",
      content: [{ type: "thinking", thinking: "x", thinkingSignature: "sig-x" }],
    },
  ]);
  const content = anthropicMessages[0].content;
  assert.ok(Array.isArray(content));
  // A signature minted elsewhere is not ours to replay; the block is dropped and
  // reported, and the message keeps a valid non-empty placeholder.
  assert.equal(content[0].type, "text");
  assert.equal(content[0].text, "[incompatible content omitted]");
  assert.equal(dropped.thinking, 1);
  assert.ok(dropped.providers.has("some-other-provider"));
});

test("TestREQ_CB_STRM_001_prompt_projection_reuses_fail_loud_oracle", () => {
  assert.equal(projectPrompt([{ label: "system", text: "be helpful" }]), "be helpful");
  assert.throws(
    () =>
      projectPrompt([
        { label: "system", text: "You are an expert coding assistant operating inside pi" },
      ]),
    /refusing to send this prompt/,
  );
});

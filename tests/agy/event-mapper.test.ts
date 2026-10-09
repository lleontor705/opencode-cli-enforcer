/**
 * Deterministic oracles for the agy EventMapper (REQ-CB-AGY-001).
 *
 * Every fixture mirrors a shape published in the Antigravity CLI headless
 * documentation, including the cumulative-per-session accounting trap that the
 * seam must normalize. No process, no I/O, no network.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  AGY_MAPPER_CAPABILITIES,
  AgyEventMapper,
  parseAgyLine,
  toTurnUsage,
} from "../../src/agy/event-mapper.ts";
import type { AgyRawEvent, AgyUsagePayload } from "../../src/agy/event-mapper.ts";
import { BridgeError } from "../../src/errors/taxonomy.ts";

// ---------------------------------------------------------------------------
// Fixture builders.
// ---------------------------------------------------------------------------

function initEvent(conversationId: string, tools: readonly string[] = []): AgyRawEvent {
  return {
    event: "init",
    conversation_id: conversationId,
    init: { cwd: "/home/user/project", tools, permission_mode: "request-review" },
  };
}

function stepUpdate(
  conversationId: string,
  stepIndex: number,
  state: "ACTIVE" | "DONE",
  stepType: string,
  extra: Record<string, unknown> = {},
): AgyRawEvent {
  return {
    event: "step_update",
    step_update: { conversation_id: conversationId, step_index: stepIndex, state, step_type: stepType, ...extra },
  };
}

function resultEvent(
  conversationId: string,
  status: string,
  response: string,
  usage: AgyUsagePayload,
  numTurns: number,
  extra: Record<string, unknown> = {},
): AgyRawEvent {
  return {
    event: "result",
    result: { conversation_id: conversationId, status, response, usage, num_turns: numTurns, ...extra },
  };
}

// ---------------------------------------------------------------------------
// Cumulive-per-session usage normalized to per-turn deltas at the seam.
// ---------------------------------------------------------------------------

test("TestREQ_CB_AGY_001_event_mapper_two_turns_are_baseline_subtracted", () => {
  const mapper = new AgyEventMapper();
  const conversation = "9ec58bfd-4d67-4f5e-83a5-9d907e9c6b1f";

  const turn1 = mapper.toTurnResult([
    initEvent(conversation, ["run_command", "write_to_file"]),
    stepUpdate(conversation, 0, "DONE", "user_input"),
    stepUpdate(conversation, 2, "ACTIVE", "agent_response", { text_delta: "app" }),
    stepUpdate(conversation, 2, "DONE", "agent_response", {
      text_delta: "le\n",
      usage: { input_tokens: 30384, output_tokens: 4, cache_read_tokens: 0 },
    }),
    resultEvent(conversation, "SUCCESS", "apple\n", { input_tokens: 30384, output_tokens: 4, cache_read_tokens: 0 }, 1),
  ]);

  assert.equal(turn1.status, "completed");
  assert.equal(turn1.text, "apple\n");
  assert.equal(turn1.sessionId, conversation);
  // First turn starts from the empty session baseline.
  assert.deepEqual(turn1.usage, { inputTokens: 30384, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 });

  const turn2 = mapper.toTurnResult([
    stepUpdate(conversation, 3, "DONE", "user_input"),
    stepUpdate(conversation, 4, "DONE", "agent_response", {
      text_delta: "apple\n",
      usage: { input_tokens: 278, output_tokens: 4, cache_read_tokens: 30214 },
    }),
    resultEvent(conversation, "SUCCESS", "apple\n", { input_tokens: 30662, output_tokens: 8, cache_read_tokens: 30214 }, 2),
  ]);

  // 30662 - 30384 = 278; 8 - 4 = 4; the cumulative total is never re-counted.
  assert.deepEqual(turn2.usage, { inputTokens: 278, outputTokens: 4, cacheReadTokens: 30214, cacheWriteTokens: 0 });
  assert.deepEqual(mapper.sessionBaseline, { inputTokens: 30662, outputTokens: 8, cacheReadTokens: 30214, cacheWriteTokens: 0 });

  // Deltas sum to the session total exactly once.
  const total = {
    inputTokens: turn1.usage.inputTokens + turn2.usage.inputTokens,
    outputTokens: turn1.usage.outputTokens + turn2.usage.outputTokens,
    cacheReadTokens: turn1.usage.cacheReadTokens + turn2.usage.cacheReadTokens,
    cacheWriteTokens: 0,
  };
  assert.deepEqual(total, mapper.sessionBaseline);
});

test("TestREQ_CB_AGY_001_event_mapper_step_usage_is_turn_scoped_without_result", () => {
  const mapper = new AgyEventMapper();
  const result = mapper.toTurnResult([
    stepUpdate("c1", 0, "DONE", "agent_response", {
      text_delta: "Hel",
      usage: { input_tokens: 10, output_tokens: 2 },
    }),
    stepUpdate("c1", 1, "DONE", "agent_response", {
      text_delta: "lo",
      usage: { input_tokens: 5, output_tokens: 3 },
    }),
  ]);

  assert.equal(result.text, "Hello");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.usage, { inputTokens: 15, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

test("TestREQ_CB_AGY_001_event_mapper_result_response_is_authoritative_text", () => {
  const mapper = new AgyEventMapper();
  const result = mapper.toTurnResult([
    stepUpdate("c1", 0, "DONE", "agent_response", { text_delta: "Hel" }),
    stepUpdate("c1", 0, "DONE", "agent_response", { text_delta: "lo" }),
    resultEvent("c1", "SUCCESS", "Hello world", { input_tokens: 7, output_tokens: 2 }, 1),
  ]);

  // The per-turn `response` is used verbatim; fragments are not appended twice.
  assert.equal(result.text, "Hello world");
});

// ---------------------------------------------------------------------------
// Tool steps normalize to a single, complete tool record (capability downgrade).
// ---------------------------------------------------------------------------

test("TestREQ_CB_AGY_001_event_mapper_tool_step_normalizes_whole_call", () => {
  const mapper = new AgyEventMapper();
  const conversation = "edb1c8c1-50ba-4f3f-87eb-412d0e9d47c3";
  mapper.map(initEvent(conversation, ["run_command"]));

  const normalized = mapper.map(
    stepUpdate(conversation, 4, "DONE", "tool", {
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "echo hello_headless_demo" },
        output: "hello_headless_demo\r\n",
      },
    }),
  );

  assert.deepEqual(normalized, [
    {
      kind: "tool-call",
      id: "tool-4",
      toolName: "run_command",
      input: { CommandLine: "echo hello_headless_demo" },
      output: "hello_headless_demo\r\n",
      isError: false,
    },
  ]);
});

test("TestREQ_CB_AGY_001_event_mapper_failed_tool_is_flagged", () => {
  const mapper = new AgyEventMapper();
  const normalized = mapper.map(
    stepUpdate("c1", 7, "DONE", "tool", {
      tool_name: "run_command",
      tool_info: { name: "run_command", parameters: {}, output: "", error: { type: "exec", message: "boom" } },
    }),
  );

  assert.equal(normalized.length, 1);
  const event = normalized[0];
  assert.equal(event?.kind, "tool-call");
  if (event?.kind === "tool-call") {
    assert.equal(event.isError, true);
    assert.equal(event.toolName, "run_command");
  }
});

// ---------------------------------------------------------------------------
// Terminal status classification and fail-loud framing.
// ---------------------------------------------------------------------------

test("TestREQ_CB_AGY_001_event_mapper_error_result_is_classified_failed", () => {
  const mapper = new AgyEventMapper();
  const raw = resultEvent("c1", "ERROR", "", { input_tokens: 0, output_tokens: 0 }, 0, { error: "invalid model selection" });

  const result = mapper.toTurnResult([raw]);
  assert.equal(result.status, "failed");

  const normalized = mapper.map(raw);
  assert.deepEqual(normalized, [{ kind: "error", message: "invalid model selection" }]);
});

test("TestREQ_CB_AGY_001_event_mapper_status_matrix", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["SUCCESS", "completed"],
    ["ERROR", "failed"],
    ["INVALID", "failed"],
    ["RUNNING", "failed"],
    ["CANCELED", "aborted"],
    ["INTERRUPTED", "aborted"],
    ["WAITING", "aborted"],
  ];
  for (const [agyStatus, expected] of cases) {
    const mapper = new AgyEventMapper();
    const result = mapper.toTurnResult([resultEvent("c1", agyStatus, "", { input_tokens: 0, output_tokens: 0 }, 0)]);
    assert.equal(result.status, expected, `agy status ${agyStatus}`);
  }
});

test("TestREQ_CB_AGY_001_event_mapper_unknown_event_is_skipped", () => {
  const mapper = new AgyEventMapper();
  assert.deepEqual(mapper.map({ event: "future_thing", text: "ignored" } as AgyRawEvent), []);
});

test("TestREQ_CB_AGY_001_event_mapper_malformed_json_fails_loud", () => {
  const malformed = [
    "{ not json",
    "42",
    '"a string"',
    "[]",
    '{"foo":1}',
    '{"event":""}',
    '{"event":123}',
  ];
  for (const line of malformed) {
    assert.throws(
      () => parseAgyLine(line),
      (error: unknown) => {
        assert.ok(error instanceof BridgeError, `expected BridgeError for ${line}`);
        assert.equal(error.category, "stream");
        assert.equal(error.code, "CB_STREAM_MAPPING_FAILED");
        return true;
      },
      `line should fail loud: ${line}`,
    );
  }

  const mapper = new AgyEventMapper();
  assert.throws(() => mapper.mapLine("{"), BridgeError);
});

test("TestREQ_CB_AGY_001_event_mapper_known_event_missing_payload_fails_loud", () => {
  const mapper = new AgyEventMapper();
  assert.throws(() => mapper.map({ event: "step_update" } as AgyRawEvent), BridgeError);
  assert.throws(() => mapper.map({ event: "result" } as AgyRawEvent), BridgeError);
  assert.throws(() => mapper.map({ event: "init" } as AgyRawEvent), BridgeError);
});

test("TestREQ_CB_AGY_001_event_mapper_mapLine_captures_session", () => {
  const mapper = new AgyEventMapper();
  const normalized = mapper.mapLine(
    '{"event":"init","conversation_id":"c3b66b04-872b-4fbe-a3a4-058a026ef20a","init":{"cwd":"/p","tools":["run_command","write_to_file"],"permission_mode":"request-review"}}',
  );

  assert.deepEqual(normalized, [
    {
      kind: "session",
      sessionId: "c3b66b04-872b-4fbe-a3a4-058a026ef20a",
      tools: ["run_command", "write_to_file"],
    },
  ]);
  assert.equal(mapper.capturedSessionId, "c3b66b04-872b-4fbe-a3a4-058a026ef20a");
});

// ---------------------------------------------------------------------------
// Capability honesty: the downgrade is declared, and no reasoning parts exist.
// ---------------------------------------------------------------------------

test("TestREQ_CB_AGY_001_event_mapper_capabilities_are_honest", () => {
  const mapper = new AgyEventMapper();
  assert.deepEqual(mapper.capabilities, {
    streamingGranularity: "step",
    partialToolInput: false,
    reasoningStream: false,
    midTurnSteer: false,
    usageAccounting: "cumulative-normalized-at-seam",
  });
  assert.equal(Object.isFrozen(AGY_MAPPER_CAPABILITIES), true);
});

test("TestREQ_CB_AGY_001_event_mapper_emits_no_reasoning_parts", () => {
  const mapper = new AgyEventMapper();
  const conversation = "c1";
  const normalized = [
    ...mapper.map(initEvent(conversation, [])),
    ...mapper.map(stepUpdate(conversation, 0, "DONE", "user_input")),
    ...mapper.map(stepUpdate(conversation, 1, "ACTIVE", "agent_response", { text_delta: "hi" })),
    ...mapper.map(stepUpdate(conversation, 1, "DONE", "agent_response", { text_delta: "\n" })),
    ...mapper.map(stepUpdate(conversation, 2, "DONE", "checkpoint")),
    ...mapper.map(stepUpdate(conversation, 3, "DONE", "tool", { tool_info: { name: "x", parameters: {} } })),
  ];

  const kinds = normalized.map((event) => event.kind);
  assert.ok(!kinds.some((kind) => kind.startsWith("reasoning")), "agy has no thinking stream");
  assert.deepEqual(kinds, ["session", "text-delta", "text-delta", "tool-call"]);
});

test("TestREQ_CB_AGY_001_event_mapper_usage_conversion_ignores_missing_and_invalid", () => {
  assert.deepEqual(toTurnUsage(undefined), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.deepEqual(toTurnUsage({ input_tokens: -5, output_tokens: Number.NaN, cache_read_tokens: 12 }), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 12,
    cacheWriteTokens: 0,
  });
});

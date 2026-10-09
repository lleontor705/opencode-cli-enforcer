/**
 * Oracles for host tool-result delivery (REQ-CB-TOOL-005, D3).
 *
 * Covers the four contract points: exactly-once delivery of a prompt's
 * tool-result parts, an explicit error result for a tool call with no result,
 * fail-loud conversion of malformed content, and the steer-before-result FIFO
 * ordering (REQ-CB-TOOL-004).
 */

import test from "node:test";
import assert from "node:assert/strict";

import type {
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
} from "@ai-sdk/provider";

import { ToolRendezvous, type ToolResult } from "../../src/mcp/rendezvous.js";
import { makePromptStream } from "../../src/provider/prompt-stream.js";
import { QueryContext } from "../../src/provider/query-state.js";
import {
  convertToolResultPart,
  deliverToolResults,
  extractToolResults,
} from "../../src/provider/tool-delivery.js";

function textOf(result: ToolResult): string {
  const block = result.content[0];
  assert.equal(block?.type, "text");
  return block.text;
}

interface ToolResultSpec {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: unknown;
}

function toolResultsPrompt(results: readonly ToolResultSpec[]): LanguageModelV3Prompt {
  return [
    {
      role: "tool",
      content: results.map((result) => ({
        type: "tool-result" as const,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        output: result.output as LanguageModelV3ToolResultOutput,
      })),
    },
  ];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("TestREQ_CB_TOOL_005_prompt_tool_results_delivered", async () => {
  const context = new QueryContext();
  context.resetTurnState();
  context.turnToolCallIds.push("T1", "T2");
  const rendezvous = new ToolRendezvous();
  const first = rendezvous.awaitToolResult("T1", "bash");
  const second = rendezvous.awaitToolResult("T2", "edit");

  const report = await deliverToolResults({
    context,
    rendezvous,
    prompt: toolResultsPrompt([
      { toolCallId: "T1", toolName: "bash", output: { type: "text", value: "R1" } },
      { toolCallId: "T2", toolName: "edit", output: { type: "json", value: { ok: true } } },
    ]),
  });

  assert.deepEqual(report.delivered, ["T1", "T2"], "exactly the two result parts must be enqueued");
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.malformed, []);
  assert.equal(report.steerWritten, false);

  assert.equal(textOf(await first), "R1");
  assert.equal(textOf(await second), '{"ok":true}');
  assert.equal(rendezvous.pendingToolCallCount, 0);
  assert.equal(rendezvous.pendingResultCount, 0);
});

test("TestREQ_CB_TOOL_005_stale_result_for_other_id_is_ignored", () => {
  const extracted = extractToolResults(
    toolResultsPrompt([
      { toolCallId: "T9", toolName: "read", output: { type: "text", value: "stale" } },
    ]),
    ["T1"],
  );
  assert.deepEqual(extracted, [], "a result the turn is not waiting on must not be delivered");
});

test("TestREQ_CB_TOOL_005_missing_result_resolves_with_error", async () => {
  const context = new QueryContext();
  context.resetTurnState();
  context.turnToolCallIds.push("T3");
  const rendezvous = new ToolRendezvous();
  const parked = rendezvous.awaitToolResult("T3", "read");

  const report = await deliverToolResults({
    context,
    rendezvous,
    prompt: [{ role: "user", content: [{ type: "text", text: "continue" }] }],
  });

  assert.deepEqual(report.delivered, []);
  assert.deepEqual(report.missing, ["T3"]);

  const result = await parked;
  assert.equal(result.isError, true, "a missing result must resolve the parked call as an error");
  assert.match(textOf(result), /no tool result was provided for tool call T3/);
});

test("TestREQ_CB_TOOL_005_malformed_content_fails_loud", async () => {
  const context = new QueryContext();
  context.resetTurnState();
  context.turnToolCallIds.push("T4");
  const rendezvous = new ToolRendezvous();
  const parked = rendezvous.awaitToolResult("T4", "bash");

  const report = await deliverToolResults({
    context,
    rendezvous,
    prompt: toolResultsPrompt([
      // A `text` output with no `value` cannot be rendered; it must not become
      // an empty success.
      { toolCallId: "T4", toolName: "bash", output: { type: "text" } },
    ]),
  });

  assert.deepEqual(report.delivered, ["T4"]);
  assert.deepEqual(report.malformed, ["T4"]);

  const result = await parked;
  assert.equal(result.isError, true, "malformed content must surface as an error result, never silence");
  assert.match(textOf(result), /malformed tool result/);
});

test("TestREQ_CB_TOOL_005_conversion_flags_unsupported_output", () => {
  const converted = convertToolResultPart({
    type: "tool-result",
    toolCallId: "T5",
    toolName: "bash",
    output: { type: "nonsense" } as unknown as LanguageModelV3ToolResultOutput,
  });
  assert.equal(converted.malformed, true);
  assert.equal(converted.result.isError, true);
  assert.match(textOf(converted.result), /unsupported output type/);

  const nullOutput = convertToolResultPart({
    type: "tool-result",
    toolCallId: "T6",
    toolName: "bash",
    output: undefined as unknown as LanguageModelV3ToolResultOutput,
  });
  assert.equal(nullOutput.malformed, true);
  assert.equal(nullOutput.result.isError, true);

  const good = convertToolResultPart({
    type: "tool-result",
    toolCallId: "T7",
    toolName: "bash",
    output: { type: "error-text", value: "boom" },
  });
  assert.equal(good.malformed, false);
  assert.equal(good.result.isError, true);
  assert.equal(textOf(good.result), "boom");
});

test("TestREQ_CB_TOOL_005_steer_written_before_results", async () => {
  const context = new QueryContext();
  context.resetTurnState();
  context.turnToolCallIds.push("T1");
  const promptStream = makePromptStream();
  context.promptStream = promptStream;
  const rendezvous = new ToolRendezvous();
  const parked = rendezvous.awaitToolResult("T1", "bash");

  const order: string[] = [];
  let releaseWrite!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let firstWrite = true;
  const pumping = (async () => {
    for await (const _msg of promptStream.stream) {
      order.push("steer-write");
      if (firstWrite) {
        firstWrite = false;
        await gate;
      }
    }
  })();

  const delivery = deliverToolResults({
    context,
    rendezvous,
    prompt: toolResultsPrompt([
      { toolCallId: "T1", toolName: "bash", output: { type: "text", value: "R1" } },
    ]),
    steer: [{ type: "text", text: "please steer" }],
  });
  void parked.then(() => order.push("result"));

  // The steer write is in flight but not finished, so no handler may have
  // resolved: releasing a result first would invert the FIFO and lose the steer.
  await delay(10);
  assert.deepEqual(order, ["steer-write"]);
  assert.equal(rendezvous.pendingToolCallCount, 1, "handler resolved before the steer ack");

  releaseWrite();
  const report = await delivery;
  const result = await parked;
  await Promise.resolve();

  assert.equal(report.steerWritten, true);
  assert.equal(textOf(result), "R1");
  assert.deepEqual(order, ["steer-write", "result"], "the steer must be acked before the result resolves");

  promptStream.end();
  await pumping;
});

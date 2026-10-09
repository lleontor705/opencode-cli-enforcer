/**
 * Unit tests for the ack-carrying stdin prompt stream (REQ-CB-TOOL-004) and the
 * per-query state it is wired into.
 *
 * The consumer here mirrors the SDK's real pump:
 *   for await (const m of stream) { await transport.write(m) }
 * The ack contract only holds against that shape, so the tests exercise it
 * rather than a bare `for await`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { makePromptStream, userMessage } from "../../src/provider/prompt-stream.js";
import { QueryContext } from "../../src/provider/query-state.js";

function text(msg: SDKUserMessage): string {
  const content = msg.message.content;
  if (typeof content === "string") return content;
  const first = content[0];
  return first && first.type === "text" ? first.text : "";
}

/** Drives the stream like the SDK does. `write` may return a promise; the pump
 *  awaits it before pulling the next message. */
function pump(
  stream: AsyncGenerator<SDKUserMessage>,
  write: (msg: SDKUserMessage) => void | Promise<void>,
): Promise<void> {
  return (async () => {
    for await (const msg of stream) await write(msg);
  })();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fails the race instead of hanging when a rejected push never settles. */
function withHangGuard<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("push hung")), 200)),
  ]);
}

test("TestREQ_CB_TOOL_004_steer_ack_fifo", async () => {
  const ps = makePromptStream();
  const written: string[] = [];
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let firstWrite = true;
  const pumping = pump(ps.stream, async (msg) => {
    written.push(text(msg));
    if (firstWrite) {
      firstWrite = false;
      await writeGate;
    }
  });

  let acked = false;
  const steerAck = ps
    .push(userMessage([{ type: "text", text: "steer" }], "next"))
    .then(() => {
      acked = true;
    });

  // The write is in flight but not finished, so the ack must not have resolved:
  // releasing a tool result before the steer hits stdin would invert the FIFO.
  await delay(10);
  assert.deepEqual(written, ["steer"]);
  assert.equal(acked, false, "steer ack resolved before its stdin write completed");

  releaseWrite();
  await steerAck;
  assert.equal(acked, true);

  // Only now may the tool-result write land; on the same stdin FIFO it is
  // therefore ordered after the steer.
  await ps.push(userMessage([{ type: "text", text: "tool-result" }]));
  ps.end();
  await pumping;

  assert.deepEqual(written, ["steer", "tool-result"]);
});

test("TestREQ_CB_TOOL_004_push_delivers_in_order_and_end_drains", async () => {
  const ps = makePromptStream();
  const written: string[] = [];
  const pumping = pump(ps.stream, (msg) => {
    written.push(text(msg));
  });

  await ps.push(userMessage([{ type: "text", text: "first" }]));
  await ps.push(userMessage([{ type: "text", text: "second" }]));
  ps.end();
  await pumping;

  assert.deepEqual(written, ["first", "second"]);
});

test("TestREQ_CB_TOOL_004_user_message_omits_uuid_and_carries_priority", () => {
  const msg = userMessage([{ type: "text", text: "steer" }], "next");
  assert.equal(msg.type, "user");
  assert.equal(msg.priority, "next");
  assert.equal(msg.parent_tool_use_id, null);
  // uuid is deliberately omitted — no dedup needed, and supplying one makes CC's
  // stdin loop do a session lookup on the message.
  assert.equal("uuid" in msg, false);

  const noPriority = userMessage([{ type: "text", text: "plain" }]);
  assert.equal("priority" in noPriority, false);
});

test("TestREQ_CB_TOOL_004_push_after_end_rejects_immediately", async () => {
  const ps = makePromptStream();
  const pumping = pump(ps.stream, () => {});
  ps.end();
  await pumping;

  // A steer racing end-of-turn must fail fast: an unsettled ack would wedge
  // tool-result delivery forever.
  await assert.rejects(withHangGuard(ps.push(userMessage([{ type: "text", text: "late" }]))), /closed/);
});

test("TestREQ_CB_TOOL_004_fail_settles_queued_and_inflight_acks", async () => {
  const ps = makePromptStream();
  // A pump that never finishes its write models a CLI that died mid-write.
  const pumping = pump(ps.stream, () => new Promise<void>(() => {}));

  const inflight = ps.push(userMessage([{ type: "text", text: "inflight" }]));
  await delay(10);
  const queued = ps.push(userMessage([{ type: "text", text: "queued" }]));

  ps.fail(new Error("query ended"));

  await assert.rejects(inflight, /query ended/);
  await assert.rejects(queued, /query ended/);
  await assert.rejects(ps.push(userMessage([{ type: "text", text: "after" }])), /query ended/);
  void pumping;
});

test("TestREQ_CB_TOOL_004_abandoned_pump_rejects_inflight_and_later_pushes", async () => {
  const ps = makePromptStream();
  const inflight = ps.push(userMessage([{ type: "text", text: "abandoned" }]));

  // `break` in the pump calls gen.return(), which resumes the parked yield as a
  // return and must settle the in-flight ack rather than leave it hanging.
  const pumping = (async () => {
    for await (const _msg of ps.stream) break;
  })();

  await assert.rejects(inflight, /closed/);
  await pumping;

  // Nothing is left to drain the queue, so a later push has to reject rather
  // than park — a parked ack wedges tool-result delivery forever.
  await assert.rejects(
    withHangGuard(ps.push(userMessage([{ type: "text", text: "later" }]))),
    /closed/,
  );
});

test("TestREQ_CB_TOOL_004_first_failure_wins", async () => {
  const ps = makePromptStream();
  // fail() propagates into the generator, so the pump rejects too.
  const pumping = assert.rejects(pump(ps.stream, () => {}), /CLI exited with code 1/);
  const queued = ps.push(userMessage([{ type: "text", text: "queued" }]));

  // The provider's catch reports the real cause, then its finally fails the
  // stream again with a generic message.
  ps.fail(new Error("CLI exited with code 1"));
  ps.fail(new Error("query ended"));

  await assert.rejects(queued, /CLI exited with code 1/);
  await assert.rejects(
    ps.push(userMessage([{ type: "text", text: "after" }])),
    /CLI exited with code 1/,
  );
  await pumping;
});

test("TestREQ_CB_TOOL_004_query_context_state_is_per_query", () => {
  const a = new QueryContext();
  const b = new QueryContext();

  a.historyStale = true;
  a.missedSteer = true;
  a.latestCursor = 7;
  a.turnToolCallIds.push("t1");

  assert.equal(b.historyStale, false, "historyStale must never be shared between queries");
  assert.equal(b.missedSteer, false);
  assert.equal(b.latestCursor, 0);
  assert.deepEqual(b.turnToolCallIds, []);
  assert.equal(a.promptStream, null);
  assert.equal(a.activeQuery, null);
  assert.equal(b.promptStream, null);
  assert.notEqual(a.pendingToolCalls, b.pendingToolCalls);
  assert.notEqual(a.pendingResults, b.pendingResults);
  assert.notEqual(a.turnToolCallIds, b.turnToolCallIds);
});

test("TestREQ_CB_TOOL_004_reset_turn_state_keeps_turn_tool_call_ids", () => {
  const ctx = new QueryContext();
  ctx.resetTurnState();
  ctx.turnStarted = true;
  ctx.turnSawStreamEvent = true;
  ctx.turnSawToolCall = true;
  ctx.turnStreamOpen = true;
  ctx.turnStreamMessageId = "m1";
  ctx.turnStreamBlockStart = 3;
  ctx.turnToolCallIds.push("t1");

  ctx.resetTurnState();

  assert.equal(ctx.turnStarted, false);
  assert.equal(ctx.turnSawStreamEvent, false);
  assert.equal(ctx.turnSawToolCall, false);
  assert.equal(ctx.turnStreamOpen, false);
  assert.equal(ctx.turnStreamMessageId, undefined);
  assert.equal(ctx.turnStreamBlockStart, 0);
  assert.deepEqual(ctx.turnBlocks, []);
  // Persists across reset so results stay routable within one assistant message.
  assert.deepEqual(ctx.turnToolCallIds, ["t1"]);
});

test("TestREQ_CB_TOOL_004_turn_blocks_requires_reset", () => {
  const ctx = new QueryContext();
  assert.throws(() => ctx.turnBlocks, /resetTurnState/);
  ctx.resetTurnState();
  assert.deepEqual(ctx.turnBlocks, []);
});

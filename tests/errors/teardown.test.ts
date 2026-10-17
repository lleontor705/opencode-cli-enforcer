/**
 * Oracles for abort/teardown and leak assertions (REQ-CB-ERR-001, D9).
 *
 * Covers the three contract points: an abort settles every parked handler and
 * queued/in-flight prompt ack and leaves zero leaks; a normal turn end tears
 * down clean; and a simulated leak is a fail-loud error that names it. The
 * resolve-never-reject rule for parked handlers is asserted directly.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  LiveQueries,
  TEARDOWN_REASON,
  TeardownLeakError,
  reportLeaks,
  scanLeaks,
  teardownQuery,
} from "../../src/errors/teardown.js";
import { ToolRendezvous } from "../../src/mcp/rendezvous.js";
import { makePromptStream, userMessage } from "../../src/provider/prompt-stream.js";
import { QueryContext } from "../../src/provider/query-state.js";
import { MirrorRegistry } from "../../src/session/mirror.js";

function fakeQuery(log: string[]): { interrupt: () => Promise<void>; close: () => void } {
  return {
    interrupt() {
      log.push("interrupt");
      return Promise.resolve();
    },
    close() {
      log.push("close");
    },
  };
}

/** Bound an await so a missed settle is a fast assertion failure, not a hung run. */
async function withDeadline<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("oracle deadline exceeded: awaited settle never arrived")), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("TestREQ_CB_ERR_001_abort_teardown_no_leaks", async () => {
  const context = new QueryContext();
  context.resetTurnState();
  const log: string[] = [];
  context.activeQuery = fakeQuery(log);
  const promptStream = makePromptStream();
  context.promptStream = promptStream;
  const rendezvous = new ToolRendezvous();
  const parked = rendezvous.awaitToolResult("T1", "bash");
  const live = new LiveQueries();
  live.track(context);

  // Consumer receives one prompt then blocks: that ack is parked at the yield
  // (in flight), while the second push waits in the queue.
  let gotFirst!: () => void;
  const firstReceived = new Promise<void>((resolve) => {
    gotFirst = resolve;
  });
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let consumerError: unknown;
  const consuming = (async () => {
    try {
      for await (const _msg of promptStream.stream) {
        gotFirst();
        await gate;
      }
    } catch (error) {
      consumerError = error;
    }
  })();

  const inflight = promptStream.push(userMessage("first"));
  await firstReceived;
  const queued = promptStream.push(userMessage("second"));

  const outcome = teardownQuery({
    context,
    rendezvous,
    liveQueries: live,
    reason: "cli-providers: aborted",
  });

  // Every ack settles — the in-flight one and the queued one — rather than hanging.
  await assert.rejects(withDeadline(inflight), /aborted/);
  await assert.rejects(withDeadline(queued), /aborted/);

  // The parked handler is resolved with a text error result, never rejected.
  const released = await withDeadline(parked);
  assert.equal(released.isError, true);
  assert.equal(released.content[0]?.text, "cli-providers: aborted");

  assert.equal(outcome.queryAborted, true);
  assert.equal(outcome.promptStreamFailed, true);
  assert.equal(outcome.handlersReleased, 1);
  assert.equal(outcome.mirrorRotated, false);
  assert.deepEqual(log, ["interrupt", "close"]);
  assert.equal(rendezvous.pendingToolCallCount, 0);
  assert.equal(rendezvous.pendingResultCount, 0);
  assert.equal(context.activeQuery, null);
  assert.equal(context.promptStream, null);

  releaseGate();
  await withDeadline(consuming);
  assert.equal(consumerError instanceof Error, true, "the failed stream must surface as an error");
  assert.match((consumerError as Error).message, /aborted/);

  const report = reportLeaks("abort", { context, rendezvous, liveQueries: live });
  assert.deepEqual(report.leaks, []);
  assert.equal(live.size, 0, "teardown must release the context from the live set");
});

test("TestREQ_CB_ERR_001_normal_completion_no_leaks", async () => {
  const context = new QueryContext();
  context.resetTurnState();
  context.activeQuery = fakeQuery([]);
  const promptStream = makePromptStream();
  context.promptStream = promptStream;
  const rendezvous = new ToolRendezvous();
  const live = new LiveQueries();
  live.track(context);

  const seen: string[] = [];
  const consuming = (async () => {
    for await (const msg of promptStream.stream) {
      const content = msg.message.content;
      seen.push(typeof content === "string" ? content : "[blocks]");
    }
  })();

  await promptStream.push(userMessage("turn one"));
  promptStream.end();
  await consuming;

  const outcome = teardownQuery({
    context,
    rendezvous,
    liveQueries: live,
    reason: "cli-providers: turn complete",
  });

  assert.deepEqual(seen, ["turn one"]);
  assert.equal(outcome.promptStreamFailed, true);
  assert.equal(outcome.handlersReleased, 0);
  assert.equal(rendezvous.pendingToolCallCount, 0);
  assert.equal(live.size, 0);

  const report = reportLeaks("normal-completion", { context, rendezvous, liveQueries: live });
  assert.deepEqual(report.leaks, []);

  // Teardown is idempotent: a second path over the same context is a clean no-op.
  const second = teardownQuery({ context, rendezvous, liveQueries: live });
  assert.equal(second.queryAborted, false);
  assert.equal(second.promptStreamFailed, false);
  assert.equal(second.handlersReleased, 0);
  assert.deepEqual(reportLeaks("normal-completion-idempotent", { context, rendezvous }).leaks, []);
});

test("TestREQ_CB_ERR_001_teardown_clears_per_query_state", () => {
  const context = new QueryContext();
  context.resetTurnState();
  context.pendingToolCalls.set("h1", { toolName: "bash", resolve: () => {} });
  context.pendingResults.set("r1", { content: [{ type: "text", text: "buffered" }] });
  context.turnToolCallIds.push("T1");
  context.rateLimitRejection = { rateLimitType: "five_hour" };
  context.lastRateLimitWarnStep = 2;
  context.lastRateLimitWarnThreshold = 5;
  context.historyStale = true;
  context.missedSteer = true;
  context.turnStarted = true;
  context.turnSawStreamEvent = true;
  context.turnSawToolCall = true;
  context.turnStreamMessageId = "msg-1";
  context.turnStreamOpen = true;
  context.turnStreamBlockStart = 3;

  teardownQuery({ context });

  assert.equal(context.pendingToolCalls.size, 0);
  assert.equal(context.pendingResults.size, 0);
  assert.deepEqual(context.turnToolCallIds, []);
  assert.equal(context.rateLimitRejection, null);
  assert.equal(context.lastRateLimitWarnStep, null);
  assert.equal(context.lastRateLimitWarnThreshold, undefined);
  assert.equal(context.historyStale, false);
  assert.equal(context.missedSteer, false);
  assert.equal(context.turnOutput, null);
  assert.equal(context.turnStarted, false);
  assert.equal(context.turnSawStreamEvent, false);
  assert.equal(context.turnSawToolCall, false);
  assert.equal(context.turnStreamMessageId, undefined);
  assert.equal(context.turnStreamOpen, false);
  assert.equal(context.turnStreamBlockStart, 0);
});

test("TestREQ_CB_ERR_001_leak_assertion_names_leak", async () => {
  const context = new QueryContext();
  context.resetTurnState();
  const rendezvous = new ToolRendezvous();

  // Simulated bug: a handler parked and never released by teardown.
  const stranded = rendezvous.awaitToolResult("leak-1", "bash");
  assert.throws(
    () => reportLeaks("abort", { context, rendezvous }),
    (error: unknown) => {
      assert.ok(error instanceof TeardownLeakError);
      assert.equal(error.name, "TeardownLeakError");
      assert.equal(error.category, "stream");
      assert.match(error.message, /pending tool handler/);
      assert.equal(error.leaks.length, 1);
      return true;
    },
  );

  // Every other leaked artifact is named too.
  context.activeQuery = fakeQuery([]);
  context.promptStream = makePromptStream();
  const report = scanLeaks({ context, rendezvous, liveQueries: new LiveQueries() });
  assert.ok(report.leaks.some((leak) => /dangling query/.test(leak)), report.leaks.join("; "));
  assert.ok(report.leaks.some((leak) => /unended prompt stream/.test(leak)), report.leaks.join("; "));

  // A context still tracked as live is itself a leak.
  const live = new LiveQueries();
  live.track(context);
  const liveReport = scanLeaks({ context, liveQueries: live });
  assert.ok(liveReport.leaks.some((leak) => /unreleased query context/.test(leak)), liveReport.leaks.join("; "));

  // Clean the stranded handler so the pending test does not hold a live promise.
  rendezvous.releasePendingToolCalls(TEARDOWN_REASON);
  await stranded;
});

test("TestREQ_CB_ERR_001_teardown_force_rotates_mirror", () => {
  const context = new QueryContext();
  const mirror = new MirrorRegistry();
  mirror.set("s1", { ccSessionId: "cc-1", latestCursor: 3, needsRebuild: false, phase: "aligned" });

  const outcome = teardownQuery({ context, mirror, sessionId: "s1" });
  assert.equal(outcome.mirrorRotated, true);
  assert.equal(mirror.get("s1")?.phase, "quarantined");

  const plan = mirror.planTurn("s1", { priorMessages: [], historyStale: false });
  assert.equal(plan.transition, "force-rotate");

  // A mirror-less (or unknown-session) teardown is a clean no-op on the mirror.
  assert.equal(teardownQuery({ context, mirror, sessionId: "missing" }).mirrorRotated, false);
  assert.equal(teardownQuery({ context }).mirrorRotated, false);
});

test("TestREQ_CB_ERR_001_release_resolves_never_rejects", async () => {
  const rendezvous = new ToolRendezvous();
  const first = rendezvous.awaitToolResult("A", "read");
  const second = rendezvous.awaitToolResult("B", "edit");
  // A result buffered before its call must also be dropped by release.
  rendezvous.deliverToolResult("C", { content: [{ type: "text", text: "buffered" }] });
  assert.equal(rendezvous.pendingResultCount, 1);

  const released = teardownQuery({ context: new QueryContext(), rendezvous, reason: "gone" });
  assert.equal(released.handlersReleased, 2);

  for (const result of await withDeadline(Promise.all([first, second]))) {
    assert.equal(result.isError, true);
    assert.equal(result.content[0]?.type, "text");
    assert.equal(result.content[0]?.text, "gone");
  }
  assert.equal(rendezvous.pendingToolCallCount, 0);
  assert.equal(rendezvous.pendingResultCount, 0);
});

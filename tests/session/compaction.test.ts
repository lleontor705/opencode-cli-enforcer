/**
 * Oracles for the compaction summarizer lane (REQ-CB-CMPR-001, D7).
 *
 * Covers the three contract points: a healthy lane sets `result.summary` +
 * `tokens` so the host skips its model call, a lane failure leaves `result`
 * unset so the host default compaction proceeds and reports a taxonomy code,
 * and the lane runs as a fresh isolated query sharing no state with the parked
 * session query.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionCompaction } from "@opencode/plugin/promise/session";

import {
  buildSummaryPrompt,
  buildSummarizerOptions,
  classifyCompactionLaneError,
  createCompactionHandler,
  type SummarizerSpawner,
} from "../../src/session/compaction.js";
import type { BridgeError } from "../../src/errors/taxonomy.js";
import { QueryContext } from "../../src/provider/query-state.js";
import { makePromptStream } from "../../src/provider/prompt-stream.js";

const HEALTHY_USAGE = {
  input_tokens: 120,
  output_tokens: 30,
  cache_read_input_tokens: 5,
  cache_creation_input_tokens: 3,
  output_tokens_details: { thinking_tokens: 7 },
};

const EXPECTED_TOKENS = {
  input: 120,
  output: 30,
  reasoning: 7,
  cache: { read: 5, write: 3 },
};

function assistantMessage(text: string): SDKMessage {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    session_id: "summarizer-session",
    uuid: "summarizer-assistant",
  } as unknown as SDKMessage;
}

function resultMessage(text: string, usage: unknown = HEALTHY_USAGE): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    usage,
    session_id: "summarizer-session",
    num_turns: 1,
  } as unknown as SDKMessage;
}

interface SpawnCall {
  readonly prompt: string;
  readonly options: Record<string, unknown>;
}

interface RecordingSpawner {
  readonly spawn: SummarizerSpawner;
  readonly calls: SpawnCall[];
}

function recordingSpawner(messages: readonly SDKMessage[]): RecordingSpawner {
  const calls: SpawnCall[] = [];
  const spawn: SummarizerSpawner = (params) => {
    calls.push(params as SpawnCall);
    return (async function* () {
      for (const message of messages) yield message;
    })() as AsyncIterable<SDKMessage>;
  };
  return { spawn, calls };
}

function recordingModel(): { state: { calls: number }; doStream: () => Promise<unknown> } {
  const state = { calls: 0 };
  return {
    state,
    doStream: async () => {
      state.calls += 1;
      return {};
    },
  };
}

function compactionInput(): SessionCompaction {
  return {
    sessionID: "ses_compaction",
    agent: "build",
    model: { providerID: "claude-bridge", modelID: "claude-sonnet-4" },
    system: [{ type: "text", text: "You are a coding assistant." }],
    messages: [
      { id: "m1", role: "user", content: [{ type: "text", text: "Implement the parser." }] },
      { id: "m2", role: "assistant", content: [{ type: "text", text: "Parser implemented." }] },
    ],
    options: {},
    tools: {},
  } as unknown as SessionCompaction;
}

/**
 * Faithful stand-in for the host: it runs the hook and, only when the hook left
 * `result` unset, falls back to the provider model for default compaction.
 */
async function hostCompaction(
  handler: (input: SessionCompaction) => Promise<void>,
  input: SessionCompaction,
  model: { doStream: () => Promise<unknown> },
): Promise<"hook" | "default"> {
  await handler(input);
  if (input.result !== undefined) return "hook";
  await model.doStream();
  return "default";
}

test("TestREQ_CB_CMPR_001_compaction_lane_sets_result", async (t) => {
  await t.test("a healthy lane sets result and skips the host model call", async () => {
    const { spawn, calls } = recordingSpawner([resultMessage("A concise summary.")]);
    const failures: BridgeError[] = [];
    const handler = createCompactionHandler({ spawn, reportFailure: (error) => failures.push(error) });
    const input = compactionInput();
    const model = recordingModel();

    const outcome = await hostCompaction(handler, input, model);

    assert.equal(outcome, "hook");
    assert.ok(input.result, "result must be set on a healthy lane");
    assert.equal(input.result.summary, "A concise summary.");
    assert.deepEqual(input.result.tokens, EXPECTED_TOKENS);
    assert.deepEqual(input.result.metadata, { "claude-bridge": { compaction: "isolated-summarizer" } });
    assert.equal(model.state.calls, 0, "no claude-bridge model call may happen for compaction");
    assert.deepEqual(failures, []);

    assert.equal(calls.length, 1, "exactly one isolated lane spawn");
    assert.equal(typeof calls[0].prompt, "string");
    assert.ok(
      calls[0].prompt.includes("Implement the parser."),
      "the summary prompt must carry the host conversation",
    );
    assert.ok(
      calls[0].prompt.includes("You are a coding assistant."),
      "the summary prompt must carry the host system context",
    );
    assert.equal(calls[0].options.persistSession, false);
    assert.equal(calls[0].options.maxTurns, 1);
    assert.deepEqual(calls[0].options.tools, []);
    assert.equal(calls[0].options.resume, undefined);
    assert.equal(calls[0].options.mcpServers, undefined);
  });

  await t.test("the summary falls back to streamed assistant text", async () => {
    const { spawn } = recordingSpawner([assistantMessage("streamed summary"), resultMessage("")]);
    const handler = createCompactionHandler({ spawn, reportFailure: () => {} });
    const input = compactionInput();
    const model = recordingModel();

    const outcome = await hostCompaction(handler, input, model);

    assert.equal(outcome, "hook");
    assert.equal(input.result?.summary, "streamed summary");
    assert.equal(model.state.calls, 0);
  });

  await t.test("the summarizer config is an isolated one-off query with a scrubbed env", () => {
    const options = buildSummarizerOptions({
      baseEnv: { ANTHROPIC_API_KEY: "must-not-leak", PATH: "/usr/bin" },
    });
    const env = options.env as Record<string, string | undefined>;

    assert.equal(options.persistSession, false, "the lane must never persist a session");
    assert.equal(options.maxTurns, 1);
    assert.deepEqual(options.tools, []);
    assert.deepEqual(options.settingSources, [], "filesystem settings are disabled");
    assert.equal(options.env.ANTHROPIC_API_KEY, undefined, "ANTHROPIC_* must be scrubbed");
    assert.equal(env.DISABLE_AUTO_COMPACT, "1");
    assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, "0");

    const prompt = buildSummaryPrompt(compactionInput());
    assert.ok(prompt.includes("Parser implemented."));

    const classified = classifyCompactionLaneError(Object.assign(new Error("spawn x ENOENT"), { code: "ENOENT" }));
    assert.equal(classified.code, "CB_TRANSPORT_SPAWN_FAILED");
    assert.equal(classified.category, "transport");
  });

  await t.test("a missing child leaves result unset, proceeds by default, and reports a taxonomy code", async () => {
    const childError = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT", errno: -2 });
    const spawn: SummarizerSpawner = () => {
      throw childError;
    };
    const failures: BridgeError[] = [];
    const handler = createCompactionHandler({ spawn, reportFailure: (error) => failures.push(error) });
    const input = compactionInput();
    const model = recordingModel();

    const outcome = await hostCompaction(handler, input, model);

    assert.equal(outcome, "default", "the host default compaction must proceed");
    assert.equal(input.result, undefined, "result must stay unset on lane failure");
    assert.equal(model.state.calls, 1, "the default path still calls the model");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, "CB_TRANSPORT_SPAWN_FAILED");
    assert.equal(failures[0].category, "transport");
  });

  await t.test("an empty summary is a stream failure, logged with its code by default", async () => {
    const { spawn } = recordingSpawner([resultMessage("")]);
    const input = compactionInput();
    const model = recordingModel();
    const logged: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      logged.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      const handler = createCompactionHandler({ spawn });
      const outcome = await hostCompaction(handler, input, model);
      assert.equal(outcome, "default");
      assert.equal(input.result, undefined);
    } finally {
      console.warn = original;
    }
    assert.equal(logged.length, 1);
    assert.match(logged[0], /CB_STREAM_MAPPING_FAILED/);
  });

  await t.test("the lane shares no state with the parked session query", async () => {
    const parked = new QueryContext();
    const parkedStream = makePromptStream();
    const parkedSentinel = { parked: true };
    parked.activeQuery = parkedSentinel;
    parked.promptStream = parkedStream;
    parked.historyStale = true;
    parked.latestCursor = 7;

    let parkedEnds = 0;
    let parkedFails = 0;
    const originalEnd = parkedStream.end;
    const originalFail = parkedStream.fail;
    parkedStream.end = () => {
      parkedEnds += 1;
      originalEnd();
    };
    parkedStream.fail = (error) => {
      parkedFails += 1;
      originalFail(error);
    };

    const { spawn, calls } = recordingSpawner([resultMessage("isolated summary")]);
    const handler = createCompactionHandler({ spawn, reportFailure: () => {} });
    const input = compactionInput();

    await handler(input);

    assert.equal(calls.length, 1, "exactly one isolated lane spawn");
    assert.equal(calls[0].options.persistSession, false);
    assert.deepEqual(calls[0].options.tools, []);
    assert.equal(calls[0].options.resume, undefined);
    assert.equal(calls[0].options.mcpServers, undefined);
    assert.equal(typeof calls[0].prompt, "string");

    assert.equal(parked.activeQuery, parkedSentinel, "the parked query handle is untouched");
    assert.equal(parked.promptStream, parkedStream, "the parked prompt stream is untouched");
    assert.equal(parked.historyStale, true);
    assert.equal(parked.latestCursor, 7);
    assert.equal(parkedEnds, 0, "the parked prompt stream must not be ended");
    assert.equal(parkedFails, 0, "the parked prompt stream must not be failed");
    assert.ok(input.result, "the isolated lane still satisfies compaction");
  });
});

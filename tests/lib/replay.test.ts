/**
 * Replay-fixture oracles (cb-16, REQ-CB-STRM-001..003).
 *
 * Every case here is driven by a committed fixture under
 * tests/fixtures/sdk-streams/ replayed through the shared harness. Nothing
 * spawns a Claude Code child: the adapter path injects a transport fake that
 * yields the fixture frames, so the whole suite is hermetic and deterministic.
 *
 * Coverage: happy path (text/thinking signature/usage), parallel tool_use,
 * `<synthetic>` + abandoned (restreamed/fallback) blocks, rate-limit 5% dedupe
 * with is_error correlation, and the schema-versioned recorder pipeline.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertFixtureHeader,
  finishUsage,
  FIXTURE_SCHEMA_VERSION,
  listFixtures,
  loadFixture,
  partTypes,
  partsOfType,
  parseFixtureText,
  replayFixtureDirect,
  replayFixtureThroughAdapter,
  serializeFixture,
  textDelta,
  toLanguageModelV3Usage,
} from "./replay.mjs";
import { recordScenario } from "./record-sdk-streams.mjs";

const TEXT_TURN_USAGE = { inputTokens: 10, outputTokens: 42, cacheReadTokens: 0, cacheWriteTokens: 100 };
const PARALLEL_TOOLS_USAGE = { inputTokens: 12, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 4 };

function streamStart(): { type: "stream-start"; warnings: never[] } {
  return { type: "stream-start", warnings: [] };
}

// ---------------------------------------------------------------------------
// Fixture artifact contract.
// ---------------------------------------------------------------------------

test("TestREQ_CB_STRM_001_fixtures_carry_a_schema_versioned_header", () => {
  const names = listFixtures();
  for (const required of ["text-turn", "parallel-tools", "synthetic-abandoned", "rate-limit"]) {
    assert.ok(names.includes(required), `fixture "${required}" must be committed`);
  }
  for (const name of names) {
    const { header } = loadFixture(name);
    assert.ok(header, `fixture "${name}" must carry a header`);
    assert.equal(header.schemaVersion, FIXTURE_SCHEMA_VERSION);
    assert.equal(header.name, name);
  }

  assert.throws(
    () => assertFixtureHeader({ fixture: "sdk-stream", schemaVersion: 99 }, "future"),
    /schema version 99 is not supported/,
  );
});

test("TestREQ_CB_STRM_001_fixture_serialization_round_trips", () => {
  const body = serializeFixture({ name: "round-trip", frames: [{ a: 1 }, { b: 2 }], source: "hand-authored" });
  const parsed = parseFixtureText(body);
  assert.equal(parsed.header?.name, "round-trip");
  assert.equal(parsed.header?.schemaVersion, FIXTURE_SCHEMA_VERSION);
  assert.deepEqual(parsed.frames, [{ a: 1 }, { b: 2 }]);
});

// ---------------------------------------------------------------------------
// REQ-CB-STRM-001: SDK events -> LMV3 parts (happy path, usage, signatures).
// ---------------------------------------------------------------------------

test("TestREQ_CB_STRM_001_text_turn_maps_to_lmv3_parts_with_usage", () => {
  const { parts } = replayFixtureDirect("text-turn");

  assert.deepEqual(partTypes(parts), [
    "reasoning-start",
    "reasoning-delta",
    "reasoning-end",
    "text-start",
    "text-delta",
    "text-delta",
    "text-end",
    "finish",
  ]);
  assert.equal(textDelta(parts), "Hello world");

  const reasoningEnd = partsOfType(parts, "reasoning-end")[0] as {
    providerMetadata?: Record<string, Record<string, unknown>>;
  };
  assert.equal(reasoningEnd.providerMetadata?.["claude"]?.signature, "sig-thinking-0001");

  assert.deepEqual(finishUsage(parts), toLanguageModelV3Usage(TEXT_TURN_USAGE));
  const finish = partsOfType(parts, "finish")[0] as { finishReason: { unified: string; raw: string } };
  assert.equal(finish.finishReason.unified, "stop");
});

test("TestREQ_CB_STRM_001_parallel_tool_use_emits_distinct_sanitized_ids", () => {
  const { parts } = replayFixtureDirect("parallel-tools");

  const calls = partsOfType(parts, "tool-call") as Array<{ toolCallId: string; toolName: string; input: string }>;
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.toolCallId), ["toolu_alpha", "toolu_beta"]);
  assert.equal(new Set(calls.map((call) => call.toolCallId)).size, 2);
  assert.deepEqual(calls.map((call) => JSON.parse(call.input)), [{ path: "a.txt" }, { path: "b.txt" }]);

  const finish = partsOfType(parts, "finish")[0] as { finishReason: { unified: string } };
  assert.equal(finish.finishReason.unified, "tool-calls");
  assert.deepEqual(finishUsage(parts), toLanguageModelV3Usage(PARALLEL_TOOLS_USAGE));
});

// ---------------------------------------------------------------------------
// REQ-CB-STRM-002: synthetic + abandoned blocks stay off-stream.
// ---------------------------------------------------------------------------

test("TestREQ_CB_STRM_002_synthetic_and_abandoned_blocks_are_dropped", () => {
  const { parts } = replayFixtureDirect("synthetic-abandoned");

  assert.deepEqual(partTypes(parts), [
    "text-start",
    "text-delta",
    "text-start",
    "text-delta",
    "text-start",
    "text-delta",
    "text-end",
    "finish",
  ]);

  const serialized = JSON.stringify(parts);
  assert.ok(!serialized.includes("synthetic"), "no part may be emitted from a <synthetic> message");

  const deltas = partsOfType(parts, "text-delta") as Array<{ delta: string }>;
  assert.equal(deltas.filter((part) => part.delta === "recovered answer").length, 1, "fallback text must not duplicate");
  assert.equal(partsOfType(parts, "text-end").length, 1, "abandoned blocks must never reach text-end");
  assert.equal(textDelta(parts), "half-ahalf-brecovered answer");
});

// ---------------------------------------------------------------------------
// REQ-CB-STRM-003: rate-limit dedupe and is_error surfacing.
// ---------------------------------------------------------------------------

test("TestREQ_CB_STRM_003_rate_limit_dedupes_and_is_error_surfaces", () => {
  const fixture = loadFixture("rate-limit");
  const warnings: string[] = [];
  const mapperOptions = { notify: (message: string) => warnings.push(message) };
  const { parts } = replayFixtureDirect("rate-limit", { mapperOptions });

  assert.equal(warnings.length, 2, "one 5% bucket warning plus one rejection warning, no repeat");
  assert.ok(warnings.some((message) => /45%/.test(message)));
  assert.ok(warnings.some((message) => /rate limited/i.test(message)));

  assert.deepEqual(partTypes(parts), ["error"]);
  const error = (parts[0] as { error: { code: string; message: string } }).error;
  assert.equal(error.code, "CB_RATE_LIMIT_EXCEEDED");
  assert.match(error.message, /rate limit/i);
  assert.match(error.message, /You're out of extra usage/);
  assert.ok(fixture.header, "fixture header is required for the schema check above");
});

// ---------------------------------------------------------------------------
// Determinism + adapter parity: same fixture -> identical LMV3 sequence.
// ---------------------------------------------------------------------------

test("TestREQ_CB_STRM_001_replay_is_deterministic_across_runs", () => {
  for (const name of ["text-turn", "synthetic-abandoned"]) {
    const first = replayFixtureDirect(name).parts;
    const second = replayFixtureDirect(name).parts;
    assert.deepEqual(second, first, `${name} must replay identically`);
  }
});

test("TestREQ_CB_STRM_001_adapter_replay_matches_direct_mapping", async () => {
  for (const name of ["text-turn", "synthetic-abandoned"]) {
    const direct = replayFixtureDirect(name).parts;
    const replayed = await replayFixtureThroughAdapter(name);
    assert.deepEqual(replayed.parts, [streamStart(), ...direct], `${name} adapter parity`);
  }
});

test("TestREQ_CB_STRM_001_adapter_finishes_tool_turn_at_the_sdk_boundary", async () => {
  const direct = replayFixtureDirect("parallel-tools");
  assert.deepEqual(partTypes(direct.parts).slice(0, 5), [
    "tool-input-start",
    "tool-input-delta",
    "tool-input-delta",
    "tool-input-end",
    "tool-call",
  ]);

  const replayed = await replayFixtureThroughAdapter("parallel-tools");
  const types = partTypes(replayed.parts);
  assert.equal(types.at(-1), "finish", "the tool step must close with a finish");
  assert.equal(types.filter((type) => type === "finish").length, 1);
  assert.equal(types.filter((type) => type === "tool-call").length, 2);
  const finish = replayed.parts.at(-1) as { finishReason: { unified: string } };
  assert.equal(finish.finishReason.unified, "tool-calls");
});

test("TestREQ_CB_STRM_003_adapter_replay_matches_direct_mapping", async () => {
  const direct = replayFixtureDirect("rate-limit", { mapperOptions: { notify: () => {} } }).parts;
  const replayed = await replayFixtureThroughAdapter("rate-limit", { notify: () => {} });
  assert.deepEqual(replayed.parts, [streamStart(), ...direct]);
});

// ---------------------------------------------------------------------------
// Recorder pipeline (no live CLI): scrub + schema-versioned fixture write.
// ---------------------------------------------------------------------------

test("TestREQ_CB_STRM_001_recorder_writes_a_scrubbed_schema_versioned_fixture", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cb-replay-"));
  const workdir = join(dir, "workdir");

  async function* fakeQuery() {
    yield {
      type: "system",
      subtype: "init",
      session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      cwd: workdir,
      slash_commands: ["/secret-command"],
      agents: ["local-agent"],
      tools: [],
      model: "claude-haiku-4-5",
      permissionMode: "bypassPermissions",
      mcp_servers: [{ name: "opencode", status: "connected" }],
      uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    yield {
      type: "stream_event",
      event: { type: "message_start", message: { id: "msg_rec_1", usage: { input_tokens: 1, output_tokens: 1 } } },
      session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      uuid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    };
    yield {
      type: "assistant",
      message: {
        id: "msg_rec_1",
        content: [{ type: "text", text: `wrote ${join(workdir, "file.txt")}` }],
      },
      session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      uuid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    };
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      usage: { input_tokens: 1, output_tokens: 5 },
    };
  }

  const result = await recordScenario({
    name: "recorded-probe",
    prompt: "probe",
    queryImpl: fakeQuery,
    fixturesDir: dir,
    workdir,
    now: () => "2026-10-09T00:00:00.000Z",
  });

  assert.equal(result.count, 4);
  const body = readFileSync(join(dir, "recorded-probe.jsonl"), "utf8");
  const parsed = parseFixtureText(body);
  assert.equal(parsed.header?.schemaVersion, FIXTURE_SCHEMA_VERSION);
  assert.equal(parsed.header?.name, "recorded-probe");
  assert.equal(parsed.header?.source, "recorded");
  assert.equal(parsed.header?.recordedAt, "2026-10-09T00:00:00.000Z");

  const init = parsed.frames[0] as Record<string, unknown>;
  assert.equal(init.type, "system");
  assert.ok(!("slash_commands" in init), "local slash commands must not survive into a fixture");
  assert.ok(!("agents" in init), "local agents must not survive into a fixture");
  assert.ok(!("cwd" in init), "the absolute cwd must not survive into a fixture");
  assert.match(String(init.uuid), /^00000000-0000-4000-8000-\d{12}$/);
  assert.match(String(init.session_id), /^00000000-0000-4000-8000-\d{12}$/);

  const assistantText = (parsed.frames[2] as { message: { content: Array<{ text: string }> } }).message.content[0].text;
  assert.ok(!assistantText.includes(workdir), "the scratch path must be scrubbed");
  assert.ok(assistantText.includes("/workdir/file.txt"));

  // The written file loads through the same loader the oracles use when the
  // fixture directory is the committed one; here it just proves the JSONL is
  // well-formed and header-validated.
  assert.doesNotThrow(() => assertFixtureHeader(parsed.header, "recorded-probe"));
});

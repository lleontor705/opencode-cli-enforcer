/**
 * agy turn-close oracles (REQ-CB-AGY-001).
 *
 * Real `agy` in `stream-json` mode is a REPL: after its terminal `result` frame
 * it keeps stdout open, waiting for another `user` frame or stdin EOF. The
 * adapter must therefore (a) close stdin right after the single `user` frame so
 * agy can exit and persist the conversation, and (b) stop reading at `result`
 * so a child that never closes stdout still finishes the turn promptly instead
 * of hanging until the host watchdog fires.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { AgyChildProcessLike, AgyReadableLike } from "../../src/agy/transport.ts";
import { AgyTransport } from "../../src/agy/transport.ts";
import { AgySessionStore } from "../../src/agy/session-store.ts";
import { AgyUsageBaselineLedger, projectAgyModels } from "../../src/agy/probe.ts";
import { createAgyLanguageModel } from "../../src/agy/language-model.ts";
import { loadFixture } from "../lib/record-agy-streams.mjs";

class FakeWritable {
  readonly writes: string[] = [];
  /** Number of frames written when `end()` was called; null while open. */
  writesAtEnd: number | null = null;
  throwOnEnd = false;

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }

  end(): unknown {
    if (this.throwOnEnd) throw new Error("EPIPE: stdin already closed");
    this.writesAtEnd = this.writes.length;
    return this;
  }
}

/** Child whose stdout streams `lines`, then (optionally) stays open until killed. */
class FakeChild implements AgyChildProcessLike {
  readonly pid = 4343;
  readonly stdin = new FakeWritable();
  readonly stdout: AgyReadableLike;
  readonly stderr = null;
  killed = false;
  private release: () => void = () => {};

  constructor(lines: readonly string[], keepOpen: boolean) {
    const gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
    this.stdout = {
      async *[Symbol.asyncIterator]() {
        for (const line of lines) yield `${line}\n`;
        if (keepOpen) await gate;
      },
    };
  }

  once(): unknown {
    return this;
  }

  kill(): boolean {
    this.killed = true;
    this.release();
    return true;
  }
}

function transportFor(child: FakeChild): AgyTransport {
  return new AgyTransport({ spawn: () => child });
}

function fixtureLines(name: string): string[] {
  const { frames } = loadFixture(name);
  return frames.map((frame: unknown) => JSON.stringify(frame));
}

const MODEL = projectAgyModels()[0];
const WATCHDOG_MS = 5_000;
const USER_PROMPT = {
  prompt: [{ role: "user", content: [{ type: "text", text: "say hello" }] }],
};

function buildModel(child: FakeChild) {
  return createAgyLanguageModel(MODEL, {
    transport: transportFor(child),
    sessions: new AgySessionStore(),
    usageBaselines: new AgyUsageBaselineLedger(),
    command: "agy",
    watchdogTimeoutMs: WATCHDOG_MS,
  });
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

test("TestREQ_CB_AGY_001_turn_finishes_at_result_when_stdout_never_closes", async () => {
  const lines = fixtureLines("text-turn");
  assert.equal(JSON.parse(lines[lines.length - 1]).event, "result", "fixture must end with result");
  const child = new FakeChild(lines, true);
  const model = buildModel(child);

  const started = Date.now();
  const { stream } = await model.doStream(USER_PROMPT);
  const parts = await collect(stream);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 1_000, `turn must close at result, not at the watchdog (took ${elapsed} ms)`);
  const types = parts.map((part) => part.type);
  assert.equal(types[types.length - 1], "finish");
  assert.ok(!types.includes("error"), `no error part expected, got ${JSON.stringify(types)}`);
  assert.equal(child.killed, true, "the lingering child is reaped after the turn");
});

test("TestREQ_CB_AGY_001_stdin_is_closed_after_the_single_user_frame", async () => {
  const child = new FakeChild(fixtureLines("text-turn"), false);
  const model = buildModel(child);

  const { stream } = await model.doStream(USER_PROMPT);
  const parts = await collect(stream);

  assert.equal(parts[parts.length - 1].type, "finish");
  assert.equal(child.stdin.writes.length, 1);
  assert.deepEqual(JSON.parse(child.stdin.writes[0]), { event: "user", message: { content: "say hello" } });
  assert.equal(child.stdin.writesAtEnd, 1, "stdin must be ended right after the user frame is written");
});

test("TestREQ_CB_AGY_001_failed_stdin_close_is_best_effort", async () => {
  const child = new FakeChild(fixtureLines("text-turn"), true);
  child.stdin.throwOnEnd = true;
  const model = buildModel(child);

  const { stream } = await model.doStream(USER_PROMPT);
  const types = (await collect(stream)).map((part) => part.type);

  assert.equal(types[types.length - 1], "finish");
  assert.ok(!types.includes("error"), `a failed stdin close must not fail the turn: ${JSON.stringify(types)}`);
});

/**
 * Replay harness for recorded Claude Agent SDK streams (REQ-CB-STRM-001..003, D6).
 *
 * The fixtures under tests/fixtures/sdk-streams/ are JSONL message sequences
 * captured (or, where a shape cannot be recorded on demand, hand-authored) from
 * live Claude Code turns. This module is the single loader/driver the oracles in
 * replay.test.ts use: it parses a fixture, replays it frame-by-frame through the
 * cb-08 mapping layer, and optionally drives the same frames through the real
 * cb-12 LanguageModelV3 adapter via an injected transport fake, so no child
 * process is ever spawned.
 *
 * A fixture is a schema-versioned artifact: an optional leading header line
 * (`{fixture:"sdk-stream", schemaVersion, name, ...}`) followed by the raw SDK
 * messages. Recorded fixtures always carry the header; a headerless pi-style
 * file still loads, but the schema version is enforced whenever it is present.
 *
 * The loader lives in .mjs so both the TypeScript oracle and the standalone
 * recorder can share it without a build step.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createClaudeBridgeLanguageModel } from "../../src/provider/language-model.js";
import { projectClaudeCodeModels } from "../../src/provider/models.js";
import { ToolRendezvous } from "../../src/mcp/rendezvous.js";
import {
  ClaudeEventMapper,
  renderNormalizedEvents,
  toLanguageModelV3Usage,
} from "../../src/stream/mapping.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where committed stream fixtures live. */
export const FIXTURE_DIR = join(HERE, "..", "fixtures", "sdk-streams");

/** Marker that identifies the first JSONL line as a fixture header. */
export const FIXTURE_HEADER_MARKER = "sdk-stream";

/** Bump when the frame vocabulary changes in a way replay must not silently accept. */
export const FIXTURE_SCHEMA_VERSION = 1;

export function fixturePath(name) {
  return join(FIXTURE_DIR, `${name}.jsonl`);
}

export function listFixtures() {
  let entries;
  try {
    entries = readdirSync(FIXTURE_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".jsonl") && !entry.startsWith("._"))
    .map((entry) => entry.slice(0, -".jsonl".length))
    .sort();
}

function isFixtureHeader(value) {
  return Boolean(value) && typeof value === "object" && value.fixture === FIXTURE_HEADER_MARKER;
}

/** Parse JSONL text into `{header, frames}`. Blank lines are ignored; only the
 *  first line may be a header. */
export function parseFixtureText(text) {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  let header = null;
  const frames = [];
  for (const line of lines) {
    const value = JSON.parse(line);
    if (header === null && frames.length === 0 && isFixtureHeader(value)) {
      header = value;
      continue;
    }
    frames.push(value);
  }
  return { header, frames };
}

/**
 * Enforce the fixture artifact contract. A headerless file is tolerated for
 * legacy recordings, but a present header must name this file, match the schema
 * version the loader understands, and be structurally sound.
 */
export function assertFixtureHeader(header, name) {
  if (header === null) return;
  if (header.schemaVersion !== FIXTURE_SCHEMA_VERSION) {
    throw new Error(
      `fixture "${name ?? "?"}": schema version ${String(header.schemaVersion)} is not supported ` +
        `(this loader understands v${FIXTURE_SCHEMA_VERSION}); re-record with record-sdk-streams.mjs`,
    );
  }
  if (name !== undefined && header.name !== undefined && header.name !== name) {
    throw new Error(`fixture "${name}": header names "${header.name}" — header and filename disagree`);
  }
}

export function loadFixture(name) {
  const path = fixturePath(name);
  const parsed = parseFixtureText(readFileSync(path, "utf8"));
  assertFixtureHeader(parsed.header, name);
  if (parsed.frames.length === 0) throw new Error(`fixture "${name}" carries no frames`);
  return { name, path, header: parsed.header, frames: parsed.frames };
}

/** Serialize a fixture to the committed JSONL form (header line + frames). */
export function serializeFixture({ name, frames, source, description, recordedAt, claudeSdk }) {
  const header = {
    fixture: FIXTURE_HEADER_MARKER,
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    name,
    source: source ?? "recorded",
    ...(description !== undefined ? { description } : {}),
    ...(recordedAt !== undefined ? { recordedAt } : {}),
    ...(claudeSdk !== undefined ? { claudeSdk } : {}),
  };
  return [JSON.stringify(header), ...frames.map((frame) => JSON.stringify(frame))].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Direct replay: frames -> EventMapper -> LanguageModelV3 stream parts.
// ---------------------------------------------------------------------------

/**
 * Replay frames through the cb-08 mapping layer only. This is the ground truth
 * the adapter path is compared against; it touches no child process and no
 * provider transport.
 */
export function replayThroughMapper(frames, options = {}) {
  const mapper = new ClaudeEventMapper(options.mapperOptions ?? {});
  const normalized = [];
  for (const frame of frames) normalized.push(...mapper.map(frame));
  return {
    mapper,
    normalized,
    parts: renderNormalizedEvents(normalized),
    turn: mapper.toTurnResult(frames),
  };
}

export function replayFixtureDirect(name, options = {}) {
  const fixture = loadFixture(name);
  return { ...replayThroughMapper(fixture.frames, options), fixture };
}

// ---------------------------------------------------------------------------
// Adapter replay: frames -> real cb-12 LanguageModelV3 via injected transport.
// ---------------------------------------------------------------------------

export async function collectStream(stream) {
  const reader = stream.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
}

/**
 * Injectable transport fake: an SDK `Query`-shaped async iterable that yields the
 * fixture frames and then parks on a gate, mirroring a live child that has not
 * exited. `close()`/`interrupt()` release the gate so the pump can unwind.
 */
export function createFixtureSpawner(frames, options = {}) {
  const state = { held: options.hold ?? true, interrupted: false, closed: false, release: null };
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  state.release = release;

  async function* generate() {
    for (const frame of frames) yield frame;
    if (state.held) await gate;
  }

  const handle = Object.assign(generate(), {
    interrupt: async () => {
      state.interrupted = true;
      release();
    },
    close: () => {
      state.closed = true;
      release();
    },
  });

  return { spawner: () => handle, handle, state };
}

/** Drive the frames through the real adapter (no live CLI, no HTTP). */
export async function replayThroughAdapter(frames, options = {}) {
  const model = options.model ?? projectClaudeCodeModels()[0];
  const rendezvous = options.rendezvous ?? new ToolRendezvous();
  const spawn = createFixtureSpawner(frames, options.control ?? {});

  const language = createClaudeBridgeLanguageModel(model, {
    spawnImpl: spawn.spawner,
    rendezvous,
    ...(options.hostTools !== undefined ? { hostTools: options.hostTools } : {}),
    ...(options.notify !== undefined ? { notify: options.notify } : {}),
    ...(options.resolveToolName !== undefined ? { resolveToolName: options.resolveToolName } : {}),
  });

  const { stream } = await language.doStream({
    prompt: options.prompt ?? [{ role: "user", content: [{ type: "text", text: "replay" }] }],
  });

  try {
    return { parts: await collectStream(stream), language, spawn, rendezvous, model };
  } finally {
    spawn.handle.close();
  }
}

export function replayFixtureThroughAdapter(name, options = {}) {
  const fixture = loadFixture(name);
  return replayThroughAdapter(fixture.frames, options).then((result) => ({ ...result, fixture }));
}

// ---------------------------------------------------------------------------
// Assertion helpers.
// ---------------------------------------------------------------------------

export function partTypes(parts) {
  return parts.map((part) => part.type);
}

export function partsOfType(parts, type) {
  return parts.filter((part) => part.type === type);
}

export function textDelta(parts) {
  return partsOfType(parts, "text-delta")
    .map((part) => String(part.delta ?? ""))
    .join("");
}

/** The finish part's usage, already normalized the way the seam requires. */
export function finishUsage(parts) {
  const finish = parts.find((part) => part.type === "finish");
  return finish === undefined ? undefined : finish.usage;
}

export { toLanguageModelV3Usage };

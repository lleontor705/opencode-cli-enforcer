#!/usr/bin/env node
/**
 * Records real agy (Google Antigravity CLI) stream-json sessions as replay
 * fixtures (cb-26, REQ-CB-AGY-001), mirroring tests/lib/record-sdk-streams.mjs.
 *
 *   AGY_BRIDGE_RECORD=1 node --import tsx tests/lib/record-agy-streams.mjs [scenario ...]
 *
 * Costing subscription quota, this is not part of the unit suite. Re-run it on an
 * agy bump and read the diff: a changed fixture is agy changing the wire shape
 * under the adapter, which is exactly why these streams are recorded rather than
 * invented. Recording is gated behind `AGY_BRIDGE_RECORD=1` so a stray invocation
 * never spends quota.
 *
 * Recording drives the real cb-21 transport over a real child (`agy
 * --input-format stream-json --output-format stream-json`), writes one `user`
 * frame per scenario prompt, and captures every parsed output event up to and
 * including the terminal `result`. Prompts are trivial and the captured frames
 * are scrubbed of machine-identifying strings (home prefix, scratch workdir,
 * conversation uuids) before they are written.
 *
 * The recorder also owns the agy fixture artifact contract — parse, serialize,
 * header enforcement, load/list, and the scrubber — because the cb-26 oracle
 * loads the committed fixtures through exactly the functions the recorder writes
 * them with. The pure pipeline is exported (`recordScenario` with an injected
 * `runSession`) so adapter.test.ts proves that path deterministically, with no
 * live CLI.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseAgyLine } from "../../src/agy/event-mapper.js";
import { AGY_TRANSPORT_DEFAULT_COMMAND, AgyTransport } from "../../src/agy/transport.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where committed agy stream fixtures live. */
export const AGY_STREAM_FIXTURE_DIR = join(HERE, "..", "fixtures", "agy-streams");

/** Marker that identifies the first JSONL line as an agy fixture header. */
export const AGY_STREAM_HEADER_MARKER = "agy-stream";

/** Bump when the event vocabulary changes in a way replay must not silently accept. */
export const AGY_STREAM_SCHEMA_VERSION = 1;

/** Scratch directory the recorded scenarios use as `cwd`. */
export const RECORD_WORKDIR = join(HERE, "..", ".record-agy-workdir");

/** Bounded per-line capture budget, mirroring the transport's own watchdog posture. */
const RECORD_MAX_EVENTS = 4096;

// ---------------------------------------------------------------------------
// Fixture artifact contract (header, parse, serialize, load, list).
// ---------------------------------------------------------------------------

export function fixturePath(name) {
  return join(AGY_STREAM_FIXTURE_DIR, `${name}.jsonl`);
}

export function listFixtures() {
  let entries;
  try {
    entries = readdirSync(AGY_STREAM_FIXTURE_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".jsonl") && !entry.startsWith("._"))
    .map((entry) => entry.slice(0, -".jsonl".length))
    .sort();
}

function isFixtureHeader(value) {
  return Boolean(value) && typeof value === "object" && value.fixture === AGY_STREAM_HEADER_MARKER;
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
 * Enforce the fixture artifact contract: a present header must match the schema
 * version this loader understands and, when a name is supplied, must not
 * disagree with the filename.
 */
export function assertFixtureHeader(header, name) {
  if (header === null) return;
  if (header.schemaVersion !== AGY_STREAM_SCHEMA_VERSION) {
    throw new Error(
      `agy fixture "${name ?? "?"}": schema version ${String(header.schemaVersion)} is not supported ` +
        `(this loader understands v${AGY_STREAM_SCHEMA_VERSION}); re-record with record-agy-streams.mjs`,
    );
  }
  if (name !== undefined && header.name !== undefined && header.name !== name) {
    throw new Error(`agy fixture "${name}": header names "${header.name}" — header and filename disagree`);
  }
}

export function loadFixture(name, fixturesDir = AGY_STREAM_FIXTURE_DIR) {
  const path = join(fixturesDir, `${name}.jsonl`);
  const parsed = parseFixtureText(readFileSync(path, "utf8"));
  assertFixtureHeader(parsed.header, name);
  if (parsed.frames.length === 0) throw new Error(`agy fixture "${name}" carries no frames`);
  return { name, path, header: parsed.header, frames: parsed.frames };
}

/** Serialize a fixture to the committed JSONL form (header line + frames). */
export function serializeFixture({ name, frames, source, description, recordedAt, agyVersion }) {
  const header = {
    fixture: AGY_STREAM_HEADER_MARKER,
    schemaVersion: AGY_STREAM_SCHEMA_VERSION,
    name,
    source: source ?? "recorded",
    ...(description !== undefined ? { description } : {}),
    ...(recordedAt !== undefined ? { recordedAt } : {}),
    ...(agyVersion !== undefined ? { agyVersion } : {}),
  };
  return [JSON.stringify(header), ...frames.map((frame) => JSON.stringify(frame))].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Scrubbing.
// ---------------------------------------------------------------------------

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Replace machine-identifying strings with stable placeholders. The home prefix
 * is replaced wholesale, not just the scratch dir: a model can narrate absolute
 * paths inside a text delta.
 */
export function createScrubber({ workdir } = {}) {
  const ids = new Map();
  const fakeId = (id) => {
    if (!ids.has(id)) ids.set(id, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`);
    return ids.get(id);
  };
  const home = homedir();
  const work = workdir ?? RECORD_WORKDIR;

  return function scrub(value) {
    if (typeof value === "string") {
      return value.replace(UUID, fakeId).replaceAll(work, "/workdir").replaceAll(home, "/home/user");
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, scrub(inner)]));
    }
    return value;
  };
}

/**
 * Scrub one frame, then strip the `init.cwd` absolute path: it is local
 * configuration (which directory this machine recorded from), not part of the
 * event contract the adapter consumes.
 */
export function scrubFrame(frame, scrubber) {
  const scrubbed = scrubber(frame);
  if (scrubbed && typeof scrubbed === "object" && !Array.isArray(scrubbed) && scrubbed.event === "init") {
    const init = scrubbed.init;
    if (init && typeof init === "object" && !Array.isArray(init)) {
      const { cwd: _cwd, ...rest } = init;
      return { ...scrubbed, init: rest };
    }
  }
  return scrubbed;
}

// ---------------------------------------------------------------------------
// Recording.
// ---------------------------------------------------------------------------

/** Scenario prompts, one trivial turn each. */
export const SCENARIOS = {
  "text-turn": { prompt: "Reply with exactly the word ALPHA and nothing else." },
  "tool-invocation": { prompt: "Run the shell command `echo hello_headless_demo` and reply with its output." },
};

/**
 * Default session runner: drive the real cb-21 transport against a real child,
 * yielding each parsed output event up to (and including) the terminal `result`.
 */
export async function* recordAgySession({
  prompt,
  workdir = RECORD_WORKDIR,
  baseEnv = process.env,
  transport = new AgyTransport(),
} = {}) {
  if (typeof prompt !== "string" || prompt.length === 0) throw new Error("recordAgySession: prompt is required");
  const child = await transport.spawn({
    command: AGY_TRANSPORT_DEFAULT_COMMAND,
    args: transport.buildArgv({ model: "" }),
    cwd: workdir,
    env: { ...baseEnv },
  });
  try {
    await transport.writeFrame(child, { event: "user", message: { content: prompt } });
    let captured = 0;
    for await (const line of transport.readLines(child)) {
      const raw = parseAgyLine(line);
      yield raw;
      if (raw.event === "result") break;
      if (++captured >= RECORD_MAX_EVENTS) {
        throw new Error(`recordAgySession: exceeded ${RECORD_MAX_EVENTS} events without a result`);
      }
    }
  } finally {
    child.kill();
  }
}

/**
 * Record one scenario and write its schema-versioned fixture. `runSession` is an
 * injectable async iterable factory so the pipeline is testable without a live
 * CLI; it receives `{name, prompt, workdir, baseEnv}` and yields raw frames.
 */
export async function recordScenario(config) {
  const {
    name,
    prompt,
    runSession,
    workdir = RECORD_WORKDIR,
    fixturesDir = AGY_STREAM_FIXTURE_DIR,
    baseEnv = process.env,
    now = () => new Date().toISOString(),
    agyVersion,
  } = config;
  if (typeof name !== "string" || name.length === 0) throw new Error("recordScenario: name is required");
  if (typeof prompt !== "string" || prompt.length === 0) throw new Error("recordScenario: prompt is required");
  if (typeof runSession !== "function") throw new Error("recordScenario: runSession is required");

  const scrubber = createScrubber({ workdir });
  const frames = [];
  for await (const frame of runSession({ name, prompt, workdir, baseEnv })) {
    frames.push(scrubFrame(frame, scrubber));
  }
  if (frames.length === 0) throw new Error(`recordScenario: session "${name}" produced no frames`);

  const body = serializeFixture({
    name,
    frames,
    source: "recorded",
    description: `recorded ${name} agy session (schema v${AGY_STREAM_SCHEMA_VERSION})`,
    recordedAt: now(),
    ...(agyVersion !== undefined ? { agyVersion } : {}),
  });

  const user = homedir().split("/").filter(Boolean).pop();
  if (user && body.includes(user)) {
    throw new Error(`${name}: "${user}" survived scrubbing — refusing to write a fixture carrying it`);
  }

  mkdirSync(fixturesDir, { recursive: true });
  const path = join(fixturesDir, `${name}.jsonl`);
  writeFileSync(path, body);
  return { name, path: relative(process.cwd(), path), count: frames.length, frames, body };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  if (process.env.AGY_BRIDGE_RECORD !== "1") {
    console.log(
      "agy recording disabled — recording spends subscription quota. " +
        "Re-run with AGY_BRIDGE_RECORD=1 and a discoverable agy to capture real fixtures.",
    );
    return [];
  }
  const runSession = deps.runSession ?? recordAgySession;
  const fixturesDir = deps.fixturesDir ?? AGY_STREAM_FIXTURE_DIR;
  const wanted = argv.length > 0 ? argv : Object.keys(SCENARIOS);
  mkdirSync(RECORD_WORKDIR, { recursive: true });

  const results = [];
  for (const name of wanted) {
    const scenario = SCENARIOS[name];
    if (!scenario) {
      throw new Error(`unknown scenario "${name}"; known: ${Object.keys(SCENARIOS).join(", ")}`);
    }
    const result = await recordScenario({
      name,
      prompt: scenario.prompt,
      runSession,
      fixturesDir,
    });
    results.push(result);
    console.log(`${name}: ${result.count} frames recorded`);
  }
  return results;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}

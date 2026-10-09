#!/usr/bin/env node
/**
 * Records real Claude Agent SDK message streams as replay fixtures (cb-16, D6).
 *
 *   node --import tsx tests/lib/record-sdk-streams.mjs [scenario ...]
 *
 * Costing API calls, this is not part of the unit suite. Re-run it on an SDK
 * bump and read the diff: a changed fixture is the SDK changing shape under the
 * bridge, which is exactly why these streams are recorded rather than invented.
 *
 * Recording spawns `query()` directly with the same child env hygiene and
 * permission posture the bridge uses (`buildQueryOptions`), plus an in-process
 * MCP server for tool scenarios so tool_use blocks are real. It never touches
 * the parked session query or the session mirror.
 *
 * Prompts are trivial and the served tools read scratch files this script
 * creates, so no fixture carries repo or conversation content. The SDK envelope
 * still does — `system/init` reports the absolute cwd and the user's slash-command
 * and agent list, and every message carries live uuids — so `scrubMessage()`
 * strips all of it. A fixture that has not been through it must never be committed.
 *
 * The pure recording pipeline is exported (`recordScenario` with an injected
 * `queryImpl`) so replay.test.ts can prove the scrub/header/serialization path
 * deterministically, with no live CLI.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { query as defaultSdkQuery } from "@anthropic-ai/claude-agent-sdk";

import { buildChildEnv } from "../../src/config/schema.js";
import { createToolServer } from "../../src/mcp/server.js";
import {
  FIXTURE_DIR,
  FIXTURE_SCHEMA_VERSION,
  serializeFixture,
} from "./replay.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Scratch directory for the tool scenarios' readable files. */
export const RECORD_WORKDIR = join(HERE, "..", ".record-workdir");

const MCP_SERVER_NAME = "opencode";

/** Fixed contents this script owns, so a recorded tool_result is deterministic. */
export const RECORD_FILES = {
  "one.txt": "ONE\n",
  "two.txt": "TWO\n",
  "three.txt": "THREE\n",
};

const READ_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
};

function readTool() {
  return {
    name: "read",
    description: "Read a file from the scratch directory.",
    inputSchema: READ_SCHEMA,
    // The MCP handler is handed only the tool_use id (the host owns arguments),
    // so the recorder answers with fixed content. The fixture only needs the
    // real tool_use/tool_result *shape*, not the file the model asked for.
    handler: async () => ({ content: [{ type: "text", text: RECORD_FILES["one.txt"] }] }),
  };
}

/** Scenario prompts plus the host tools (if any) served while recording. */
export const SCENARIOS = {
  "text-turn": {
    prompt: "Reply with exactly the word ALPHA and nothing else.",
  },
  "single-tool": {
    prompt: "Read the file one.txt and reply with exactly its contents, nothing else.",
    tools: [readTool()],
  },
  "parallel-tools": {
    prompt:
      "Read one.txt, two.txt and three.txt in a single parallel batch, then reply with the contents separated by commas.",
    tools: [readTool()],
  },
};

// ---------------------------------------------------------------------------
// Scrubbing.
// ---------------------------------------------------------------------------

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Only the fields a stream consumer reads survive from system/init. Everything
// else there is local configuration (slash_commands, agents, output style, the
// real cwd) and describes this machine rather than the SDK's contract.
const SYSTEM_INIT_KEEP = new Set([
  "type",
  "subtype",
  "session_id",
  "uuid",
  "model",
  "permissionMode",
  "mcp_servers",
  "tools",
]);

/**
 * Replace machine-identifying strings with stable placeholders. The home prefix
 * is replaced wholesale, not just the scratch dir: the model narrates absolute
 * paths inside thinking deltas and a delta boundary can cut the path in half.
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

export function scrubMessage(message, scrubber) {
  const kept =
    message?.type === "system" && message?.subtype === "init"
      ? Object.fromEntries(Object.entries(message).filter(([key]) => SYSTEM_INIT_KEEP.has(key)))
      : message;
  return scrubber(kept);
}

// ---------------------------------------------------------------------------
// Recording.
// ---------------------------------------------------------------------------

/** The SDK options used while recording: same hygiene the bridge applies. */
export function buildRecordingOptions({ workdir, baseEnv = process.env, tools } = {}) {
  const mcpServers =
    tools && tools.length > 0
      ? { [MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, tools) }
      : undefined;
  return {
    cwd: workdir,
    env: buildChildEnv(baseEnv),
    tools: [],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    strictMcpConfig: true,
    ...(mcpServers !== undefined ? { mcpServers } : {}),
  };
}

/**
 * Record one scenario and write its schema-versioned fixture. `queryImpl` is
 * injectable so the pipeline is testable without a live CLI.
 */
export async function recordScenario(config) {
  const {
    name,
    prompt,
    queryImpl,
    tools,
    workdir = RECORD_WORKDIR,
    fixturesDir = FIXTURE_DIR,
    baseEnv = process.env,
    now = () => new Date().toISOString(),
    claudeSdk,
  } = config;
  if (typeof name !== "string" || name.length === 0) throw new Error("recordScenario: name is required");
  if (typeof prompt !== "string" || prompt.length === 0) throw new Error("recordScenario: prompt is required");
  if (typeof queryImpl !== "function") throw new Error("recordScenario: queryImpl is required");

  const scrubber = createScrubber({ workdir });
  const messages = [];
  const stream = queryImpl({ prompt, options: buildRecordingOptions({ workdir, baseEnv, tools }) });
  for await (const message of stream) messages.push(scrubMessage(message, scrubber));

  const body = serializeFixture({
    name,
    frames: messages,
    source: "recorded",
    description: `recorded ${name} turn (schema v${FIXTURE_SCHEMA_VERSION})`,
    recordedAt: now(),
    ...(claudeSdk !== undefined ? { claudeSdk } : {}),
  });

  const user = homedir().split("/").filter(Boolean).pop();
  if (user && body.includes(user)) {
    throw new Error(`${name}: "${user}" survived scrubbing — refusing to write a fixture carrying it`);
  }

  mkdirSync(fixturesDir, { recursive: true });
  const path = join(fixturesDir, `${name}.jsonl`);
  writeFileSync(path, body);
  return { name, path: relative(process.cwd(), path), count: messages.length, messages, body };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const queryImpl = deps.queryImpl ?? defaultSdkQuery;
  const fixturesDir = deps.fixturesDir ?? FIXTURE_DIR;
  const wanted = argv.length > 0 ? argv : Object.keys(SCENARIOS);
  prepareWorkdir();
  const results = [];
  for (const name of wanted) {
    const scenario = SCENARIOS[name];
    if (!scenario) {
      throw new Error(`unknown scenario "${name}"; known: ${Object.keys(SCENARIOS).join(", ")}`);
    }
    const result = await recordScenario({
      name,
      prompt: scenario.prompt,
      tools: scenario.tools,
      queryImpl,
      fixturesDir,
    });
    results.push(result);
    console.log(`${name}: ${result.count} messages recorded`);
  }
  return results;
}

function prepareWorkdir() {
  mkdirSync(RECORD_WORKDIR, { recursive: true });
  for (const [file, body] of Object.entries(RECORD_FILES)) {
    writeFileSync(join(RECORD_WORKDIR, file), body);
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}

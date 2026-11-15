/**
 * Oracles for `buildAgyRunnerCommand` and standalone `src/agy/runner-cli.mjs`
 * execution without `tsx` (REQ-CB-TOOL-001, REQ-CB-AGY-001; design D13).
 *
 * Verifies:
 *  1. Command construction across plain Node, OpenCode/Bun on POSIX
 *     (`BUN_BE_BUN=1`), and Bun on Windows (`node` fallback).
 *  2. Live MCP stdio round-trip (`tools/list` + `tools/call`) spawning
 *     `src/agy/runner-cli.mjs` under bare `node` (`NODE_OPTIONS=""`, no `tsx`).
 *  3. Live MCP stdio round-trip under the compiled OpenCode v2 binary
 *     (`/opt/homebrew/Cellar/opencode-v2/2.3.0/bin/opencode`) when present.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { AgyPermissionPolicy, AgyToolChannel } from "../../src/agy/channel.js";
import { startAgyHostBridge, type AgyHostBridge } from "../../src/agy/runner.js";
import { AGY_RUNNER_ENTRY, buildAgyRunnerCommand } from "../../src/index.js";
import type { HostTool } from "../../src/provider/seams.js";

const EXPECTED_RUNNER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "agy",
  "runner-cli.mjs",
);

const OPENCODE_V2_BIN = "/opt/homebrew/Cellar/opencode-v2/2.3.0/bin/opencode";

const ECHO_SCHEMA = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};

function createHostTool(
  name: string,
  call: (input: unknown) => Promise<{ content: string; isError?: boolean }>,
): HostTool {
  return { descriptor: { name, description: `${name} tool`, inputSchema: ECHO_SCHEMA }, call };
}

function bareSubprocessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "NODE_OPTIONS") env[key] = value;
  }
  return env;
}

async function startTestBridge(): Promise<AgyHostBridge> {
  const channel = new AgyToolChannel({
    permission: new AgyPermissionPolicy({ allowToolNames: ["echo"] }),
    runnerCommand: ["node", AGY_RUNNER_ENTRY],
  });
  await channel.registerHostTools([
    createHostTool("echo", async (input) => ({
      content: `pong:${(input as { text: string }).text}`,
    })),
    createHostTool("forbidden", async () => ({ content: "never" })),
  ]);
  const bridge = await startAgyHostBridge();
  await bridge.attach(channel);
  return bridge;
}

async function verifyRoundTrip(command: string, args: readonly string[]): Promise<void> {
  const transport = new StdioClientTransport({
    command,
    args: [...args],
    env: bareSubprocessEnv(),
    stderr: "pipe",
  });
  const client = new Client({ name: "runner-cli-oracle", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ["echo", "forbidden"],
    );

    const ok = await client.callTool({ name: "echo", arguments: { text: "opencode2" } });
    assert.ok(!ok.isError);
    const okBlocks = ok.content as Array<{ type: string; text: string }>;
    assert.equal(okBlocks[0]?.text, "pong:opencode2");

    const denied = await client.callTool({ name: "forbidden", arguments: { text: "x" } });
    assert.equal(denied.isError, true);
    const deniedBlocks = denied.content as Array<{ type: string; text: string }>;
    assert.match(deniedBlocks[0]?.text ?? "", /denied/);
  } finally {
    await client.close().catch(() => {});
  }
}

describe("buildAgyRunnerCommand runtime dispatch", () => {
  const url = "http://127.0.0.1:43123";
  const token = "bridge-secret-token";

  it("points AGY_RUNNER_ENTRY at src/agy/runner-cli.mjs", () => {
    assert.equal(AGY_RUNNER_ENTRY, EXPECTED_RUNNER_PATH);
    assert.equal(existsSync(AGY_RUNNER_ENTRY), true);
  });

  it("uses execPath directly on Node without --import tsx", () => {
    const cmd = buildAgyRunnerCommand(url, token, {
      execPath: "/usr/local/bin/node",
      isBun: false,
      platform: "darwin",
    });
    assert.deepEqual(cmd, ["/usr/local/bin/node", AGY_RUNNER_ENTRY, url, token]);
    assert.equal(cmd.includes("--import"), false);
    assert.equal(cmd.includes("tsx"), false);
  });

  it("wraps compiled Bun/OpenCode binary with /usr/bin/env BUN_BE_BUN=1 on POSIX", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const cmd = buildAgyRunnerCommand(url, token, {
        execPath: OPENCODE_V2_BIN,
        isBun: true,
        platform,
      });
      assert.deepEqual(cmd, [
        "/usr/bin/env",
        "BUN_BE_BUN=1",
        OPENCODE_V2_BIN,
        AGY_RUNNER_ENTRY,
        url,
        token,
      ]);
    }
  });

  it("falls back to node executable when running under Bun on win32", () => {
    const cmd = buildAgyRunnerCommand(url, token, {
      execPath: "C:\\Program Files\\opencode\\opencode.exe",
      isBun: true,
      platform: "win32",
    });
    assert.deepEqual(cmd, ["node", AGY_RUNNER_ENTRY, url, token]);
  });
});

describe("runner-cli.mjs live MCP stdio round-trip", () => {
  it("serves tools/list and tools/call under bare Node (no tsx)", { timeout: 20_000 }, async (t) => {
    const bridge = await startTestBridge();
    t.after(() => bridge.close());

    const [command, ...args] = buildAgyRunnerCommand(bridge.url, bridge.token, {
      execPath: process.execPath,
      isBun: false,
      platform: process.platform,
    });
    assert.ok(command);
    await verifyRoundTrip(command, args);
  });

  it(
    "serves tools/list and tools/call under OpenCode v2 binary (BUN_BE_BUN=1)",
    {
      skip: !existsSync(OPENCODE_V2_BIN) ? `${OPENCODE_V2_BIN} not installed on this host` : false,
      timeout: 20_000,
    },
    async (t) => {
      const bridge = await startTestBridge();
      t.after(() => bridge.close());

      const [command, ...args] = buildAgyRunnerCommand(bridge.url, bridge.token, {
        execPath: OPENCODE_V2_BIN,
        isBun: true,
        platform: process.platform,
      });
      assert.equal(command, "/usr/bin/env");
      assert.equal(args[1], OPENCODE_V2_BIN);
      await verifyRoundTrip(command, args);
    },
  );
});

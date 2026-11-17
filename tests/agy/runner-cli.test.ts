/**
 * Oracles for `buildAgyRunnerCommand` and standalone `src/agy/runner-cli.mjs`
 * execution without `tsx` (REQ-CB-TOOL-001, REQ-CB-AGY-001; design D13).
 *
 * Verifies:
 *  1. Command construction across plain Node, OpenCode/Bun on POSIX
 *     (`BUN_BE_BUN=1`), and Bun on Windows (`node` fallback).
 *  2. Live MCP stdio round-trip (`tools/list` + `tools/call`) spawning
 *     `src/agy/runner-cli.mjs` under bare `node` (`NODE_OPTIONS=""`, no `tsx`).
 *  3. Live MCP stdio round-trip under the OpenCode v2 binary (`OPENCODE_BIN`
 *     or `opencode` on PATH) and under plain `bun`, each skipped when absent.
 *  4. A non-JSON bridge error body surfaces its HTTP status, not a SyntaxError.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { AgyPermissionPolicy, AgyToolChannel } from "../../src/agy/channel.js";
import { createRunnerServer, startAgyHostBridge, type AgyHostBridge } from "../../src/agy/runner.js";
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

const OPENCODE_FIXTURE_BIN = "/opt/opencode/bin/opencode";

function resolveBinary(name: string, override?: string): string | null {
  if (override !== undefined && override.length > 0) return existsSync(override) ? override : null;
  const probe = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  const found = probe.status === 0 ? probe.stdout.trim() : "";
  return found.length > 0 ? found : null;
}

const OPENCODE_BIN = resolveBinary("opencode", process.env.OPENCODE_BIN);
const BUN_BIN = resolveBinary("bun");

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
        execPath: OPENCODE_FIXTURE_BIN,
        isBun: true,
        platform,
      });
      assert.deepEqual(cmd, [
        "/usr/bin/env",
        "BUN_BE_BUN=1",
        OPENCODE_FIXTURE_BIN,
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

  for (const [label, bin] of [
    ["OpenCode v2 binary (BUN_BE_BUN=1)", OPENCODE_BIN],
    ["plain bun", BUN_BIN],
  ] as const) {
    it(
      `serves tools/list and tools/call under ${label}`,
      { skip: bin === null ? `${label} not found (OPENCODE_BIN / PATH)` : false, timeout: 20_000 },
      async (t) => {
        const bridge = await startTestBridge();
        t.after(() => bridge.close());

        const [command, ...args] = buildAgyRunnerCommand(bridge.url, bridge.token, {
          execPath: bin!,
          isBun: true,
          platform: process.platform,
        });
        assert.ok(command);
        if (process.platform !== "win32") assert.equal(args[1], bin);
        await verifyRoundTrip(command, args);
      },
    );
  }
});

describe("runner-cli.mjs bridge error bodies", () => {
  it("reports HTTP status for a non-JSON 502 instead of a JSON SyntaxError", async (t) => {
    const http = createServer((_req, res) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("Bad Gateway");
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => http.close(() => resolve())));
    const { port } = http.address() as AddressInfo;

    const server = createRunnerServer({ url: `http://127.0.0.1:${port}`, token: "t" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "runner-cli-502", version: "1.0.0" });
    await client.connect(clientSide);
    t.after(() => client.close());

    await assert.rejects(client.listTools(), /agy host bridge returned HTTP 502/);
    const called = await client.callTool({ name: "echo", arguments: { text: "x" } });
    assert.equal(called.isError, true);
    const blocks = called.content as Array<{ type: string; text: string }>;
    assert.equal(blocks[0]?.text, "agy host bridge returned HTTP 502");
  });
});

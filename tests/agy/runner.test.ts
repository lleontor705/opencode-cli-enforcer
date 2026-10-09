/**
 * End-to-end oracles for the agy MCP-over-stdio runner and the plugin-side
 * loopback host bridge (REQ-CB-TOOL-001, REQ-CB-AGY-001; design D13).
 *
 * Every oracle spawns the real `src/agy/runner.ts` as a child process over a
 * real stdio transport pair (`StdioClientTransport`), backed by the real
 * plugin-side bridge attached to a real cb-24 `AgyToolChannel`. Nothing is
 * mocked on the wire: ListTools must arrive with verbatim schemas, CallTool
 * must run the channel's host executor and return MCP content, a denied/unknown
 * tool and an unreachable bridge must both surface as `isError` results without
 * hanging, and the bridge must bind loopback only and reject unauthenticated
 * requests.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  AGY_MCP_SERVER_DEFAULT_NAME,
  AgyPermissionPolicy,
  AgyToolChannel,
} from "../../src/agy/channel.ts";
import {
  AGY_HOST_BRIDGE_LOOPBACK_HOST,
  isLoopbackHostname,
  resolveRunnerEndpoint,
  startAgyHostBridge,
  type AgyHostBridge,
} from "../../src/agy/runner.ts";
import type { HostTool } from "../../src/provider/seams.ts";

const RUNNER_ENTRY = fileURLToPath(new URL("../../src/agy/runner.ts", import.meta.url));

const READ_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
};

const GREP_SCHEMA = {
  type: "object",
  properties: { pattern: { type: "string" } },
};

function hostTool(
  name: string,
  inputSchema: unknown,
  call: (input: unknown) => Promise<{ content: string; isError?: boolean }>,
): HostTool {
  return { descriptor: { name, description: `${name} tool`, inputSchema }, call };
}

function firstText(result: { content: unknown }): string {
  const content = result.content as Array<{ type: string; text: string }>;
  assert.equal(content[0]?.type, "text");
  return content[0].text;
}

function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function connectRunner(
  bridge: AgyHostBridge,
): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", RUNNER_ENTRY, bridge.url, bridge.token],
    env: inheritedEnv(),
    stderr: "pipe",
  });
  const client = new Client({ name: "agy-runner-test", version: "1.0.0" });
  try {
    await withTimeout(client.connect(transport), 15000);
  } catch (error) {
    await transport.close().catch(() => {});
    throw error;
  }
  return { client, transport };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`runner call did not settle within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function bridgeWithChannel(
  tools: readonly HostTool[],
  allowed: readonly string[],
): Promise<{ bridge: AgyHostBridge; channel: AgyToolChannel }> {
  const channel = new AgyToolChannel({
    permission: new AgyPermissionPolicy({ allowToolNames: allowed }),
    runnerCommand: ["node", "agy-runner.js"],
  });
  await channel.registerHostTools(tools);
  const bridge = await startAgyHostBridge();
  await bridge.attach(channel);
  return { bridge, channel };
}

test("TestREQ_CB_TOOL_001_runner_lists_host_tools_verbatim", { timeout: 20000 }, async (t) => {
  const { bridge } = await bridgeWithChannel(
    [
      hostTool("read", READ_SCHEMA, async () => ({ content: "body" })),
      hostTool("grep", GREP_SCHEMA, async () => ({ content: "match" })),
    ],
    ["read", "grep"],
  );
  t.after(() => bridge.close());

  assert.equal(bridge.host, AGY_HOST_BRIDGE_LOOPBACK_HOST, "the bridge must bind loopback only");
  assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+$/);

  const { client } = await connectRunner(bridge);
  t.after(() => client.close());

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ["grep", "read"],
    "the spawned runner must list the host tools through the bridge",
  );
  const read = listed.tools.find((tool) => tool.name === "read");
  assert.deepEqual(read?.inputSchema, READ_SCHEMA, "the schema must reach agy verbatim");
  const grep = listed.tools.find((tool) => tool.name === "grep");
  assert.deepEqual(grep?.inputSchema, GREP_SCHEMA);
});

test("TestREQ_CB_TOOL_001_runner_executes_and_reports_tool_errors", { timeout: 20000 }, async (t) => {
  const calls: unknown[] = [];
  const { bridge } = await bridgeWithChannel(
    [
      hostTool("read", READ_SCHEMA, async (input) => {
        calls.push(input);
        return { content: "file-body" };
      }),
      hostTool("bash", READ_SCHEMA, async () => ({ content: "must-not-run" })),
    ],
    ["read"],
  );
  t.after(() => bridge.close());

  const { client } = await connectRunner(bridge);
  t.after(() => client.close());

  const allowed = await client.callTool({ name: "read", arguments: { path: "a.txt" } });
  assert.ok(!allowed.isError, "an allowlisted tool must execute");
  assert.equal(firstText(allowed), "file-body");
  assert.deepEqual(calls, [{ path: "a.txt" }], "the host executor must receive the agy arguments");

  const denied = await client.callTool({ name: "bash", arguments: { path: "x" } });
  assert.equal(denied.isError, true, "a non-allowlisted tool is denied at the MCP boundary");
  assert.match(firstText(denied), /denied/);

  const unknown = await client.callTool({ name: "missing", arguments: {} });
  assert.equal(unknown.isError, true);
  assert.match(firstText(unknown), /unknown tool/);
});

test("TestREQ_CB_TOOL_001_runner_never_hangs_on_unreachable_bridge", { timeout: 20000 }, async (t) => {
  const { bridge } = await bridgeWithChannel(
    [hostTool("read", READ_SCHEMA, async () => ({ content: "body" }))],
    ["read"],
  );
  const { client } = await connectRunner(bridge);
  t.after(() => client.close());

  await bridge.close();

  const result = await withTimeout(client.callTool({ name: "read", arguments: {} }), 5000);
  assert.equal(result.isError, true, "a dead bridge must return an isError result, not hang");
  assert.ok(firstText(result).length > 0, "the error result must explain the failure");
});

test("TestREQ_CB_TOOL_001_bridge_is_loopback_only_and_authenticated", { timeout: 20000 }, async (t) => {
  const { bridge } = await bridgeWithChannel(
    [hostTool("read", READ_SCHEMA, async () => ({ content: "body" }))],
    ["read"],
  );
  t.after(() => bridge.close());

  assert.equal(bridge.host, AGY_HOST_BRIDGE_LOOPBACK_HOST);

  const unauthenticated = await fetch(`${bridge.url}/tools/list`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(unauthenticated.status, 401, "a request without the bearer token must be rejected");

  const wrongToken = await fetch(`${bridge.url}/tools/list`, {
    method: "POST",
    headers: { authorization: "Bearer not-the-token", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(wrongToken.status, 401);

  const authorized = await fetch(`${bridge.url}/tools/list`, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.token}` },
    body: "{}",
  });
  assert.equal(authorized.status, 200);
  const body = (await authorized.json()) as { tools: Array<{ name: string }> };
  assert.deepEqual(body.tools.map((tool) => tool.name), ["read"]);

  assert.equal(isLoopbackHostname("127.0.0.1"), true);
  assert.equal(isLoopbackHostname("::1"), true);
  assert.equal(isLoopbackHostname("localhost"), true);
  assert.equal(isLoopbackHostname("example.com"), false);
  assert.equal(isLoopbackHostname("10.1.2.3"), false);
  assert.equal(isLoopbackHostname("0.0.0.0"), false);

  assert.throws(() => resolveRunnerEndpoint(["http://example.com:9000", "tok"]), /non-loopback/);
  assert.throws(() => resolveRunnerEndpoint(["file:///tmp/sock", "tok"]), /http\(s\)/);
  assert.throws(() => resolveRunnerEndpoint([], {}), /requires a bridge url/);
  assert.throws(() => resolveRunnerEndpoint(["http://127.0.0.1:1"], {}), /requires a bridge token/);
  assert.deepEqual(resolveRunnerEndpoint([bridge.url, bridge.token]), {
    url: bridge.url,
    token: bridge.token,
  });
});

test("TestREQ_CB_TOOL_001_manifest_carries_runner_command_but_stays_fail_closed", async () => {
  const runnerCommand = [
    process.execPath,
    "--import",
    "tsx",
    RUNNER_ENTRY,
    "http://127.0.0.1:47999",
    "ephemeral-token",
  ];
  const channel = new AgyToolChannel({ runnerCommand });
  await channel.registerHostTools([
    hostTool("read", READ_SCHEMA, async () => ({ content: "body" })),
  ]);

  const registration = channel.manifest.registration;
  assert.deepEqual(registration.runnerCommand, runnerCommand, "the manifest must carry the real spawn command");
  assert.ok(registration.argv.includes(RUNNER_ENTRY), "the agy mcp add argv must embed the runner entry");
  assert.equal(channel.manifest.serverName, AGY_MCP_SERVER_DEFAULT_NAME);
  assert.equal(
    registration.applied,
    false,
    "cb-24 fail-closed: user-level agy config is not mutated without opt-in",
  );

  const dryRun = new AgyToolChannel();
  await dryRun.registerHostTools([
    hostTool("read", READ_SCHEMA, async () => ({ content: "body" })),
  ]);
  assert.deepEqual(dryRun.manifest.registration.runnerCommand, [], "no runner configured -> unchanged dry-run");
  assert.deepEqual(dryRun.manifest.registration.argv, []);
});

/**
 * Deterministic oracles for the agy ToolChannel + PermissionPolicy +
 * SteeringPolicy wiring (REQ-CB-AGY-001, design D11/D12).
 *
 * The tool half asserts the manifest lists the registered host tools with their
 * schemas verbatim and that a real MCP client listing (over a linked in-memory
 * transport) sees the same; the permission half asserts fail-closed declarative
 * enforcement at the MCP boundary with the bypass flag gated on explicit consent;
 * the steering half asserts mid-turn steers are queued and drained at the turn
 * boundary, never dropped.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  AGY_MCP_SERVER_DEFAULT_NAME,
  AGY_PERMISSION_BYPASS_FLAG,
  AgyPermissionPolicy,
  AgySteeringPolicy,
  AgyToolChannel,
  qualifiedToolName,
} from "../../src/agy/channel.ts";
import type { HostTool } from "../../src/provider/seams.ts";

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

async function connectClient(channel: AgyToolChannel): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agy-channel-test", version: "1.0.0" });
  await Promise.all([channel.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function firstText(result: { content: unknown }): string {
  const content = result.content as Array<{ type: string; text: string }>;
  assert.equal(content[0]?.type, "text");
  return content[0].text;
}

test("TestREQ_CB_AGY_001_channel_lists_host_tools_verbatim", async () => {
  const channel = new AgyToolChannel({ runnerCommand: ["node", "agy-runner.js"] });
  await channel.registerHostTools([
    hostTool("read", READ_SCHEMA, async () => ({ content: "body" })),
    hostTool("grep", GREP_SCHEMA, async () => ({ content: "match" })),
  ]);

  const manifest = channel.manifest;
  assert.equal(manifest.serverName, AGY_MCP_SERVER_DEFAULT_NAME);
  assert.equal(manifest.transport, "stdio");
  assert.deepEqual(
    manifest.tools.map((tool) => tool.name),
    ["read", "grep"],
  );
  assert.equal(manifest.tools[0].inputSchema, READ_SCHEMA, "schemas must reach the wire verbatim");
  assert.equal(manifest.tools[1].inputSchema, GREP_SCHEMA);

  assert.equal(manifest.tools[0].qualifiedName, "opencode-host__read");
  assert.equal(
    manifest.tools[1].qualifiedName,
    qualifiedToolName(AGY_MCP_SERVER_DEFAULT_NAME, "grep"),
  );
  assert.equal(new Set(manifest.tools.map((tool) => tool.qualifiedName)).size, 2, "qualified ids must not collide");

  const client = await connectClient(channel);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ["grep", "read"],
    "the spawned stdio MCP server must list the host tools",
  );
  const listedRead = listed.tools.find((tool) => tool.name === "read");
  assert.deepEqual(listedRead?.inputSchema, READ_SCHEMA, "the server must serve the verbatim schema");
  await client.close();
});

test("TestREQ_CB_AGY_001_channel_rejects_non_object_schema", async () => {
  const channel = new AgyToolChannel();
  await assert.rejects(
    () => channel.registerHostTools([hostTool("bad", { type: "string" }, async () => ({ content: "" }))]),
    (error: unknown) => {
      assert.ok(error instanceof Error, "non-object schemas must fail loudly at startup");
      assert.match(error.message, /must be an object schema/);
      assert.match(error.message, /bad/);
      return true;
    },
  );
  assert.throws(() => channel.manifest, /no manifest/, "a failed registration must not publish a manifest");
});

test("TestREQ_CB_AGY_001_channel_registration_defaults_to_dry_run", async () => {
  let registrarCalls = 0;
  const channel = new AgyToolChannel({
    runnerCommand: ["node", "agy-runner.js"],
    registrar: { register: async () => { registrarCalls += 1; } },
  });
  await channel.registerHostTools([hostTool("read", READ_SCHEMA, async () => ({ content: "body" }))]);

  const registration = channel.manifest.registration;
  assert.equal(registration.scope, "user", "agy mcp add is user-level only (probed against v1.3.2)");
  assert.equal(registration.applied, false, "user-level config must not be mutated without explicit opt-in");
  assert.equal(registrarCalls, 0);
  assert.deepEqual(registration.argv, [
    "agy",
    "mcp",
    "add",
    "--type",
    "stdio",
    "opencode-host",
    "node",
    "agy-runner.js",
  ]);
  assert.match(registration.configPathHint, /mcp_config\.json$/);
});

test("TestREQ_CB_AGY_001_channel_registers_only_with_explicit_optin", async () => {
  const requests: unknown[] = [];
  const channel = new AgyToolChannel({
    runnerCommand: ["node", "agy-runner.js"],
    allowUserLevelRegistration: true,
    registrar: {
      register: async (request) => {
        requests.push(request);
      },
    },
  });
  await channel.registerHostTools([hostTool("read", READ_SCHEMA, async () => ({ content: "body" }))]);

  assert.equal(channel.manifest.registration.applied, true);
  assert.deepEqual(requests, [{ serverName: "opencode-host", runnerCommand: ["node", "agy-runner.js"] }]);
});

test("TestREQ_CB_AGY_001_channel_optin_requires_runner_command", async () => {
  const channel = new AgyToolChannel({ allowUserLevelRegistration: true });
  await assert.rejects(
    () => channel.registerHostTools([hostTool("read", READ_SCHEMA, async () => ({ content: "body" }))]),
    /requires a runnerCommand/,
    "an opt-in registration without a runnable command must fail closed",
  );
});

test("TestREQ_CB_AGY_001_permission_fails_closed_without_consent", () => {
  const policy = new AgyPermissionPolicy();
  assert.equal(policy.supportsInteractiveApproval, false);

  const enforcement = policy.deriveEnforcement();
  assert.equal(enforcement.strategy, "declarative-allow-rules");
  assert.equal(enforcement.bypassConsent, false);
  assert.deepEqual(enforcement.argvFlags, [], "no consent means no bypass flag");
  assert.ok(!enforcement.argvFlags.includes(AGY_PERMISSION_BYPASS_FLAG));
  assert.equal(policy.toolAllowed("read"), false, "the default policy allows nothing");

  const consented = new AgyPermissionPolicy({ dangerouslySkipPermissionsConsent: true });
  assert.equal(consented.supportsInteractiveApproval, false);
  assert.deepEqual(consented.deriveEnforcement().argvFlags, [AGY_PERMISSION_BYPASS_FLAG]);

  const allowlisted = new AgyPermissionPolicy({ allowToolNames: ["read"] });
  assert.equal(allowlisted.toolAllowed("read"), true);
  assert.equal(allowlisted.toolAllowed("bash"), false);
  assert.deepEqual(allowlisted.deriveEnforcement().argvFlags, [], "allow rules alone never widen argv");
});

test("TestREQ_CB_AGY_001_channel_denies_and_allows_at_mcp_boundary", async () => {
  const calls: unknown[] = [];
  const permission = new AgyPermissionPolicy({ allowToolNames: ["read"] });
  const channel = new AgyToolChannel({ permission, runnerCommand: ["node", "agy-runner.js"] });
  await channel.registerHostTools([
    hostTool("read", READ_SCHEMA, async (input) => {
      calls.push(input);
      return { content: "file-body" };
    }),
    hostTool("bash", READ_SCHEMA, async () => ({ content: "must-not-run" })),
  ]);

  const client = await connectClient(channel);

  const allowed = await client.callTool({ name: "read", arguments: { path: "a.txt" } });
  assert.ok(!allowed.isError, "an allowlisted tool must execute");
  assert.equal(firstText(allowed), "file-body");
  assert.deepEqual(calls, [{ path: "a.txt" }], "the inline call must receive the tools/call arguments");

  const denied = await client.callTool({ name: "bash", arguments: { path: "x" } });
  assert.equal(denied.isError, true, "a non-allowlisted tool must be denied at the MCP boundary");
  assert.match(firstText(denied), /denied/);

  await client.close();
});

test("TestREQ_CB_AGY_001_steer_queued_to_turn_boundary", () => {
  const steering = new AgySteeringPolicy();
  assert.equal(steering.supportsMidTurnSteer, false);

  steering.beginTurn();
  steering.steer("first correction");
  steering.steer("second correction");
  assert.equal(steering.pendingCount, 2, "mid-turn steers must be queued, never dropped");
  assert.equal(steering.isTurnActive, true);

  steering.endTurn();
  assert.deepEqual(steering.drainAtBoundary(), [
    { event: "user", message: { content: "first correction" } },
    { event: "user", message: { content: "second correction" } },
  ]);
  assert.equal(steering.pendingCount, 0);
  assert.deepEqual(steering.drainAtBoundary(), [], "draining is idempotent after the boundary");
});

test("TestREQ_CB_AGY_001_steer_rejects_empty", () => {
  const steering = new AgySteeringPolicy();
  assert.throws(() => steering.steer("   "), /steer must not be empty/);
});

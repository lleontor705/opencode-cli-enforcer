/**
 * Oracles for the Claude ToolChannel: the in-process MCP server must serve host
 * tool schemas verbatim (REQ-CB-TOOL-001), pair calls with results by Claude's
 * tool_use id in either arrival order (REQ-CB-TOOL-002), and resolve — never
 * reject — every parked handler on teardown (REQ-CB-TOOL-003).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  TOOL_USE_ID_META,
  assertObjectSchema,
  createToolServer,
  type HostToolServer,
  type McpToolDef,
} from "../../src/mcp/server.js";
import { ToolRendezvous, type ToolResult } from "../../src/mcp/rendezvous.js";

const BASH_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", description: "Command to run" },
    timeout: { type: "integer" },
    env: {
      type: "object",
      properties: { NODE_ENV: { type: "string", enum: ["production", "test"] } },
      required: ["NODE_ENV"],
    },
  },
  required: ["command"],
  additionalProperties: false,
};

const EDIT_SCHEMA = {
  type: "object",
  properties: {
    filePath: { type: "string" },
    edits: {
      type: "array",
      description: "Ordered replacements",
      items: {
        type: "object",
        properties: {
          oldString: { type: "string" },
          newString: { type: "string" },
        },
        required: ["oldString", "newString"],
      },
    },
  },
  required: ["filePath", "edits"],
};

const READ_SCHEMA = {
  type: "object",
  properties: {
    filePath: { type: "string" },
    offset: { type: "integer" },
    either: { anyOf: [{ type: "string" }, { type: "number" }] },
  },
  required: ["filePath"],
};

const unusedHandler = async (): Promise<ToolResult> => ({
  content: [{ type: "text", text: "unused" }],
});

function textOf(result: ToolResult): string {
  const block = result.content[0];
  assert.equal(block?.type, "text");
  return block.text;
}

function textFromResponse(response: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  const block = response.content.find((part) => part.type === "text");
  assert.ok(block, "response had no text content block");
  return block.text ?? "";
}

async function connectToolServer(server: HostToolServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code-test", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.instance.connect(serverTransport),
  ]);
  return client;
}

test("TestREQ_CB_TOOL_001_mcp_server_lists_host_tools", async () => {
  const server = createToolServer("host-tools", [
    { name: "bash", description: "Run a shell command", inputSchema: BASH_SCHEMA, handler: unusedHandler },
    { name: "edit", description: "Apply file edits", inputSchema: EDIT_SCHEMA, handler: unusedHandler },
    { name: "read", description: "Read a file", inputSchema: READ_SCHEMA, handler: unusedHandler },
  ]);
  const client = await connectToolServer(server);

  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["bash", "edit", "read"],
    );

    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    // Verbatim means byte-for-byte in intent: nothing below the top level may
    // collapse to an open record on the way out.
    assert.deepEqual(byName.get("bash")?.inputSchema, BASH_SCHEMA);
    assert.deepEqual(byName.get("edit")?.inputSchema, EDIT_SCHEMA);
    assert.deepEqual(byName.get("read")?.inputSchema, READ_SCHEMA);
    assert.equal(byName.get("bash")?.description, "Run a shell command");
  } finally {
    await client.close();
  }
});

test("TestREQ_CB_TOOL_001_non_object_schema_throws_at_startup", () => {
  const scalarTool: McpToolDef = {
    name: "ask_user_question",
    description: "scalar parameters",
    inputSchema: { type: "string" },
    handler: unusedHandler,
  };
  assert.throws(
    () => createToolServer("host-tools", [scalarTool]),
    /ask_user_question: MCP tool parameters must be an object schema/,
  );

  const arrayTool: McpToolDef = { ...scalarTool, name: "list_files", inputSchema: { type: "array" } };
  assert.throws(() => assertObjectSchema(arrayTool), /list_files/);

  const missingTool: McpToolDef = { ...scalarTool, name: "opaque_tool", inputSchema: undefined };
  assert.throws(() => assertObjectSchema(missingTool), /opaque_tool/);

  // A valid object schema is accepted without throwing.
  assert.doesNotThrow(() => assertObjectSchema({ ...scalarTool, name: "ok", inputSchema: { type: "object", properties: {} } }));
});

test("TestREQ_CB_TOOL_001_call_pairs_by_tool_use_id_and_skips_validation", async () => {
  const rendezvous = new ToolRendezvous();
  let resolveToolUseId!: (value: string) => void;
  const toolUseIdSeen = new Promise<string>((resolve) => {
    resolveToolUseId = resolve;
  });

  // The handler parks on the rendezvous exactly as the ToolChannel does, so this
  // covers the wire path from _meta to the parked resolver.
  const server = createToolServer("host-tools", [
    {
      name: "bash",
      description: "Run a shell command",
      inputSchema: BASH_SCHEMA,
      handler: async (toolUseId) => {
        resolveToolUseId(toolUseId);
        return rendezvous.awaitToolResult(toolUseId, "bash");
      },
    },
  ]);
  const client = await connectToolServer(server);

  try {
    // `extra` does not satisfy the schema; MCP must not validate it away — the
    // host owns validation, and a rejection here would strand the call.
    const call = client.callTool({
      name: "bash",
      arguments: { command: "ls", extra: true },
      _meta: { [TOOL_USE_ID_META]: "toolu_alpha" },
    });

    assert.equal(await toolUseIdSeen, "toolu_alpha");
    assert.equal(rendezvous.pendingToolCallCount, 1);

    rendezvous.deliverToolResult("toolu_alpha", { content: [{ type: "text", text: "command output" }] });
    const response = await call;
    assert.equal(textFromResponse(response), "command output");
    assert.equal(rendezvous.pendingToolCallCount, 0);
  } finally {
    await client.close();
  }
});

test("TestREQ_CB_TOOL_001_call_without_tool_use_id_fails_loud", async () => {
  let handlerCalls = 0;
  const server = createToolServer("host-tools", [
    {
      name: "bash",
      description: "Run a shell command",
      inputSchema: BASH_SCHEMA,
      handler: async () => {
        handlerCalls += 1;
        return { content: [{ type: "text", text: "unreachable" }] };
      },
    },
  ]);
  const client = await connectToolServer(server);

  try {
    await assert.rejects(
      client.callTool({ name: "bash", arguments: { command: "ls" } }),
      (error: unknown) => {
        assert.match(String((error as Error).message), /toolUseId/i);
        return true;
      },
    );
    await assert.rejects(client.callTool({ name: "nope", arguments: {} }), /Unknown tool/);
    assert.equal(handlerCalls, 0, "handler must not run without an id to pair its result to");
  } finally {
    await client.close();
  }
});

test("TestREQ_CB_TOOL_002_tool_use_id_pairing", async () => {
  // Call-first: the handler parks, then the result arrives and unblocks it once.
  const rendezvous = new ToolRendezvous();
  const parked = rendezvous.awaitToolResult("T1", "bash");
  assert.equal(rendezvous.pendingToolCallCount, 1);
  const first = rendezvous.deliverToolResult("T1", { content: [{ type: "text", text: "R1" }] });
  assert.equal(first, true, "a delivered result must report that it unblocked a handler");
  assert.equal(textOf(await parked), "R1");
  assert.equal(rendezvous.pendingToolCallCount, 0);
  // A second result for the same id is buffered, never re-resolved.
  assert.equal(rendezvous.deliverToolResult("T1", { content: [{ type: "text", text: "R1-again" }] }), false);
  assert.equal(rendezvous.pendingResultCount, 1);

  // Result-first: the result waits until the call is parked.
  const resultFirst = new ToolRendezvous();
  assert.equal(resultFirst.deliverToolResult("T1", { content: [{ type: "text", text: "R1" }] }), false);
  assert.equal(resultFirst.pendingResultCount, 1);
  const late = resultFirst.awaitToolResult("T1", "bash");
  assert.equal(textOf(await late), "R1");
  assert.equal(resultFirst.pendingResultCount, 0);

  // Parallel calls with out-of-order results pair by id, zero mispairing.
  const parallel = new ToolRendezvous();
  const p1 = parallel.awaitToolResult("T1", "bash");
  const p2 = parallel.awaitToolResult("T2", "edit");
  parallel.deliverToolResult("T2", { content: [{ type: "text", text: "R2" }] });
  parallel.deliverToolResult("T1", { content: [{ type: "text", text: "R1" }] });
  assert.equal(textOf(await p1), "R1");
  assert.equal(textOf(await p2), "R2");
  assert.equal(parallel.pendingToolCallCount, 0);
  assert.equal(parallel.pendingResultCount, 0);

  // A result for an unknown id queues without ever touching an unrelated call.
  const queued = new ToolRendezvous();
  const onlyCall = queued.awaitToolResult("T1", "bash");
  assert.equal(queued.deliverToolResult("T9", { content: [{ type: "text", text: "R9" }] }), false);
  assert.equal(queued.pendingResultCount, 1);
  queued.deliverToolResult("T1", { content: [{ type: "text", text: "R1" }] });
  assert.equal(textOf(await onlyCall), "R1");
  const t9 = queued.awaitToolResult("T9", "read");
  assert.equal(textOf(await t9), "R9");
  assert.equal(queued.pendingResultCount, 0);
});

test("TestREQ_CB_TOOL_003_parked_handlers_resolved_on_release", async () => {
  const rendezvous = new ToolRendezvous();
  const first = rendezvous.awaitToolResult("T1", "bash");
  const second = rendezvous.awaitToolResult("T2", "edit");
  assert.equal(rendezvous.pendingToolCallCount, 2);

  rendezvous.releasePendingToolCalls("Operation aborted");

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.isError, true);
  assert.equal(secondResult.isError, true);
  assert.equal(textOf(firstResult), "Operation aborted");
  assert.equal(textOf(secondResult), "Operation aborted");
  assert.equal(rendezvous.pendingToolCallCount, 0);
  assert.equal(rendezvous.pendingResultCount, 0);
});

test("TestREQ_CB_TOOL_003_release_is_empty_safe_and_discards_queued_results", async () => {
  const empty = new ToolRendezvous();
  assert.doesNotThrow(() => empty.releasePendingToolCalls("Query ended"));
  assert.equal(empty.pendingToolCallCount, 0);
  assert.equal(empty.pendingResultCount, 0);

  const mixed = new ToolRendezvous();
  const parked = mixed.awaitToolResult("T1", "bash");
  mixed.deliverToolResult("T2", { content: [{ type: "text", text: "R2" }] });
  assert.equal(mixed.pendingResultCount, 1);

  mixed.releasePendingToolCalls("Query ended");

  assert.equal(textOf(await parked), "Query ended");
  assert.equal(mixed.pendingToolCallCount, 0);
  assert.equal(mixed.pendingResultCount, 0);
  assert.equal(mixed.hasPendingResult("T2"), false, "the queued result must be discarded, not replayed");
  // Releasing again is a no-op: the parked handler is not resolved twice.
  assert.doesNotThrow(() => mixed.releasePendingToolCalls("Query ended again"));
  assert.equal(mixed.pendingToolCallCount, 0);
});

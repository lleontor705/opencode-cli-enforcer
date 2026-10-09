/**
 * In-process MCP server exposing OpenCode host tools to Claude Code
 * (REQ-CB-TOOL-001, D3).
 *
 * Handlers are registered on the underlying protocol server rather than through
 * the SDK's Zod-only `McpServer.registerTool`, so tool input schemas reach
 * Claude Code verbatim as JSON Schema and MCP performs no argument validation:
 * the host validates and executes tools itself. A rejection here would only
 * prevent the handler from running and strand the call.
 *
 * The SDK's `connectSdkMcpServer` treats the instance as an opaque JSON-RPC
 * endpoint (it only calls `instance.connect(transport)`), so none of
 * McpServer's higher-level machinery is required — the wrapper is kept only
 * because the SDK's `mcpServers` option is typed against that class. If an SDK
 * update starts inspecting the instance (reading registered tools, expecting
 * tools/list_changed notifications), this breaks loudly at connect time.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

import type { ToolResult } from "./rendezvous.js";

/**
 * Claude Code stamps every tools/call with the id of the tool_use block it came
 * from. That is the only reliable way to pair a call with its result: call
 * order is not guaranteed to match the order the tool_use blocks were emitted.
 *
 * This is a Claude Code extension, not part of the MCP spec. If CC ever stops
 * sending it, every tool call fails with the error below instead of silently
 * pairing results to the wrong call.
 */
export const TOOL_USE_ID_META = "claudecode/toolUseId";

type ToolInputSchema = ListToolsResult["tools"][number]["inputSchema"];

export interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly handler: (toolUseId: string) => Promise<ToolResult>;
}

export interface HostToolServer {
  readonly type: "sdk";
  readonly name: string;
  readonly instance: McpServer;
}

/**
 * MCP requires an object-typed input schema. A scalar or array schema typechecks
 * at the tool declaration but cannot go on the wire; degrading it to "takes no
 * arguments" would surface much later as Claude calling the tool with no
 * arguments, so name the culprit at startup instead.
 */
export function assertObjectSchema(tool: McpToolDef): void {
  const schema = tool.inputSchema as Record<string, unknown> | null | undefined;
  if (!schema || schema.type !== "object") {
    throw new Error(
      `${tool.name}: MCP tool parameters must be an object schema, got ${JSON.stringify(schema)}`,
    );
  }
}

export function createToolServer(name: string, tools: readonly McpToolDef[]): HostToolServer {
  for (const tool of tools) assertObjectSchema(tool);

  const server = new McpServer({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as ToolInputSchema,
    })),
  }));

  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
    const toolUseId = request.params._meta?.[TOOL_USE_ID_META];
    if (typeof toolUseId !== "string") {
      throw new Error(
        `${tool.name}: tools/call is missing _meta["${TOOL_USE_ID_META}"] — cannot pair the result with its tool call`,
      );
    }
    const { content, isError } = await tool.handler(toolUseId);
    return { content: [...content], isError };
  });

  return { type: "sdk", name, instance: server };
}

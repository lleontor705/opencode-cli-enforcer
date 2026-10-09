/**
 * Long-lived parked Agent SDK query lifecycle (REQ-CB-TOOL-005, design D3).
 *
 * One `query()` per OpenCode session is spawned with `prompt: AsyncIterable`
 * (the ack-carrying {@link PromptStream}) and kept parked: a new turn writes
 * into the live stream instead of respawning the child. `tools: []` disables
 * every built-in so all real tools reach Claude Code through the in-process MCP
 * server, and `permissionMode: "bypassPermissions"` is honest because OpenCode
 * owns approval and executes the tools itself.
 *
 * Child env hygiene goes through `buildChildEnv` (cb-03):
 * `ENABLE_CLAUDEAI_MCP_SERVERS=0` keeps the user's claude.ai cloud connectors
 * out, `DISABLE_AUTO_COMPACT=1` keeps OpenCode the sole compactor, and every
 * `ANTHROPIC_*` variable is scrubbed so an exported `ANTHROPIC_API_KEY` cannot
 * hijack the subscription CLI. `--strict-mcp-config` (the typed `strictMcpConfig`
 * option on this SDK) plus `claudeMdExcludes` keep filesystem MCP servers and
 * project memory out of the prompt.
 *
 * Reconciliation (cb-07 open question): the two-map tool rendezvous is owned by
 * `ToolRendezvous` (cb-06) alone. This module never creates or aliases a second
 * pair of maps, and `QueryContext.pendingToolCalls` / `pendingResults` are left
 * untouched; tool delivery routes through the rendezvous instance (see
 * `tool-delivery.ts`). The caller (the LanguageModelV3 adapter, cb-12) owns that
 * instance and hands it to both the MCP handlers and the delivery pump.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { buildChildEnv } from "../config/schema.js";
import type { ResolvedChildEnv } from "../config/schema.js";
import { createToolServer } from "../mcp/server.js";
import type { McpToolDef } from "../mcp/server.js";
import { ClaudeEventMapper } from "../stream/mapping.js";
import type { ClaudeRawEvent, NormalizedClaudeEvent } from "../stream/mapping.js";
import { makePromptStream } from "./prompt-stream.js";
import type { PromptStream } from "./prompt-stream.js";
import { QueryContext } from "./query-state.js";

/** Key the host tools are served under; their CC names become `mcp__<name>__*`. */
export const MCP_SERVER_NAME = "opencode";

/** Project memory that must never enter the prompt: OpenCode owns context. */
export const CLAUDE_MD_EXCLUDES = [
  "**/CLAUDE.md",
  "**/AGENTS.md",
  "**/.claude/rules/**",
] as const;

export interface QueryLifecycleOptions {
  readonly hostTools?: readonly McpToolDef[];
  readonly cwd?: string;
  readonly model?: string;
  /** Omit to inherit `process.env` before hygiene is applied. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /** Overrides the resolved hygiene set (tests, alternate profiles). */
  readonly childEnv?: ResolvedChildEnv;
  readonly resume?: string;
  readonly systemPrompt?: Options["systemPrompt"];
  /** Defaults to true: only the programmatic MCP servers are used. */
  readonly strictMcpConfig?: boolean;
  readonly extraArgs?: Record<string, string | null>;
}

export interface QueryOptionsBuild {
  readonly options: Options;
  readonly mcpServerCount: number;
}

/**
 * Build the SDK query options. Pure and synchronous so the spawn config is
 * assertable without launching a child process.
 */
export function buildQueryOptions(config: QueryLifecycleOptions): QueryOptionsBuild {
  const hostTools = config.hostTools ?? [];
  const mcpServers =
    hostTools.length > 0
      ? { [MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, hostTools) }
      : undefined;

  const options: Options = {
    env: buildChildEnv(config.baseEnv ?? process.env, config.childEnv),
    tools: [],
    permissionMode: "bypassPermissions",
    // Required by the SDK whenever bypassPermissions is requested; OpenCode owns
    // approval and this child runs `tools: []`, so there is nothing to approve.
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    strictMcpConfig: config.strictMcpConfig ?? true,
    settings: { claudeMdExcludes: [...CLAUDE_MD_EXCLUDES] },
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    ...(config.model !== undefined ? { model: config.model } : {}),
    ...(config.resume !== undefined ? { resume: config.resume } : {}),
    ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
    ...(config.extraArgs !== undefined ? { extraArgs: config.extraArgs } : {}),
  };

  return { options, mcpServerCount: mcpServers === undefined ? 0 : 1 };
}

/** Injectable spawner seam; lets tests assert the config without a live CLI. */
export type QuerySpawner = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => Query;

export interface SpawnQueryOptions extends QueryLifecycleOptions {
  /** Reuse an existing context (reentrant queries stay isolated per instance). */
  readonly context?: QueryContext;
  readonly spawnImpl?: QuerySpawner;
}

export interface SpawnedQuery {
  readonly context: QueryContext;
  readonly promptStream: PromptStream;
  readonly handle: Query;
}

/**
 * Spawn the parked query. The caller pushes the first user message and, per
 * turn, writes steers/results; the query is never respawned between turns.
 */
export function spawnQuery(config: SpawnQueryOptions): SpawnedQuery {
  const context = config.context ?? new QueryContext();
  const promptStream = makePromptStream();
  context.promptStream = promptStream;

  const { options } = buildQueryOptions(config);
  const handle = (config.spawnImpl ?? query)({ prompt: promptStream.stream, options });
  context.activeQuery = handle;

  return { context, promptStream, handle };
}

export interface ConsumeQueryOptions {
  readonly context: QueryContext;
  readonly mapper: ClaudeEventMapper;
  readonly wasAborted?: () => boolean;
  /** Sink for normalized events; the LanguageModelV3 adapter renders them. */
  readonly onEvents?: (events: readonly NormalizedClaudeEvent[]) => void;
}

export interface ConsumeQueryResult {
  readonly capturedSessionId: string | undefined;
  readonly aborted: boolean;
}

/**
 * Pump the SDK generator into `QueryContext` + the event mapper until the query
 * ends or is aborted. The `result` frame closes the prompt stream: with a
 * streamed prompt (`isSingleUserTurn` false) the SDK no longer closes CC's
 * stdin on its own, so the bridge must end it or the child never exits.
 */
export async function consumeQuery(
  handle: Query,
  config: ConsumeQueryOptions,
): Promise<ConsumeQueryResult> {
  const wasAborted = config.wasAborted ?? (() => false);
  let aborted = false;

  for await (const message of handle) {
    if (wasAborted()) {
      aborted = true;
      break;
    }
    if (message.type === "result") config.context.promptStream?.end();
    const events = config.mapper.map(toRawEvent(message));
    if (events.length > 0) config.onEvents?.(events);
  }

  return { capturedSessionId: config.mapper.capturedSessionId, aborted };
}

/**
 * The SDK's `SDKMessage` union is wider than the permissive view the mapper
 * understands; the mapper narrows every field it reads and ignores the rest.
 */
function toRawEvent(message: SDKMessage): ClaudeRawEvent {
  return message as unknown as ClaudeRawEvent;
}

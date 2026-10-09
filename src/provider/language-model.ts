/**
 * Custom LanguageModelV3 adapter: the OpenCode generation surface for the
 * claude-bridge provider (REQ-CB-PROV-002, design D1/D6).
 *
 * `registration.ts` binds a `LanguageModelFactory` into the `aisdk.hook("language")`
 * seam. This module is that factory's real implementation: it owns the per-query
 * state cb-11 extracted (`spawnQuery`, `deliverToolResults`) and turns the SDK
 * child's message stream into `LanguageModelV3StreamPart`s via the cb-08 mapper.
 *
 * Three load-bearing behaviours, each with a dedicated oracle:
 *
 * - One SDK query spans a user turn (including every tool round-trip). The pump
 *   runs in the background for the life of the query and routes events into the
 *   *current* turn's sink. A step is not respawned between tool calls; the tool
 *   result is delivered into the parked query and the next `doStream` claims a
 *   fresh sink on it.
 * - A turn that asked for a tool ENDS at the SDK `message_stop` that carries the
 *   tool_use block. OpenCode only executes the tool once the step stream closes,
 *   so waiting for the terminal `result` frame (which CC emits only after the
 *   tool ran) would deadlock. The synthesized `finish` reuses the cb-08 fold so
 *   its usage and finish reason stay identical to the mapper's own finish.
 * - `options.abortSignal` aborts the SDK query, settles every parked MCP handler
 *   and the prompt stream, and ends the step with an `error` part — never a hang.
 *   The release is bounded to the query's own session-scoped rendezvous, so one
 *   session's abort cannot unblock another session's parked `tools/call` (cb-28).
 *
 * There is deliberately no fallback to a native Anthropic HTTP provider (D1):
 * the only stream source is the SDK query pump.
 */

import type { Model } from "@opencode/plugin";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

import { bridgeError, toBridgeError } from "../errors/taxonomy.js";
import type { ResolvedChildEnv } from "../config/schema.js";
import { ToolRendezvous } from "../mcp/rendezvous.js";
import type { McpToolDef } from "../mcp/server.js";
import { ClaudeEventMapper, renderNormalizedEvents, toLanguageModelV3Usage } from "../stream/mapping.js";
import type { ClaudeRawEvent, NormalizedClaudeEvent, NotifyFn } from "../stream/mapping.js";
import {
  CLAUDE_BRIDGE_PROVIDER_ID,
  DEFAULT_LONG_CONTEXT_SETTINGS,
  resolveClaudeCodeRuntimeModel,
  type LongContextSettings,
} from "./models.js";
import { QueryContext } from "./query-state.js";
import { spawnQuery } from "./query-lifecycle.js";
import type { QuerySpawner, SpawnedQuery } from "./query-lifecycle.js";
import { userMessage } from "./prompt-stream.js";
import { deliverToolResults } from "./tool-delivery.js";

/** A host tool this adapter serves to Claude Code over the in-process MCP server. */
export interface HostToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

/** Host request header OpenCode carries the session identity on. */
export const SESSION_ID_HEADER = "x-opencode-session";

/**
 * Lazily-created rendezvous per session identity. `ClaudeBridgeQuery.abort()`
 * releases only the scope it resolved, so one session's abort cannot unblock
 * another session's parked `tools/call`. Named scopes are shared through the
 * entry so a re-resolved model for the same session reuses the same store.
 */
export class RendezvousScopes {
  private readonly scopes = new Map<string, ToolRendezvous>();

  get(sessionKey: string): ToolRendezvous {
    let scope = this.scopes.get(sessionKey);
    if (scope === undefined) {
      scope = new ToolRendezvous();
      this.scopes.set(sessionKey, scope);
    }
    return scope;
  }

  has(sessionKey: string): boolean {
    return this.scopes.has(sessionKey);
  }

  get size(): number {
    return this.scopes.size;
  }
}

/** The parked query handed to the entry's spawn-tracking seam. */
export interface ClaudeBridgeSpawn {
  readonly context: QueryContext;
  readonly rendezvous: ToolRendezvous;
  readonly sessionKey: string | undefined;
}

export interface ClaudeBridgeLanguageModelConfig {
  readonly settings?: LongContextSettings;
  readonly hostTools?: readonly HostToolDefinition[];
  /** Fixed scope for hosts that do not supply a session identity (cb-11 adapt path). */
  readonly rendezvous?: ToolRendezvous;
  /** Shared per-session scope registry; the entry passes one across sessions. */
  readonly rendezvousScopes?: RendezvousScopes;
  /** Resolves the session identity; defaults to {@link SESSION_ID_HEADER}. */
  readonly sessionKeyOf?: (options: LanguageModelV3CallOptions) => string | undefined;
  /** Spawn-tracking seam: the entry registers the context for teardown/leak scans. */
  readonly onSpawn?: (spawn: ClaudeBridgeSpawn) => void;
  readonly cwd?: string;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly childEnv?: ResolvedChildEnv;
  readonly systemPrompt?: Options["systemPrompt"];
  readonly strictMcpConfig?: boolean;
  readonly extraArgs?: Record<string, string | null>;
  readonly notify?: NotifyFn;
  /** Claude Code tool name -> host tool name. `undefined` skips an unserved tool. */
  readonly resolveToolName?: (name: string) => string | undefined;
  /** Injectable spawner seam; tests assert against a scripted query, no CLI. */
  readonly spawnImpl?: QuerySpawner;
}

const EMPTY_LMV3_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

interface OpenTurn {
  readonly controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>;
}

/**
 * Drives one parked SDK query and multiplexes it across the successive step
 * streams OpenCode requests from `doStream`.
 */
class ClaudeBridgeQuery {
  private readonly model: Model.Info;
  private readonly config: ClaudeBridgeLanguageModelConfig;
  private readonly context = new QueryContext();
  private readonly scopes: RendezvousScopes | undefined;
  private readonly mapper: ClaudeEventMapper;

  /** Resolved once per query: a parked query serves exactly one session. */
  private scope: ToolRendezvous | null = null;
  private sessionKey: string | undefined;

  private spawned: SpawnedQuery | null = null;
  private turn: OpenTurn | null = null;
  private turnRaws: ClaudeRawEvent[] = [];
  private sessionId: string | undefined;
  private aborted = false;

  constructor(model: Model.Info, config: ClaudeBridgeLanguageModelConfig) {
    this.model = model;
    this.config = config;
    this.scopes = config.rendezvousScopes;
    this.mapper = new ClaudeEventMapper({
      query: this.context,
      ...(config.notify !== undefined ? { notify: config.notify } : {}),
      ...(config.resolveToolName !== undefined ? { resolveToolName: config.resolveToolName } : {}),
    });
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    if (options.abortSignal?.aborted) return { stream: abortedStream() };

    const rendezvous = this.resolveScope(options);
    this.ensureQuery(rendezvous);
    const stream = this.startTurn();

    const hasToolResults = promptHasToolResults(options.prompt);
    if (hasToolResults) {
      try {
        await deliverToolResults({
          context: this.context,
          rendezvous,
          prompt: options.prompt,
          ...(this.config.notify !== undefined ? { notify: this.config.notify } : {}),
        });
      } catch (error) {
        this.fail(error);
      }
    }

    this.pushPrompt(options.prompt, hasToolResults);
    this.bindAbort(options.abortSignal);
    return { stream };
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const { stream } = await this.doStream(options);
    const reader = stream.getReader();
    let text = "";
    let finishReason: LanguageModelV3FinishReason = { unified: "other", raw: undefined };
    let usage: LanguageModelV3Usage = EMPTY_LMV3_USAGE;
    const content: LanguageModelV3Content[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type === "text-delta") text += value.delta;
      else if (value.type === "tool-call" || value.type === "tool-result") content.push(value);
      else if (value.type === "finish") {
        finishReason = value.finishReason;
        usage = value.usage;
      }
    }

    if (text.length > 0) content.unshift({ type: "text", text });
    return { content, finishReason, usage, warnings: [] };
  }

  // -- Query lifecycle ------------------------------------------------------

  /**
   * Resolve the session-scoped rendezvous once per query. A named identity with
   * a shared registry yields one store per session; without either, a private
   * store is created so key-less hosts are still isolated per query instance.
   */
  private resolveScope(options: LanguageModelV3CallOptions): ToolRendezvous {
    if (this.scope !== null) return this.scope;
    const key = (this.config.sessionKeyOf ?? sessionKeyFromOptions)(options);
    this.sessionKey = key;
    this.scope =
      key !== undefined && this.scopes !== undefined
        ? this.scopes.get(key)
        : this.config.rendezvous ?? new ToolRendezvous();
    return this.scope;
  }

  private ensureQuery(rendezvous: ToolRendezvous): void {
    if (this.spawned !== null) return;
    this.aborted = false;

    const spawned = spawnQuery({
      context: this.context,
      hostTools: this.buildHostTools(rendezvous),
      model: resolveClaudeCodeRuntimeModel(
        this.model,
        this.config.settings ?? DEFAULT_LONG_CONTEXT_SETTINGS,
      ).cliModelId,
      ...(this.config.cwd !== undefined ? { cwd: this.config.cwd } : {}),
      ...(this.config.baseEnv !== undefined ? { baseEnv: this.config.baseEnv } : {}),
      ...(this.config.childEnv !== undefined ? { childEnv: this.config.childEnv } : {}),
      ...(this.config.systemPrompt !== undefined ? { systemPrompt: this.config.systemPrompt } : {}),
      ...(this.config.strictMcpConfig !== undefined
        ? { strictMcpConfig: this.config.strictMcpConfig }
        : {}),
      ...(this.config.extraArgs !== undefined ? { extraArgs: this.config.extraArgs } : {}),
      ...(this.config.spawnImpl !== undefined ? { spawnImpl: this.config.spawnImpl } : {}),
      ...(this.sessionId !== undefined ? { resume: this.sessionId } : {}),
    });

    this.spawned = spawned;
    this.config.onSpawn?.({ context: this.context, rendezvous, sessionKey: this.sessionKey });
    void this.pump(spawned);
  }

  private buildHostTools(rendezvous: ToolRendezvous): McpToolDef[] {
    return (this.config.hostTools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      handler: (toolUseId) => rendezvous.awaitToolResult(toolUseId, tool.name),
    }));
  }

  private async pump(spawned: SpawnedQuery): Promise<void> {
    try {
      for await (const message of spawned.handle) {
        if (this.aborted) break;
        const raw = message as unknown as ClaudeRawEvent;
        if (typeof raw.session_id === "string") this.sessionId = raw.session_id;
        if (raw.type === "result") spawned.promptStream.end();
        if (this.turn !== null) this.turnRaws.push(raw);

        const events = this.mapper.map(raw);
        if (events.length > 0) this.emit(events);
        if (this.turn !== null && this.isToolBoundary(raw)) this.finishToolTurn();
      }
    } catch (error) {
      this.fail(error);
    } finally {
      if (this.spawned === spawned) this.spawned = null;
      this.closeTurn();
    }
  }

  // -- Turn multiplexing ----------------------------------------------------

  private startTurn(): ReadableStream<LanguageModelV3StreamPart> {
    this.mapper.resetTurn();
    this.turnRaws = [];
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: (controller) => {
        this.turn = { controller };
      },
    });
    this.pushPart({ type: "stream-start", warnings: [] });
    return stream;
  }

  private emit(events: readonly NormalizedClaudeEvent[]): void {
    for (const part of renderNormalizedEvents(events)) this.pushPart(part);
    if (events.some((event) => event.kind === "finish" || event.kind === "error")) this.closeTurn();
  }

  /**
   * A turn that produced tool calls is complete at the SDK message_stop: CC is
   * now blocked on the MCP tools/call, so no `result` frame will arrive until
   * OpenCode has executed the tools and answered.
   */
  private isToolBoundary(raw: ClaudeRawEvent): boolean {
    if (!this.context.turnSawToolCall) return false;
    if (raw.type === "assistant") return true;
    return raw.type === "stream_event" && raw.event?.type === "message_stop";
  }

  private finishToolTurn(): void {
    // Fold the turn's own events so the synthesized finish carries the same
    // usage and raw reason the mapper would have emitted from a result frame.
    const usage = this.mapper.toTurnResult(this.turnRaws).usage;
    this.pushPart({
      type: "finish",
      usage: toLanguageModelV3Usage(usage),
      finishReason: { unified: "tool-calls", raw: lastStopReason(this.turnRaws) ?? "tool_use" },
    });
    this.closeTurn();
  }

  private pushPart(part: LanguageModelV3StreamPart): void {
    const turn = this.turn;
    if (turn === null) return;
    try {
      turn.controller.enqueue(part);
    } catch {
      // The consumer cancelled the stream; stop enqueuing into it.
      this.turn = null;
    }
  }

  private closeTurn(): void {
    const turn = this.turn;
    if (turn === null) return;
    this.turn = null;
    try {
      turn.controller.close();
    } catch {
      // Already closed or cancelled by the reader.
    }
  }

  private fail(error: unknown): void {
    this.pushPart({ type: "error", error: toBridgeError(error, "stream", "CB_STREAM_MAPPING_FAILED") });
    this.closeTurn();
  }

  private pushPrompt(prompt: LanguageModelV3Prompt, hasToolResults: boolean): void {
    const last = prompt[prompt.length - 1];
    if (last === undefined || last.role !== "user") return;
    const stream = this.context.promptStream;
    if (stream === null) {
      this.fail(bridgeError("stream", "CB_STREAM_MAPPING_FAILED", "claude-bridge: no live query to prompt"));
      return;
    }
    const text = userMessageText(last);
    const content = text.length > 0 ? text : "[continue]";
    void stream.push(userMessage(content, hasToolResults ? "next" : undefined)).catch((error) => {
      this.fail(error);
    });
  }

  // -- Abort ----------------------------------------------------------------

  private bindAbort(signal: AbortSignal | undefined): void {
    if (signal === undefined) return;
    if (signal.aborted) {
      this.abort();
      return;
    }
    signal.addEventListener("abort", this.onAbort, { once: true });
  }

  private readonly onAbort = (): void => {
    this.abort();
  };

  private abort(): void {
    if (this.aborted) return;
    this.aborted = true;

    const spawned = this.spawned;
    spawned?.promptStream.fail(new Error("claude-bridge: query aborted"));
    this.scope?.releasePendingToolCalls("claude-bridge: query aborted");
    if (spawned !== null) {
      void spawned.handle.interrupt().catch(() => {});
      try {
        spawned.handle.close();
      } catch {
        // Already closed.
      }
    }

    this.pushPart({
      type: "error",
      error: bridgeError("stream", "CB_STREAM_ABORTED", "claude-bridge: stream aborted by abortSignal"),
    });
    this.closeTurn();
  }
}

/** Build the custom `LanguageModelV3` registration binds for one claude-bridge model. */
export function createClaudeBridgeLanguageModel(
  model: Model.Info,
  config: ClaudeBridgeLanguageModelConfig = {},
): LanguageModelV3 {
  const query = new ClaudeBridgeQuery(model, config);
  return {
    specificationVersion: "v3",
    provider: CLAUDE_BRIDGE_PROVIDER_ID,
    modelId: model.id,
    supportedUrls: {},
    doGenerate: (options) => query.doGenerate(options),
    doStream: (options) => query.doStream(options),
  };
}

/** `LanguageModelFactory` shape `registration.ts` accepts via `options.languageModelFactory`. */
export function createClaudeBridgeLanguageModelFactory(
  config: ClaudeBridgeLanguageModelConfig = {},
): (model: Model.Info) => LanguageModelV3 {
  return (model) => createClaudeBridgeLanguageModel(model, config);
}

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

function abortedStream(): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue({
        type: "error",
        error: bridgeError("stream", "CB_STREAM_ABORTED", "claude-bridge: request aborted before streaming"),
      });
      controller.close();
    },
  });
}

/**
 * The stablest session identity the LMV3 call options expose. OpenCode does not
 * type a session field on `LanguageModelV3CallOptions`; the host carries it on
 * the standard headers map (`x-opencode-session`), with provider options as a
 * secondary channel. No identity => `undefined`, which falls back to a
 * per-instance scope.
 */
function sessionKeyFromOptions(options: LanguageModelV3CallOptions): string | undefined {
  const header = options.headers?.[SESSION_ID_HEADER];
  if (typeof header === "string" && header.length > 0) return header;

  const opencode = options.providerOptions?.["opencode"];
  if (typeof opencode === "object" && opencode !== null) {
    const id = (opencode as { sessionID?: unknown }).sessionID;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}

function promptHasToolResults(prompt: LanguageModelV3Prompt): boolean {
  for (const message of prompt) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-result") return true;
    }
  }
  return false;
}

function userMessageText(message: Extract<LanguageModelV3Message, { role: "user" }>): string {
  const parts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text" && part.text) parts.push(part.text);
  }
  return parts.join("\n");
}

function lastStopReason(raws: readonly ClaudeRawEvent[]): string | undefined {
  for (let index = raws.length - 1; index >= 0; index -= 1) {
    const raw = raws[index];
    if (raw === undefined) continue;
    if (raw.type === "result") return "stop";
    const stopReason = raw.event?.delta?.stop_reason;
    if (raw.event?.type === "message_delta" && typeof stopReason === "string") return stopReason;
  }
  return undefined;
}

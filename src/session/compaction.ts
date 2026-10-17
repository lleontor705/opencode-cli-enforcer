/**
 * Host-owned compaction via an isolated summarizer lane (REQ-CB-CMPR-001, D7).
 *
 * OpenCode requests compaction through `ctx.session.hook("compaction")`. Setting
 * `input.result` satisfies the request and makes the host skip its own model
 * call, so a cli-providers generation is never spent on compaction.
 *
 * The summary is produced by a throwaway SDK query that shares nothing with the
 * session's parked query or the Claude Code mirror: a plain string prompt,
 * `persistSession: false` (no transcript written or resumed), `maxTurns: 1`,
 * `tools: []`, and every filesystem settings source and skill disabled. The
 * child environment is scrubbed by `buildChildEnv` (cb-03) exactly like the
 * parked lane, so an exported `ANTHROPIC_*` cannot reach the summarizer either.
 *
 * Failure is non-fatal by contract: the hook leaves `result` unset so the host
 * falls back to its default compaction, and the failure is reported with a
 * closed taxonomy code (cb-04). It never throws, because throwing would abort a
 * compaction the host could otherwise complete on its own.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  NonNullableUsage,
  Options,
  SDKAssistantMessage,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Plugin } from "@opencode/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import type { SessionCompaction } from "@opencode/plugin/promise/session";

import { buildChildEnv } from "../config/schema.js";
import type { ResolvedChildEnv } from "../config/schema.js";
import {
  BridgeError,
  bridgeError,
  classifyTransportError,
  isTransientTransportError,
} from "../errors/taxonomy.js";

/** Token accounting in the `SessionCompactionResult.tokens` shape. */
export interface TokenUsageInfo {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cache: {
    readonly read: number;
    readonly write: number;
  };
}

export const EMPTY_TOKEN_USAGE: TokenUsageInfo = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
};

export interface SummarizerQueryConfig {
  /** Omit to inherit `process.env` before hygiene is applied. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /** Overrides the resolved hygiene set (tests, alternate profiles). */
  readonly childEnv?: ResolvedChildEnv;
  readonly cwd?: string;
  readonly model?: string;
  readonly systemPrompt?: string;
  /** Cancellation for the lane; propagated to the SDK child so it stops promptly. */
  readonly signal?: AbortSignal;
}

/**
 * Build the SDK query options for the isolated summarizer. Pure and synchronous
 * so the spawn config is assertable without launching a child process.
 */
export function buildSummarizerOptions(config: SummarizerQueryConfig = {}): Options {
  const abortController =
    config.signal === undefined ? undefined : abortControllerFor(config.signal);
  return {
    env: buildChildEnv(config.baseEnv ?? process.env, config.childEnv),
    tools: [],
    persistSession: false,
    maxTurns: 1,
    permissionMode: "bypassPermissions",
    // Required by the SDK whenever bypassPermissions is requested; the lane runs
    // `tools: []`, so there is nothing to approve.
    allowDangerouslySkipPermissions: true,
    strictMcpConfig: true,
    // Isolation mode: no user/project/local settings, no skills, no auto-memory.
    settingSources: [],
    skills: [],
    settings: { autoMemoryEnabled: false },
    ...(abortController !== undefined ? { abortController } : {}),
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    ...(config.model !== undefined ? { model: config.model } : {}),
    ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
  };
}

/** Bridge an external signal onto the SDK's `abortController` option. */
function abortControllerFor(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

/** Injectable spawner seam; lets tests drive the lane without a live CLI. */
export type SummarizerSpawner = (params: {
  readonly prompt: string;
  readonly options: Options;
}) => AsyncIterable<SDKMessage>;

function defaultSummarizerSpawner(params: {
  prompt: string;
  options: Options;
}): AsyncIterable<SDKMessage> {
  return query({ prompt: params.prompt, options: params.options });
}

export interface SummarizerLaneRequest extends SummarizerQueryConfig {
  readonly prompt: string;
}

export interface SummarizerOutcome {
  readonly summary: string;
  readonly tokens: TokenUsageInfo;
}

/**
 * Run the one-off summarizer to completion and return its text + tokens. Throws
 * a taxonomized error when the child cannot start, the turn fails, or no text
 * was produced; the caller classifies and reports.
 */
export async function runSummarizerLane(
  request: SummarizerLaneRequest,
  spawn: SummarizerSpawner = defaultSummarizerSpawner,
): Promise<SummarizerOutcome> {
  const options = buildSummarizerOptions(request);
  let streamedText = "";
  let resultText: string | undefined;
  let failureText: string | undefined;
  let tokens: TokenUsageInfo | undefined;

  for await (const message of spawn({ prompt: request.prompt, options })) {
    if (request.signal?.aborted) {
      throw bridgeError("stream", "CB_STREAM_ABORTED", "cli-providers: compaction summarizer aborted");
    }
    if (message.type === "assistant") {
      streamedText += assistantText(message);
    } else if (message.type === "result") {
      tokens = tokenUsageFrom(message.usage);
      if (message.subtype === "success") {
        if (message.is_error) {
          failureText = message.result.trim() || "summarizer reported an error";
        } else {
          resultText = message.result;
        }
      } else {
        failureText = message.errors.join("\n") || `summarizer failed: ${message.subtype}`;
      }
    }
  }

  if (request.signal?.aborted) {
    throw bridgeError("stream", "CB_STREAM_ABORTED", "cli-providers: compaction summarizer aborted");
  }
  if (failureText !== undefined) {
    throw bridgeError(
      "stream",
      "CB_STREAM_MAPPING_FAILED",
      `cli-providers: compaction summarizer failed: ${failureText}`,
    );
  }

  // A success result whose text is empty (e.g. the final message arrived as a
  // separate assistant frame) still has the streamed blocks to fall back on.
  const summary = (
    resultText !== undefined && resultText.trim().length > 0 ? resultText : streamedText
  ).trim();
  if (summary.length === 0) {
    throw bridgeError(
      "stream",
      "CB_STREAM_MAPPING_FAILED",
      "cli-providers: compaction summarizer returned empty text",
    );
  }
  return { summary, tokens: tokens ?? EMPTY_TOKEN_USAGE };
}

function assistantText(message: SDKAssistantMessage): string {
  const content = message.message?.content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") text += block.text;
  }
  return text;
}

function tokenUsageFrom(usage: NonNullableUsage): TokenUsageInfo {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    reasoning: usage.output_tokens_details?.thinking_tokens ?? 0,
    cache: {
      read: usage.cache_read_input_tokens,
      write: usage.cache_creation_input_tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Summarization prompt over host history.
// ---------------------------------------------------------------------------

export const SUMMARIZER_INSTRUCTION =
  "Summarize the conversation below into a dense, self-contained handoff so the assistant can " +
  "resume without the original messages. Preserve decisions, file paths, identifiers, unresolved " +
  "questions, and pending work. Return only the summary text.";

type SessionMessages = SessionCompaction["messages"];
type SystemParts = SessionCompaction["system"];
type HostContentPart = SessionMessages[number]["content"][number];

export function buildSummaryPrompt(
  input: Pick<SessionCompaction, "system" | "messages">,
): string {
  const lines: string[] = [SUMMARIZER_INSTRUCTION, ""];
  const systemText = projectSystemPrompt(input.system);
  if (systemText !== undefined) {
    lines.push("## System context", systemText, "");
  }
  lines.push("## Conversation");
  for (const message of input.messages) {
    lines.push(renderMessage(message));
  }
  return lines.join("\n");
}

/** Project the host system parts into the summarizer's `systemPrompt`. */
export function projectSystemPrompt(system: SystemParts): string | undefined {
  const text = system
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((entry) => entry.length > 0)
    .join("\n\n");
  return text.length > 0 ? text : undefined;
}

function renderMessage(message: SessionMessages[number]): string {
  const body = message.content
    .map(renderContentPart)
    .filter((entry) => entry.length > 0)
    .join(" ");
  return `${message.role}: ${body}`.trimEnd();
}

function renderContentPart(part: HostContentPart): string {
  const view = part as {
    readonly type: string;
    readonly text?: unknown;
    readonly name?: unknown;
    readonly input?: unknown;
    readonly result?: unknown;
  };
  switch (view.type) {
    case "text":
      return typeof view.text === "string" ? view.text : "";
    case "reasoning":
      return typeof view.text === "string" ? `[reasoning] ${view.text}` : "[reasoning]";
    case "tool-call":
      return `[tool-call ${String(view.name ?? "unknown")}] ${stringifyValue(view.input)}`;
    case "tool-result":
      return `[tool-result ${String(view.name ?? "unknown")}] ${renderToolResultValue(view.result)}`;
    case "compaction":
      return typeof view.text === "string" ? `[compaction] ${view.text}` : "[compaction]";
    case "media":
      return "[media]";
    default:
      return "";
  }
}

function renderToolResultValue(value: unknown): string {
  if (typeof value !== "object" || value === null) return stringifyValue(value);
  const result = value as { readonly type?: unknown; readonly value?: unknown };
  switch (result.type) {
    case "text":
      return String(result.value ?? "");
    case "error":
      return `error: ${String(result.value ?? "")}`;
    case "content":
      return renderContentBlocks(result.value);
    case "json":
      return stringifyValue(result.value);
    default:
      return stringifyValue(value);
  }
}

function renderContentBlocks(value: unknown): string {
  if (!Array.isArray(value)) return stringifyValue(value);
  return value
    .map((block) => {
      const entry = block as { readonly type?: unknown; readonly text?: unknown; readonly uri?: unknown };
      if (entry.type === "text") return String(entry.text ?? "");
      if (entry.type === "file") return `[file ${String(entry.uri ?? "")}]`;
      return "";
    })
    .filter((entry) => entry.length > 0)
    .join(" ");
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Failure classification and the hook handler.
// ---------------------------------------------------------------------------

const SPAWN_FAILURE_SIGNATURES: readonly RegExp[] = [
  /\bENOENT\b/,
  /\bENOTDIR\b/,
  /\bEACCES\b/,
  /\bspawn\b/i,
  /\bexecutable\b/i,
  /\bnot found\b/i,
];

/**
 * Map a lane failure onto a closed taxonomy code. A child that never started is
 * a spawn failure; a transient transport blip stays retryable; everything else
 * (empty summary, failed turn) is a stream defect.
 */
export function classifyCompactionLaneError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  if (isSpawnFailure(error)) {
    return bridgeError(
      "transport",
      "CB_TRANSPORT_SPAWN_FAILED",
      `cli-providers: compaction summarizer could not start: ${describeError(error)}`,
      { cause: error },
    );
  }
  if (isTransientTransportError(error)) return classifyTransportError(error);
  return bridgeError(
    "stream",
    "CB_STREAM_MAPPING_FAILED",
    `cli-providers: compaction summarizer failed: ${describeError(error)}`,
    { cause: error },
  );
}

function isSpawnFailure(error: unknown): boolean {
  const signature = `${describeError(error)} ${errorCode(error)}`;
  return SPAWN_FAILURE_SIGNATURES.some((pattern) => pattern.test(signature));
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" || typeof code === "number" ? String(code) : "";
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

export type CompactionFailureReporter = (error: BridgeError) => void;

export interface CompactionLaneDeps {
  readonly spawn?: SummarizerSpawner;
  readonly model?: string;
  readonly cwd?: string;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly childEnv?: ResolvedChildEnv;
  /** Receives the taxonomy-classified lane failure. Defaults to `console.warn`. */
  readonly reportFailure?: CompactionFailureReporter;
}

export type CompactionHandler = (input: SessionCompaction) => Promise<void>;

function defaultFailureReporter(error: BridgeError): void {
  console.warn(`cli-providers: compaction summarizer failed [${error.code}] ${error.message}`);
}

/**
 * Read the per-request cancellation the host may carry on `options`. The type is
 * an open record, so the signal is probed structurally rather than assumed.
 */
function abortSignalOf(options: SessionCompaction["options"]): AbortSignal | undefined {
  const candidate = (options as { readonly abortSignal?: unknown }).abortSignal;
  return isAbortSignal(candidate) ? candidate : undefined;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (typeof value !== "object" || value === null) return false;
  const view = value as { aborted?: unknown; addEventListener?: unknown };
  return typeof view.aborted === "boolean" && typeof view.addEventListener === "function";
}

/**
 * Build the `compaction` hook handler. On success it sets `input.result` (the
 * host then skips its model call); on any lane failure it leaves `result` unset
 * so the host's default compaction proceeds, and reports the classified error.
 */
export function createCompactionHandler(deps: CompactionLaneDeps = {}): CompactionHandler {
  const spawn = deps.spawn ?? defaultSummarizerSpawner;
  const reportFailure = deps.reportFailure ?? defaultFailureReporter;

  return async (input) => {
    try {
      const signal = abortSignalOf(input.options);
      const outcome = await runSummarizerLane(
        {
          prompt: buildSummaryPrompt(input),
          systemPrompt: projectSystemPrompt(input.system),
          model: deps.model,
          cwd: deps.cwd,
          baseEnv: deps.baseEnv,
          childEnv: deps.childEnv,
          ...(signal !== undefined ? { signal } : {}),
        },
        spawn,
      );
      input.result = {
        summary: outcome.summary,
        tokens: outcome.tokens,
        metadata: { "claude": { compaction: "isolated-summarizer" } },
      };
    } catch (error) {
      // Swallow by contract: an unset result lets the host run its default
      // compaction, which is strictly better than aborting the request.
      reportFailure(classifyCompactionLaneError(error));
    }
  };
}

/** The plugin context surface this module depends on. */
export type CompactionHookContext = Pick<Plugin.Context, "session">;

/** Register the handler on `ctx.session.hook("compaction")`. */
export function registerCompactionHook(
  ctx: CompactionHookContext,
  deps: CompactionLaneDeps = {},
): Promise<Registration> {
  return ctx.session.hook("compaction", createCompactionHandler(deps));
}

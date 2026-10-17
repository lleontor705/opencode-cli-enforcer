/**
 * Host tool-result delivery into the Claude Code rendezvous (REQ-CB-TOOL-005, D3).
 *
 * OpenCode owns tool execution: it runs a tool call natively and the result
 * reaches the bridge as a tool-result part on the *next* LanguageModelV3 prompt.
 * This module scrapes those parts back out, converts them to the MCP content
 * shape the parked tools/call handlers expect, and enqueues them into the
 * rendezvous.
 *
 * Two ordering/failure rules are load-bearing and each has a dedicated oracle:
 *
 * - A mid-turn steer and the tool-result delivery share Claude Code's stdin
 *   FIFO. The steer push MUST be acked (its stdin write completed) BEFORE any
 *   handler resolves, or CC's post-tool-call drain misses the steer and it
 *   silently degrades to follow-up semantics (REQ-CB-TOOL-004).
 * - A turn's tool call with no matching result part, or a result part whose
 *   content cannot be converted, MUST yield an explicit isError result for that
 *   id. Dropping either silently leaves Claude Code waiting on a tools/call that
 *   never completes.
 *
 * Reconciliation (cb-07 open question): `ToolRendezvous` (cb-06) remains the
 * single authoritative two-map store. `QueryContext.pendingToolCalls` /
 * `pendingResults` are intentionally NOT populated here — routing every result
 * through `ToolRendezvous.deliverToolResult` avoids duplicating the two-map
 * logic, and its private maps cannot be aliased from outside the class.
 * `QueryContext.turnToolCallIds` is still read: it names the turn's pending tool
 * calls. The rendezvous is created by the caller (the LanguageModelV3 adapter,
 * cb-12) and passed in, so the MCP handlers and this delivery pump agree on one
 * instance.
 */

import type {
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { bridgeError } from "../errors/taxonomy.js";
import type { ToolRendezvous, ToolResult, ToolTextContent } from "../mcp/rendezvous.js";
import { userMessage } from "./prompt-stream.js";
import type { QueryContext } from "./query-state.js";

export type NotifyFn = (message: string, level: "warning" | "info") => void;

export interface ConvertedToolResult {
  readonly result: ToolResult;
  readonly malformed: boolean;
}

export interface ExtractedToolResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result: ToolResult;
  readonly malformed: boolean;
}

/** What one delivery pass did, for hosts that want to react (counts, warnings). */
export interface ToolDeliveryReport {
  /** tool_use ids for which a result part was found and delivered. */
  readonly delivered: readonly string[];
  /** Pending ids with no result part — delivered an explicit error result. */
  readonly missing: readonly string[];
  /** Delivered ids whose content could not be converted (error result). */
  readonly malformed: readonly string[];
  /** Whether the steer (if any) was written to stdin before delivery. */
  readonly steerWritten: boolean;
}

export interface DeliverToolResultsOptions {
  readonly context: QueryContext;
  readonly rendezvous: ToolRendezvous;
  /** The next turn's LanguageModelV3 prompt, source of the tool-result parts. */
  readonly prompt: LanguageModelV3Prompt;
  /** Trailing user steer to write before results; null when the turn has none. */
  readonly steer?: SDKUserMessage["message"]["content"] | null;
  /** Overrides the pending-id set; defaults to `context.turnToolCallIds`. */
  readonly targetToolCallIds?: readonly string[];
  readonly notify?: NotifyFn;
}

function textBlock(text: string): ToolTextContent {
  return { type: "text", text };
}

function classifier(toolCallId: string, toolName: string, message: string): ToolResult {
  const label = toolName.length > 0 ? `${toolName} [${toolCallId}]` : toolCallId;
  const error = bridgeError("tool", "CB_TOOL_UNPAIRED_RESULT", `cli-providers: ${message} ${label}`);
  return { content: [textBlock(error.message)], isError: true };
}

function malformedResult(toolCallId: string, toolName: string, detail: string): ToolResult {
  return classifier(toolCallId, toolName, `malformed tool result could not be converted (${detail}) for`);
}

function missingResult(toolCallId: string): ToolResult {
  return classifier(toolCallId, "", "no tool result was provided for tool call");
}

/**
 * Convert one LanguageModelV3 tool-result output to MCP content. Returns null
 * when the output is not a shape this bridge can render — the caller turns that
 * into an explicit error result rather than an empty success.
 */
function convertOutput(output: unknown): ToolResult | null {
  if (typeof output !== "object" || output === null) return null;
  const record = output as Record<string, unknown>;
  switch (record.type) {
    case "text": {
      if (typeof record.value !== "string") return null;
      return { content: [textBlock(record.value)] };
    }
    case "error-text": {
      if (typeof record.value !== "string") return null;
      return { content: [textBlock(record.value)], isError: true };
    }
    case "json": {
      const text = serialiseJson(record.value);
      return text === undefined ? null : { content: [textBlock(text)] };
    }
    case "error-json": {
      const text = serialiseJson(record.value);
      return text === undefined ? null : { content: [textBlock(text)], isError: true };
    }
    case "execution-denied": {
      const reason = typeof record.reason === "string" ? record.reason : "tool execution was denied";
      return { content: [textBlock(reason)], isError: true };
    }
    case "content": {
      if (!Array.isArray(record.value)) return null;
      const content = record.value.map(renderContentItem);
      return { content: content.length > 0 ? content : [textBlock("")] };
    }
    default:
      return null;
  }
}

/** Render one `LanguageModelV3ToolResultOutput.content` item as text. Non-text
 *  media is flattened to a visible marker: cb-06's MCP result is text-only, so
 *  silently dropping it would lose the result. */
function renderContentItem(item: unknown): ToolTextContent {
  if (typeof item !== "object" || item === null) return textBlock("[unrenderable content]");
  const record = item as Record<string, unknown>;
  switch (record.type) {
    case "text":
      return textBlock(typeof record.text === "string" ? record.text : "");
    case "file-data":
      return textBlock(`[file ${stringOr(record.mediaType, "application/octet-stream")}]`);
    case "file-url":
      return textBlock(`[file-url ${stringOr(record.url, "")}]`);
    case "file-id":
      return textBlock(`[file-id ${typeof record.fileId === "string" ? record.fileId : "unknown"}]`);
    case "image":
      return textBlock(`[image ${stringOr(record.mediaType, "image/*")}]`);
    default:
      return textBlock(`[${stringOr(record.type, "unknown")} content]`);
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function serialiseJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function describeUnconvertible(output: unknown): string {
  if (typeof output !== "object" || output === null) return `output is ${output === null ? "null" : typeof output}`;
  const type = (output as { type?: unknown }).type;
  return typeof type === "string" ? `unsupported output type "${type}"` : "output has no type";
}

/** Convert a tool-result part to an MCP result, flagging malformed content. */
export function convertToolResultPart(part: LanguageModelV3ToolResultPart): ConvertedToolResult {
  const toolCallId = typeof part.toolCallId === "string" ? part.toolCallId : "";
  const toolName = typeof part.toolName === "string" ? part.toolName : "";
  const converted = convertOutput(part.output);
  if (converted === null) {
    return {
      result: malformedResult(toolCallId, toolName, describeUnconvertible(part.output)),
      malformed: true,
    };
  }
  return { result: converted, malformed: false };
}

/**
 * Scrape the tool-result parts a turn's pending ids are waiting on. Only parts
 * whose id is in `targetToolCallIds` are considered, so stale history results
 * cannot be delivered to a live call. First occurrence per id wins.
 */
export function extractToolResults(
  prompt: LanguageModelV3Prompt,
  targetToolCallIds: readonly string[],
): readonly ExtractedToolResult[] {
  const targets = new Set(targetToolCallIds);
  const byId = new Map<string, ExtractedToolResult>();
  for (const message of prompt) {
    const content: unknown = message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const candidate = part as { type?: unknown; toolCallId?: unknown; toolName?: unknown };
      if (candidate.type !== "tool-result") continue;
      const toolCallId = typeof candidate.toolCallId === "string" ? candidate.toolCallId : "";
      if (toolCallId.length === 0 || byId.has(toolCallId) || !targets.has(toolCallId)) continue;
      const converted = convertToolResultPart(part as LanguageModelV3ToolResultPart);
      byId.set(toolCallId, {
        toolCallId,
        toolName: typeof candidate.toolName === "string" ? candidate.toolName : "",
        result: converted.result,
        malformed: converted.malformed,
      });
    }
  }
  return [...byId.values()];
}

/** Plain-text view of a steer, so a warning can name what was lost. */
function steerText(content: SDKUserMessage["message"]["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
    .join("\n");
}

/**
 * Write a steer to Claude Code's stdin and await its ack. Returns whether the
 * write completed: only a resolved ack proves the steer is on the FIFO before
 * any tool result, which is what makes the ordering mandate real. A rejected or
 * absent write marks the query's `missedSteer` so the completion path can carry
 * it forward, and delivery still proceeds.
 */
export async function pushSteerAck(
  context: QueryContext,
  steer: SDKUserMessage["message"]["content"] | null | undefined,
  notify?: NotifyFn,
): Promise<boolean> {
  if (steer === null || steer === undefined) return false;
  const text = steerText(steer);
  const stream = context.promptStream;
  if (!stream) {
    context.missedSteer = true;
    notify?.(
      `Claude bridge: steer could not be written (no active prompt stream), carrying it to the next turn: ${text.slice(0, 60)}`,
      "warning",
    );
    return false;
  }
  try {
    await stream.push(userMessage(steer, "next"));
    return true;
  } catch {
    context.missedSteer = true;
    notify?.(
      `Claude bridge: steer did not reach Claude Code, carrying it to the next turn: ${text.slice(0, 60)}`,
      "warning",
    );
    return false;
  }
}

/**
 * Deliver the next prompt's tool results to the parked handlers.
 *
 * Ordering: the steer (if any) is acked first, then every result is enqueued
 * into the rendezvous. Ids with no result part get an explicit error result, so
 * a parked tools/call always resolves and the turn cannot wedge.
 */
export async function deliverToolResults(
  options: DeliverToolResultsOptions,
): Promise<ToolDeliveryReport> {
  const { context, rendezvous, prompt } = options;
  const steerWritten = await pushSteerAck(context, options.steer ?? null, options.notify);

  const targetIds = options.targetToolCallIds
    ? [...options.targetToolCallIds]
    : [...context.turnToolCallIds];

  const extracted = extractToolResults(prompt, targetIds);
  const delivered: string[] = [];
  const malformed: string[] = [];
  for (const item of extracted) {
    if (item.malformed) malformed.push(item.toolCallId);
    rendezvous.deliverToolResult(item.toolCallId, item.result);
    delivered.push(item.toolCallId);
  }

  const answered = new Set(delivered);
  const missing: string[] = [];
  for (const id of targetIds) {
    if (answered.has(id)) continue;
    missing.push(id);
    rendezvous.deliverToolResult(id, missingResult(id));
  }

  if (rendezvous.pendingToolCallCount > 0) {
    options.notify?.(
      `Claude bridge: ${rendezvous.pendingToolCallCount} tool handler(s) still waiting after delivering ${delivered.length} result(s)`,
      "warning",
    );
  }

  return { delivered, missing, malformed, steerWritten };
}

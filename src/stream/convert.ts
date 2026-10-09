/**
 * Message conversion and prompt projection (REQ-CB-STRM-001, design D5).
 *
 * Ported from pi-claude-bridge `src/convert.ts`, with the pi runtime replaced by
 * the bridge's own host-message shape. The output is `cc-session-io`'s
 * `Message`, the shape both the Agent SDK prompt and the Claude Code JSONL
 * mirror accept, so a rebuilt transcript can actually be replayed.
 *
 * The conversion is deliberately lossy in exactly two places, and it reports
 * both: thinking blocks it is not allowed to replay, and unrecognized block
 * types. Silence there would make a dropped instruction invisible.
 */

import type { ContentBlock, Message, ToolResultBlock } from "cc-session-io";

import { projectSendablePrompt } from "../errors/assert-sendable-prompt.js";
import type { PromptProjectionContext, SendablePromptPart } from "../errors/assert-sendable-prompt.js";

/** Provider id whose thinking signatures Claude Code will accept back. A
 *  signature minted by any other provider is not ours to replay. */
export const PROVIDER_ID = "claude-bridge";

export interface BridgeTextBlock {
  readonly type: "text";
  readonly text: string;
}

export interface BridgeImageBlock {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface BridgeThinkingBlock {
  readonly type: "thinking";
  readonly thinking?: string;
  readonly thinkingSignature?: string;
}

export interface BridgeToolCallBlock {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments?: Record<string, unknown>;
}

export type BridgeContentBlock =
  | BridgeTextBlock
  | BridgeImageBlock
  | BridgeThinkingBlock
  | BridgeToolCallBlock;

export interface BridgeMessage {
  readonly role: "user" | "assistant" | "toolResult";
  readonly content: string | readonly BridgeContentBlock[];
  /** Set on assistant messages: the provider whose thinking signatures they carry. */
  readonly provider?: string;
  /** Set on toolResult messages: the tool_use id this result answers. */
  readonly toolCallId?: string;
  readonly isError?: boolean;
}

/** What conversion discarded. A stripped thinking block and a message that never
 *  carried one convert identically, so without this the loss is invisible. */
export interface DroppedContent {
  thinking: number;
  abortedTurns: number;
  providers: Set<string>;
  other: Map<string, number>;
}

export interface ConvertedMessages {
  anthropicMessages: Message[];
  sanitizedIds: Map<string, string>;
  dropped: DroppedContent;
}

export interface ConvertMessagesOptions {
  readonly providerId?: string;
  /** Host tool name -> the name the rebuilt transcript must call it by. */
  readonly customToolNameToSdk?: ReadonlyMap<string, string>;
}

/**
 * Deterministic, per-turn-stable sanitization of a Claude tool id.
 *
 * Claude Code mints ids that are already `[A-Za-z0-9_-]`, but a transcript that
 * has round-tripped through another provider may not be, and Anthropic rejects
 * a `tool_use` id outside that alphabet. The cache makes the mapping a pure
 * function of the turn's inputs, so the same raw id sanitizes identically
 * everywhere it appears (block, result, replay).
 */
export function sanitizeToolId(id: string, cache: Map<string, string>): string {
  const existing = cache.get(id);
  if (existing) return existing;
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  cache.set(id, clean);
  return clean;
}

/**
 * The name a rebuilt transcript has to call a host tool by.
 *
 * Without a map the name passes through unchanged; with one, an exact match (or
 * a case-insensitive one) is preferred, and anything unknown keeps its own name
 * rather than being renamed to a builtin the model was never served.
 */
export function resolveToolName(
  name: string,
  customToolNameToSdk?: ReadonlyMap<string, string>,
): string {
  if (!name) return "";
  if (!customToolNameToSdk) return name;
  return customToolNameToSdk.get(name) ?? customToolNameToSdk.get(name.toLowerCase()) ?? name;
}

export function messageContentToText(
  content: string | readonly BridgeContentBlock[],
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  let hasText = false;
  for (const block of content) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
      hasText = true;
    } else if (block.type !== "text" && block.type !== "image") {
      parts.push(`[${block.type}]`);
    }
  }
  return hasText ? parts.join("\n") : "";
}

/**
 * Tool results are flattened to text, which is how Claude Code stores most of
 * them. Images are the exception: they have no text form, so a result carrying
 * one keeps the block-array shape (also what CC writes for screenshots).
 */
function toolResultContent(
  content: string | readonly BridgeContentBlock[],
): string | ContentBlock[] {
  if (typeof content === "string" || !Array.isArray(content)) return messageContentToText(content) || "";
  const images = content.filter(
    (block): block is BridgeImageBlock => block.type === "image" && Boolean(block.data) && Boolean(block.mimeType),
  );
  if (!images.length) return messageContentToText(content) || "";
  const blocks: ContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text) {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "image" && block.data && block.mimeType) {
      blocks.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
    } else if (block.type !== "text" && block.type !== "image") {
      // Same marker messageContentToText leaves, so the text and image paths
      // describe an unrecognized block the same way.
      blocks.push({ type: "text", text: `[${block.type}]` });
    }
  }
  return blocks;
}

function userContentBlocks(content: readonly BridgeContentBlock[]): ContentBlock[] {
  const parts: ContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text) {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image" && block.data && block.mimeType) {
      parts.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
    }
  }
  return parts;
}

/**
 * Convert the bridge's host messages to Anthropic/Claude-Code messages.
 *
 * The load-bearing detail is tool-result pairing: every framework records one
 * message per tool result, but `repairToolPairing` only pairs results that
 * share the user message directly after their assistant message. Split across
 * messages, the second and later results of a parallel tool call match no
 * pending id and are replaced with a synthetic "[no tool result recorded]",
 * silently destroying their output on every rebuild. So this merges a turn's
 * results into one user message.
 */
export function convertMessages(
  messages: readonly BridgeMessage[],
  options: ConvertMessagesOptions = {},
): ConvertedMessages {
  const providerId = options.providerId ?? PROVIDER_ID;
  const customToolNameToSdk = options.customToolNameToSdk;
  const anthropicMessages: Message[] = [];
  const sanitizedIds = new Map<string, string>();
  const dropped: DroppedContent = { thinking: 0, abortedTurns: 0, providers: new Set(), other: new Map() };

  // The user message collecting this assistant turn's tool results, and the
  // index of the assistant message it belongs to. Both are cleared at every
  // assistant message that actually emits content.
  let turnResults: { role: "user"; content: ContentBlock[] } | null = null;
  let turnAssistantIdx: number | null = null;

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        anthropicMessages.push({ role: "user", content: msg.content || "[empty]" });
      } else if (Array.isArray(msg.content)) {
        const parts = userContentBlocks(msg.content);
        anthropicMessages.push({ role: "user", content: parts.length ? parts : "[empty]" });
      } else {
        anthropicMessages.push({ role: "user", content: "[empty]" });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const blocks: ContentBlock[] = [];
      for (const block of content) {
        if (block.type === "text" && block.text) {
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "thinking") {
          // Only replay thinking Claude Code itself produced. A signature minted
          // by another provider is not ours to hand back, and Anthropic rejects
          // ones it cannot verify.
          const signature = block.thinkingSignature;
          if (msg.provider === providerId && signature) {
            blocks.push({ type: "thinking", thinking: block.thinking ?? "", signature });
          } else {
            dropped.thinking++;
            dropped.providers.add(msg.provider ?? "unknown");
          }
        } else if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: sanitizeToolId(block.id, sanitizedIds),
            name: resolveToolName(block.name, customToolNameToSdk),
            input: block.arguments ?? {},
          });
        } else {
          dropped.other.set(block.type, (dropped.other.get(block.type) ?? 0) + 1);
        }
      }
      // A turn the user aborted before anything streamed carries no content at
      // all. A placeholder would invent a reply the assistant never made and
      // cost the whole prompt cache on every rebuild, so drop it. turnResults is
      // deliberately NOT cleared here: an abort between two parallel results
      // would otherwise start a second results message and destroy the merge
      // this function exists to preserve.
      if (!content.length) {
        dropped.abortedTurns++;
        continue;
      }
      if (!blocks.length) blocks.push({ type: "text", text: "[incompatible content omitted]" });
      turnResults = null;
      turnAssistantIdx = anthropicMessages.length;
      anthropicMessages.push({ role: "assistant", content: blocks });
      continue;
    }

    // msg.role === "toolResult"
    const resultBlock: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: sanitizeToolId(msg.toolCallId ?? "", sanitizedIds),
      content: toolResultContent(msg.content),
    };
    if (msg.isError !== undefined) resultBlock.is_error = msg.isError;
    if (turnResults) {
      turnResults.content.push(resultBlock);
    } else {
      turnResults = { role: "user", content: [resultBlock] };
      // A result with no assistant message before it is malformed history;
      // appending keeps it in order for repairToolPairing to discard.
      anthropicMessages.splice(
        turnAssistantIdx === null ? anthropicMessages.length : turnAssistantIdx + 1,
        0,
        turnResults,
      );
    }
  }

  return { anthropicMessages, sanitizedIds, dropped };
}

/**
 * Project a prompt for the Anthropic path, reusing the fail-loud projection
 * from the error taxonomy (REQ-CB-ERR-002). A part that cannot be sent throws,
 * naming itself; the join is built from the parts, so no instruction can be
 * dropped in transit.
 */
export function projectPrompt(
  parts: readonly SendablePromptPart[],
  context?: PromptProjectionContext,
): string | undefined {
  return projectSendablePrompt(parts, context);
}

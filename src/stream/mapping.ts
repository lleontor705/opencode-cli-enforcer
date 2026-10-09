/**
 * Claude EventMapper: Agent SDK stream events -> normalized events -> LanguageModelV3
 * stream parts (REQ-CB-STRM-001..003, design D6).
 *
 * The mapper is deliberately two-layered. `map()` normalizes one raw SDK event
 * into zero or more provider-neutral events while keeping the accumulated turn
 * output on the shared {@link QueryContext}; `renderNormalizedEvents()` turns
 * those events into `LanguageModelV3StreamPart`s. The LanguageModelV3 adapter
 * (`src/provider/language-model.ts`) drives `doStream` and owns none of this
 * logic.
 *
 * Ported from pi-claude-bridge `src/index.ts` (`processStreamEvent`,
 * `processAssistantMessage`, `dropAbandonedStreamBlocks`) and `src/usage.ts`.
 * Four behaviours are not obvious and each has a dedicated oracle below:
 *
 * - `<synthetic>` assistant messages are Claude Code reporting a failure, not
 *   model output. They must never reach the stream, or a consumer that only
 *   fails over before output commits can no longer reach the next provider.
 * - A non-streaming fallback under a different message id while the stream is
 *   still open means CC gave up on the stalled stream; its half-written blocks
 *   (unsigned thinking, a tool call CC will never dispatch) must be dropped
 *   exactly once so the fallback content is not duplicated.
 * - `rate_limit_event` is a notification, and the SDK emits one per request, so
 *   only a new 5% bucket (or a changed threshold) may notify the host.
 * - A `result` carrying `is_error` on an otherwise success-shaped event is the
 *   only record that the turn failed; it must surface, correlated with a
 *   preceding rate-limit rejection when there was one.
 */

import type {
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";

import type { EventMapper, TurnResult, TurnUsage } from "../provider/seams.js";
import { EMPTY_USAGE } from "../provider/seams.js";
import { QueryContext } from "../provider/query-state.js";
import { bridgeError } from "../errors/taxonomy.js";
import { sanitizeToolId } from "./convert.js";

// ---------------------------------------------------------------------------
// Raw Agent SDK event shapes this mapper understands.
// ---------------------------------------------------------------------------

export interface ClaudeUsage {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
  readonly output_tokens_details?: { readonly thinking_tokens?: number | null } | null;
}

export interface ClaudeContentBlockStart {
  readonly type?: string;
  readonly name?: string;
  readonly id?: string;
  readonly input?: Record<string, unknown>;
}

export interface ClaudeContentBlockDelta {
  readonly type?: string;
  readonly text?: string;
  readonly thinking?: string;
  readonly partial_json?: string;
  readonly signature?: string;
}

export interface ClaudeStreamEventPayload {
  readonly type: string;
  readonly index?: number;
  readonly message?: { readonly id?: string; readonly usage?: ClaudeUsage };
  readonly content_block?: ClaudeContentBlockStart;
  readonly delta?: ClaudeContentBlockDelta & { readonly stop_reason?: string | null };
  readonly usage?: ClaudeUsage;
}

export type ClaudeAssistantContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking?: string; readonly signature?: string }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input?: Record<string, unknown> };

export interface ClaudeAssistantMessage {
  readonly id?: string;
  readonly model?: string;
  readonly content?: readonly ClaudeAssistantContentBlock[];
  readonly usage?: ClaudeUsage;
}

export interface ClaudeRateLimitInfo {
  readonly status?: string;
  readonly rateLimitType?: string;
  readonly utilization?: number;
  readonly surpassedThreshold?: number;
  readonly resetsAt?: number;
}

/** A permissive view of the SDK messages the mapper consumes. */
export interface ClaudeRawEvent {
  readonly type: string;
  readonly subtype?: string;
  readonly session_id?: string;
  readonly is_error?: boolean;
  readonly result?: string;
  readonly errors?: readonly unknown[];
  readonly error?: unknown;
  readonly usage?: ClaudeUsage;
  readonly rate_limit_info?: ClaudeRateLimitInfo;
  readonly event?: ClaudeStreamEventPayload;
  readonly message?: ClaudeAssistantMessage;
}

// ---------------------------------------------------------------------------
// Normalized event vocabulary.
// ---------------------------------------------------------------------------

export interface NormalizedFinishEvent {
  readonly kind: "finish";
  readonly usage: TurnUsage;
  readonly unified: LanguageModelV3FinishReason["unified"];
  readonly raw: string | undefined;
}

export type NormalizedClaudeEvent =
  | { readonly kind: "stream-reset"; readonly dropped: number; readonly reason: string; readonly messageId?: string }
  | { readonly kind: "text-start"; readonly id: string }
  | { readonly kind: "text-delta"; readonly id: string; readonly delta: string }
  | { readonly kind: "text-end"; readonly id: string }
  | { readonly kind: "reasoning-start"; readonly id: string }
  | { readonly kind: "reasoning-delta"; readonly id: string; readonly delta: string }
  | { readonly kind: "reasoning-end"; readonly id: string; readonly signature?: string }
  | { readonly kind: "tool-input-start"; readonly id: string; readonly toolName: string }
  | { readonly kind: "tool-input-delta"; readonly id: string; readonly delta: string }
  | { readonly kind: "tool-input-end"; readonly id: string; readonly input: Record<string, unknown> }
  | { readonly kind: "tool-call"; readonly id: string; readonly toolName: string; readonly input: string }
  | NormalizedFinishEvent
  | { readonly kind: "rate-limit"; readonly status: string; readonly percent?: number; readonly message: string }
  | { readonly kind: "error"; readonly message: string; readonly error: unknown };

export type NotifyFn = (message: string, level: "warning" | "info") => void;

export interface ClaudeMapperOptions {
  /** Query-scoped state the mapper mutates (turn blocks, stream-open flags,
   *  rate-limit dedupe). Omit for a self-contained mapper (tests, folds). */
  readonly query?: QueryContext;
  readonly notify?: NotifyFn;
  /** Host tool name -> served name. Returning `undefined` skips the tool, the
   *  way an unserved `tool_use` is skipped rather than replayed as a builtin. */
  readonly resolveToolName?: (name: string) => string | undefined;
}

/** The block shape this mapper stores on {@link QueryContext.turnBlocks}. */
interface MappedBlock {
  type: string;
  lid?: string;
  index?: number;
  text?: string;
  thinking?: string;
  thinkingSignature?: string;
  id?: string;
  rawId?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  partialJson?: string;
  [key: string]: unknown;
}

const PROVIDER_METADATA_KEY = "claude-bridge";

// ---------------------------------------------------------------------------
// Renderer: normalized events -> LanguageModelV3 stream parts.
// ---------------------------------------------------------------------------

/**
 * Render normalized events as `LanguageModelV3StreamPart`s.
 *
 * `stream-reset` and `rate-limit` have no LMV3 part: they are bookkeeping and
 * host notifications, not model output, so they render to nothing.
 */
export function renderNormalizedEvents(
  events: readonly NormalizedClaudeEvent[],
): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = [];
  for (const event of events) {
    switch (event.kind) {
      case "text-start":
        parts.push({ type: "text-start", id: event.id });
        break;
      case "text-delta":
        parts.push({ type: "text-delta", id: event.id, delta: event.delta });
        break;
      case "text-end":
        parts.push({ type: "text-end", id: event.id });
        break;
      case "reasoning-start":
        parts.push({ type: "reasoning-start", id: event.id });
        break;
      case "reasoning-delta":
        parts.push({ type: "reasoning-delta", id: event.id, delta: event.delta });
        break;
      case "reasoning-end": {
        parts.push(
          event.signature
            ? {
                type: "reasoning-end",
                id: event.id,
                providerMetadata: { [PROVIDER_METADATA_KEY]: { signature: event.signature } },
              }
            : { type: "reasoning-end", id: event.id },
        );
        break;
      }
      case "tool-input-start":
        parts.push({ type: "tool-input-start", id: event.id, toolName: event.toolName });
        break;
      case "tool-input-delta":
        parts.push({ type: "tool-input-delta", id: event.id, delta: event.delta });
        break;
      case "tool-input-end":
        parts.push({ type: "tool-input-end", id: event.id });
        break;
      case "tool-call":
        parts.push({ type: "tool-call", toolCallId: event.id, toolName: event.toolName, input: event.input });
        break;
      case "finish":
        parts.push({
          type: "finish",
          usage: toLanguageModelV3Usage(event.usage),
          finishReason: { unified: event.unified, raw: event.raw },
        });
        break;
      case "error":
        parts.push({ type: "error", error: event.error });
        break;
      case "stream-reset":
      case "rate-limit":
        break;
    }
  }
  return parts;
}

/** Map the seam's turn-scoped counters onto the LMV3 usage fields. */
export function toLanguageModelV3Usage(usage: TurnUsage): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      noCache: usage.inputTokens,
      cacheRead: usage.cacheReadTokens,
      cacheWrite: usage.cacheWriteTokens,
    },
    outputTokens: {
      total: usage.outputTokens,
      text: usage.outputTokens,
      reasoning: undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// The mapper.
// ---------------------------------------------------------------------------

export class ClaudeEventMapper implements EventMapper<ClaudeRawEvent, NormalizedClaudeEvent> {
  readonly query: QueryContext;
  private readonly notify: NotifyFn | undefined;
  private readonly resolveToolName: (name: string) => string | undefined;
  private readonly sanitizedIds = new Map<string, string>();
  private usage: TurnUsage = EMPTY_USAGE;
  private blockSeq = 0;
  private finishEmitted = false;
  private turnFailed = false;
  private turnRateLimited = false;
  private sessionId: string | undefined;

  constructor(options: ClaudeMapperOptions = {}) {
    this.query = options.query ?? new QueryContext();
    this.notify = options.notify;
    this.resolveToolName = options.resolveToolName ?? ((name) => name);
    if (!this.query.turnOutput) this.resetTurn();
  }

  /** Reset per-turn state. The rate-limit dedupe is query-scoped and survives. */
  resetTurn(): void {
    this.query.resetTurnState();
    this.usage = EMPTY_USAGE;
    this.blockSeq = 0;
    this.finishEmitted = false;
    this.turnFailed = false;
    this.turnRateLimited = false;
    this.sessionId = undefined;
    this.sanitizedIds.clear();
  }

  /** Session id captured from a `system`/`result` frame, if one was seen. */
  get capturedSessionId(): string | undefined {
    return this.sessionId;
  }

  map(raw: ClaudeRawEvent): readonly NormalizedClaudeEvent[] {
    if (raw.session_id) this.sessionId = raw.session_id;
    switch (raw.type) {
      case "stream_event":
        return this.mapStreamEvent(raw);
      case "assistant":
        return this.mapAssistantMessage(raw);
      case "result":
        return this.mapResult(raw);
      case "rate_limit_event":
        return this.mapRateLimit(raw);
      case "system":
        if (raw.subtype === "init" && raw.session_id) this.sessionId = raw.session_id;
        return [];
      default:
        return [];
    }
  }

  /** Map one raw event and render it (convenience for the LMV3 adapter). */
  render(raw: ClaudeRawEvent): LanguageModelV3StreamPart[] {
    return renderNormalizedEvents(this.map(raw));
  }

  /**
   * Fold a turn's raw events into the seam's {@link TurnResult}. Implemented by
   * replaying `map()` on a fresh mapper so the fold can never drift from the
   * streaming path; usage normalization at the seam is therefore exact.
   */
  toTurnResult(rawEvents: readonly ClaudeRawEvent[]): TurnResult {
    const replay = new ClaudeEventMapper({ resolveToolName: this.resolveToolName });
    for (const raw of rawEvents) replay.map(raw);
    const text = replay.query.turnBlocks
      .filter((block) => block.type === "text")
      .map((block) => String(block.text ?? ""))
      .join("");
    return {
      status: replay.turnFailed ? (replay.turnRateLimited ? "rate-limited" : "failed") : "completed",
      text,
      usage: replay.usage,
      sessionId: replay.sessionId ?? "unknown",
    };
  }

  // -- Raw event handlers ---------------------------------------------------

  private mapStreamEvent(raw: ClaudeRawEvent): NormalizedClaudeEvent[] {
    const event = raw.event;
    if (!event) return [];
    this.query.turnSawStreamEvent = true;
    switch (event.type) {
      case "message_start":
        return this.onMessageStart(event);
      case "content_block_start":
        return this.onContentBlockStart(event);
      case "content_block_delta":
        return this.onContentBlockDelta(event);
      case "content_block_stop":
        return this.onContentBlockStop(event);
      case "message_delta":
        this.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
        this.absorbUsage(event.usage);
        return [];
      case "message_stop":
        this.query.turnStreamOpen = false;
        return [];
      default:
        return [];
    }
  }

  private onMessageStart(event: ClaudeStreamEventPayload): NormalizedClaudeEvent[] {
    const out: NormalizedClaudeEvent[] = [];
    // Still open from an earlier message_start: CC gave up on that stream and
    // is retrying it. Its blocks were never completed.
    if (this.query.turnStreamOpen) {
      out.push(...this.dropAbandonedStreamBlocks(`restreamed as ${event.message?.id ?? "unknown"}`));
    }
    this.query.turnToolCallIds = [];
    this.query.turnStreamMessageId = event.message?.id;
    this.query.turnStreamOpen = true;
    this.query.turnStreamBlockStart = this.query.turnBlocks.length;
    this.absorbUsage(event.message?.usage);
    return out;
  }

  private onContentBlockStart(event: ClaudeStreamEventPayload): NormalizedClaudeEvent[] {
    const block = event.content_block;
    const index = event.index;
    if (block?.type === "text") {
      const lid = this.nextId("text");
      this.query.turnBlocks.push({ type: "text", text: "", index, lid });
      return [{ kind: "text-start", id: lid }];
    }
    if (block?.type === "thinking") {
      const lid = this.nextId("reasoning");
      this.query.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index, lid });
      return [{ kind: "reasoning-start", id: lid }];
    }
    if (block?.type === "tool_use") {
      const toolName = this.resolveToolName(block.name ?? "");
      if (!toolName) return [];
      const rawId = block.id ?? "";
      const id = sanitizeToolId(rawId, this.sanitizedIds);
      this.query.turnSawToolCall = true;
      this.query.turnToolCallIds.push(rawId);
      this.query.turnBlocks.push({
        type: "toolCall",
        id,
        rawId,
        name: toolName,
        arguments: block.input ?? {},
        partialJson: "",
        index,
        lid: id,
      });
      return [{ kind: "tool-input-start", id, toolName }];
    }
    return [];
  }

  private onContentBlockDelta(event: ClaudeStreamEventPayload): NormalizedClaudeEvent[] {
    const block = this.blockAt(event.index);
    if (!block) return [];
    const delta = event.delta;
    if (delta?.type === "text_delta" && block.type === "text") {
      block.text = `${block.text ?? ""}${delta.text ?? ""}`;
      return [{ kind: "text-delta", id: String(block.lid), delta: delta.text ?? "" }];
    }
    if (delta?.type === "thinking_delta" && block.type === "thinking") {
      block.thinking = `${block.thinking ?? ""}${delta.thinking ?? ""}`;
      return [{ kind: "reasoning-delta", id: String(block.lid), delta: delta.thinking ?? "" }];
    }
    if (delta?.type === "input_json_delta" && block.type === "toolCall") {
      block.partialJson = `${block.partialJson ?? ""}${delta.partial_json ?? ""}`;
      block.arguments = parsePartialJson(
        String(block.partialJson),
        (block.arguments ?? {}) as Record<string, unknown>,
      );
      return [{ kind: "tool-input-delta", id: String(block.id), delta: delta.partial_json ?? "" }];
    }
    if (delta?.type === "signature_delta" && block.type === "thinking") {
      block.thinkingSignature = `${block.thinkingSignature ?? ""}${delta.signature ?? ""}`;
      return [];
    }
    return [];
  }

  private onContentBlockStop(event: ClaudeStreamEventPayload): NormalizedClaudeEvent[] {
    const block = this.blockAt(event.index);
    if (!block) return [];
    delete block.index;
    if (block.type === "text") {
      return [{ kind: "text-end", id: String(block.lid) }];
    }
    if (block.type === "thinking") {
      const signature = typeof block.thinkingSignature === "string" && block.thinkingSignature.length > 0
        ? block.thinkingSignature
        : undefined;
      return [signature ? { kind: "reasoning-end", id: String(block.lid), signature } : { kind: "reasoning-end", id: String(block.lid) }];
    }
    if (block.type === "toolCall") {
      this.query.turnSawToolCall = true;
      const input = (block.arguments ?? {}) as Record<string, unknown>;
      delete block.partialJson;
      return [
        { kind: "tool-input-end", id: String(block.id), input },
        { kind: "tool-call", id: String(block.id), toolName: String(block.name ?? ""), input: JSON.stringify(input) },
      ];
    }
    return [];
  }

  private mapAssistantMessage(raw: ClaudeRawEvent): NormalizedClaudeEvent[] {
    const out: NormalizedClaudeEvent[] = [];
    const message = raw.message;
    if (!message?.content) return out;

    if (message.model === "<synthetic>") {
      // The report can follow a stalled stream whose non-streaming retry also
      // failed; drop the abandoned partial blocks the way the fallback below
      // would. Its text is recorded on the turn (the error event carries it)
      // but never emitted, so the turn reads as producing no output.
      if (this.query.turnSawStreamEvent && this.query.turnStreamOpen) {
        out.push(...this.dropAbandonedStreamBlocks("synthetic failure report"));
      }
      for (const block of message.content) {
        if (block.type === "text" && block.text) this.query.turnBlocks.push({ type: "text", text: block.text });
      }
      this.absorbUsage(message.usage);
      return out;
    }

    if (this.query.turnSawStreamEvent) {
      // Same id was already delivered; a new id is CC's non-streaming fallback.
      const id = message.id;
      if (!id || !this.query.turnStreamMessageId || id === this.query.turnStreamMessageId) return out;
      if (this.query.turnStreamOpen) out.push(...this.dropAbandonedStreamBlocks(`non-streaming fallback ${id}`));
    }
    this.query.turnToolCallIds = [];

    for (const block of message.content) {
      if (block.type === "text" && block.text) {
        const lid = this.nextId("text");
        this.query.turnBlocks.push({ type: "text", text: block.text, lid });
        out.push(
          { kind: "text-start", id: lid },
          { kind: "text-delta", id: lid, delta: block.text },
          { kind: "text-end", id: lid },
        );
      } else if (block.type === "thinking") {
        const lid = this.nextId("reasoning");
        this.query.turnBlocks.push({
          type: "thinking",
          thinking: block.thinking ?? "",
          thinkingSignature: block.signature ?? "",
          lid,
        });
        out.push({ kind: "reasoning-start", id: lid });
        if (block.thinking) out.push({ kind: "reasoning-delta", id: lid, delta: block.thinking });
        out.push(
          block.signature
            ? { kind: "reasoning-end", id: lid, signature: block.signature }
            : { kind: "reasoning-end", id: lid },
        );
      } else if (block.type === "tool_use") {
        const toolName = this.resolveToolName(block.name);
        if (!toolName) continue;
        const id = sanitizeToolId(block.id, this.sanitizedIds);
        const input = (block.input ?? {}) as Record<string, unknown>;
        this.query.turnSawToolCall = true;
        this.query.turnToolCallIds.push(block.id);
        this.query.turnBlocks.push({ type: "toolCall", id, rawId: block.id, name: toolName, arguments: input, lid: id });
        out.push(
          { kind: "tool-input-start", id, toolName },
          { kind: "tool-input-end", id, input },
          { kind: "tool-call", id, toolName, input: JSON.stringify(input) },
        );
      }
    }
    this.absorbUsage(message.usage);
    return out;
  }

  private mapResult(raw: ClaudeRawEvent): NormalizedClaudeEvent[] {
    const out: NormalizedClaudeEvent[] = [];
    const errorText = resultErrorText(raw);
    if (errorText !== undefined) {
      if (this.finishEmitted) return out;
      let text = errorText;
      // Consume the rejection alongside the failure it caused, so a later
      // unrelated failure on this query does not inherit the label.
      if (this.query.rateLimitRejection) {
        text = describeRateLimitFailure(this.query.rateLimitRejection, text);
        this.turnRateLimited = true;
        this.query.rateLimitRejection = null;
      }
      this.turnFailed = true;
      this.finishEmitted = true;
      this.turnOutput.stopReason = "error";
      this.absorbUsage(raw.usage);
      out.push({ kind: "error", message: text, error: classifyResultError(text, this.turnRateLimited) });
      return out;
    }

    if (this.finishEmitted) return out;
    if (!this.query.turnSawStreamEvent && raw.subtype === "success") {
      const text = raw.result ?? "";
      const lid = this.nextId("text");
      this.query.turnBlocks.push({ type: "text", text, lid });
      out.push(
        { kind: "text-start", id: lid },
        { kind: "text-delta", id: lid, delta: text },
        { kind: "text-end", id: lid },
      );
    }
    this.absorbUsage(raw.usage);
    this.finishEmitted = true;
    out.push(this.finishEvent());
    return out;
  }

  private mapRateLimit(raw: ClaudeRawEvent): NormalizedClaudeEvent[] {
    const info = raw.rate_limit_info;
    if (!info) return [];
    if (info.status === "rejected") {
      // Held so the failure CC sends next can be named as a rate limit. Re-arm
      // the warning dedupe so the next window notifies even if it opens
      // straight into allowed_warning.
      this.query.rateLimitRejection = { rateLimitType: info.rateLimitType, resetsAt: info.resetsAt };
      this.query.lastRateLimitWarnStep = null;
      this.query.lastRateLimitWarnThreshold = undefined;
      const resetsAt = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : "unknown";
      const message = `Claude rate limited (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt}`;
      this.notify?.(message, "warning");
      return [{ kind: "rate-limit", status: "rejected", message }];
    }
    if (info.status === "allowed") {
      // Back under the threshold (window reset) — re-arm the dedupe.
      this.query.lastRateLimitWarnStep = null;
      this.query.lastRateLimitWarnThreshold = undefined;
      return [];
    }
    if (info.status === "allowed_warning") {
      const percent = Math.round((info.utilization ?? 0) * 100);
      // The SDK emits one event per request, so only re-notify when the level
      // rises past a new 5% step or the threshold changes.
      const step = Math.floor(percent / 5);
      const rose = this.query.lastRateLimitWarnStep === null || step > this.query.lastRateLimitWarnStep;
      if (rose || info.surpassedThreshold !== this.query.lastRateLimitWarnThreshold) {
        this.query.lastRateLimitWarnStep = step;
        this.query.lastRateLimitWarnThreshold = info.surpassedThreshold;
        const message = `Claude rate limit warning: ${percent}% used (${info.rateLimitType ?? ""})`;
        this.notify?.(message, "warning");
        return [{ kind: "rate-limit", status: "allowed_warning", percent, message }];
      }
      return [];
    }
    return [];
  }

  // -- Helpers --------------------------------------------------------------

  /**
   * Remove the blocks a stream CC abandoned mid-message. They never got a
   * message_stop, so a thinking block has no signature and a tool call is one
   * CC will never dispatch; left in, the next request would replay a broken
   * block. The fallback restart is what makes this a drop and not a retract.
   */
  dropAbandonedStreamBlocks(reason: string): NormalizedClaudeEvent[] {
    const dropped = this.query.turnBlocks.splice(this.query.turnStreamBlockStart);
    this.query.turnToolCallIds = [];
    this.query.turnSawToolCall = this.query.turnBlocks.some((block) => block.type === "toolCall");
    this.query.turnStreamOpen = false;
    const event: NormalizedClaudeEvent = { kind: "stream-reset", dropped: dropped.length, reason };
    if (this.query.turnStreamMessageId !== undefined) {
      return [{ ...event, messageId: this.query.turnStreamMessageId }];
    }
    return [event];
  }

  private get turnOutput(): { stopReason: string } {
    const output = this.query.turnOutput;
    if (!output) {
      throw bridgeError("stream", "CB_STREAM_MAPPING_FAILED", "claude-bridge: stream mapped before a turn was reset");
    }
    return output;
  }

  private nextId(kind: string): string {
    return `${kind}-${this.blockSeq++}`;
  }

  private blockAt(index: number | undefined): MappedBlock | undefined {
    if (index === undefined) return undefined;
    for (const block of this.query.turnBlocks) {
      if ((block as MappedBlock).index === index) return block as MappedBlock;
    }
    return undefined;
  }

  private absorbUsage(usage: ClaudeUsage | undefined): void {
    if (!usage) return;
    const current = this.usage;
    this.usage = {
      inputTokens: usage.input_tokens != null ? usage.input_tokens : current.inputTokens,
      outputTokens: usage.output_tokens != null ? usage.output_tokens : current.outputTokens,
      cacheReadTokens:
        usage.cache_read_input_tokens != null ? usage.cache_read_input_tokens : current.cacheReadTokens,
      cacheWriteTokens:
        usage.cache_creation_input_tokens != null
          ? usage.cache_creation_input_tokens
          : current.cacheWriteTokens,
    };
  }

  private finishEvent(): NormalizedFinishEvent {
    const raw = this.query.turnOutput?.stopReason;
    return {
      kind: "finish",
      usage: this.usage,
      unified: unifiedFinishReason(raw, this.query.turnSawToolCall),
      raw,
    };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (ported from pi-claude-bridge).
// ---------------------------------------------------------------------------

function mapStopReason(reason: string | null | undefined): string {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "stop";
  }
}

function unifiedFinishReason(
  raw: string | undefined,
  sawToolCall: boolean,
): LanguageModelV3FinishReason["unified"] {
  if (raw === "tool_use" || sawToolCall) return "tool-calls";
  if (raw === "max_tokens") return "length";
  if (raw === "refusal") return "content-filter";
  if (raw === "error") return "error";
  return "stop";
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!input) return fallback;
  try {
    return JSON.parse(input) as Record<string, unknown>;
  } catch {
    return fallback;
  }
}

/** Failure text for an SDK result, or undefined when it succeeded. CC reports
 *  API failures with `is_error` on an otherwise success-shaped result. */
function resultErrorText(raw: ClaudeRawEvent): string | undefined {
  if (raw.subtype === "success") {
    return raw.is_error ? raw.result || "Claude Code reported an error" : undefined;
  }
  if (Array.isArray(raw.errors) && raw.errors.length) return raw.errors.map(String).join("\n");
  if (typeof raw.error === "string") return raw.error;
  return `Claude Code failed: ${raw.subtype ?? "unknown result"}`;
}

/** Name a failure as a rate limit when a rejection preceded it. */
function describeRateLimitFailure(
  rejection: { rateLimitType?: string; resetsAt?: number },
  failure: string,
): string {
  const kind = rejection.rateLimitType ? ` (${rejection.rateLimitType})` : "";
  const resets = rejection.resetsAt
    ? ` — resets ${new Date(rejection.resetsAt * 1000).toLocaleTimeString()}`
    : "";
  return `Claude rate limit${kind}${resets}: ${failure}`;
}

function classifyResultError(message: string, rateLimited: boolean): unknown {
  return rateLimited
    ? bridgeError("rate-limit", "CB_RATE_LIMIT_EXCEEDED", message)
    : bridgeError("stream", "CB_STREAM_MAPPING_FAILED", message);
}

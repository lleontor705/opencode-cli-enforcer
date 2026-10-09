/**
 * Per-query and per-turn mutable state (REQ-CB-TOOL-004, design D3).
 *
 * Ported from pi-claude-bridge `src/query-state.ts`. Reentrant queries each get
 * their own QueryContext instance; the query lifecycle pump (cb-11) owns the
 * instances and wires the tool rendezvous into them.
 *
 * Every field is instance-scoped on purpose. A module-level `historyStale` flag
 * was the original bug: a host history rewrite for one query would discard the
 * parked queries of every other live session. Keeping it on the context means
 * it dies with the query it describes.
 */

import type { PromptStream } from "./prompt-stream.js";

/** Minimal content block of a tool result handed back to a parked MCP handler. */
export interface PendingToolResultContent {
  readonly type: string;
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
}

/** Result delivered to a parked tool handler. Structurally compatible with the
 *  tool rendezvous' MCP result (cb-06); QueryContext only references it. */
export interface PendingToolResult {
  readonly content: readonly PendingToolResultContent[];
  readonly isError?: boolean;
  readonly toolCallId?: string;
  readonly [key: string]: unknown;
}

/** A parked MCP handler: the tool call awaiting its result. */
export interface PendingToolCall {
  readonly toolName: string;
  resolve(result: PendingToolResult): void;
}

/** One normalized assistant block accumulated during a turn. The stream mapper
 *  (cb-08) owns the block vocabulary; this stays open so the context does not
 *  encode a provider-specific shape. */
export interface TurnOutputBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** The assistant output assembled for the current turn. */
export interface TurnOutput {
  role: "assistant";
  content: TurnOutputBlock[];
  stopReason: string;
  timestamp: number;
}

export class QueryContext {
  // Query-scoped (fully isolated per query)
  /** Opaque handle of the live query (the SDK `Query` object). Kept `unknown`
   *  so this module does not depend on the SDK's query type. */
  activeQuery: unknown | null = null;
  latestCursor = 0;
  /** References to the tool rendezvous maps (cb-06). QueryContext holds the
   *  reference so the pump can route a result to a parked handler, but it never
   *  creates or clears them itself. */
  pendingToolCalls = new Map<string, PendingToolCall>();
  /** Results that arrived before their call was parked (order-tolerant). */
  pendingResults = new Map<string, PendingToolResult>();
  /** tool_use ids emitted this turn. Persists across tool-result delivery
   *  callbacks within one assistant message so a result can be routed to the
   *  owning query while its handlers are still parked. It is deliberately NOT
   *  reset by resetTurnState(). */
  turnToolCallIds: string[] = [];
  /** Streaming-input handle for the active query — how steers reach CC mid-turn. */
  promptStream: PromptStream | null = null;
  /** Last rate-limit rejection seen on this query. CC sends it just before the
   *  failure it caused, which is the only thing tying the two together. */
  rateLimitRejection: { rateLimitType?: string; resetsAt?: number } | null = null;
  /** Highest 5% utilization bucket notified for, so repeated rate_limit_event
   *  spam is suppressed. */
  lastRateLimitWarnStep: number | null = null;
  lastRateLimitWarnThreshold: number | undefined;
  /** The host rewrote the history this query was built from (compact/revert).
   *  Per-query, NEVER module-global: it must not leak into later turns or other
   *  queries the way a module flag did. */
  historyStale = false;
  /** A steer never reached CC. The completion path must carry this forward. */
  missedSteer = false;

  // Per-turn (reset together)
  turnOutput: TurnOutput | null = null;
  turnStarted = false;
  turnSawStreamEvent = false;
  turnSawToolCall = false;
  /** API message id from the last message_start, and whether its message_stop
   *  has arrived. An `assistant` message under a different id while the stream
   *  is still open is CC's non-streaming fallback for a stalled stream. */
  turnStreamMessageId: string | undefined;
  turnStreamOpen = false;
  /** turnBlocks length at that message_start: where an abandoned attempt's
   *  blocks begin. */
  turnStreamBlockStart = 0;

  get turnBlocks(): TurnOutputBlock[] {
    if (!this.turnOutput) throw new Error("turnBlocks accessed before resetTurnState");
    return this.turnOutput.content;
  }

  resetTurnState(): void {
    this.turnOutput = {
      role: "assistant",
      content: [],
      stopReason: "stop",
      timestamp: Date.now(),
    };
    this.turnStarted = false;
    this.turnSawStreamEvent = false;
    this.turnSawToolCall = false;
    this.turnStreamMessageId = undefined;
    this.turnStreamOpen = false;
    this.turnStreamBlockStart = 0;
    // turnToolCallIds is intentionally preserved: see its field comment.
  }
}

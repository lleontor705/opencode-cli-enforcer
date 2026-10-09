/**
 * Single abort/teardown path and fail-loud leak assertion (REQ-CB-ERR-001, D9).
 *
 * Every way a parked SDK query can end — an `abortSignal`, the Claude Code child
 * exiting, or a normal turn end — funnels through {@link teardownQuery}. The
 * steps are ordered so no awaiting party is left orphaned: the SDK query is
 * interrupted and closed, the ack-carrying prompt stream is failed (settling
 * queued *and* in-flight acks), every parked tools/call handler is resolved with
 * a text result, the session mirror is force-rotated, and the per-query state is
 * cleared.
 *
 * Two invariants are load-bearing and each has a dedicated oracle:
 *
 * - Parked handlers are *resolved*, never rejected. A rejected handler leaves
 *   Claude Code's `tools/call` open forever, which wedges the turn behind it
 *   (pi-bridge `query-state.ts:73-82` engineered exactly that away).
 * - Teardown must leave nothing behind. {@link reportLeaks} scans for the four
 *   leaked artifacts — a dangling query, a pending handler, an unended prompt
 *   stream, or a context still registered as live — and throws naming each one,
 *   so a regression is a fail-loud error instead of a silent per-turn leak.
 */

import { BridgeError } from "./taxonomy.js";
import type { ToolRendezvous } from "../mcp/rendezvous.js";
import type { QueryContext } from "../provider/query-state.js";
import type { MirrorRegistry } from "../session/mirror.js";

/**
 * Structural view of the SDK query handle teardown aborts. Kept minimal and
 * local so this module never depends on the SDK's `Query` type; both methods are
 * optional because a scripted test seam carries only the ones it needs.
 */
export interface AbortableQuery {
  interrupt?: () => unknown;
  close?: () => void;
}

/** Reason a parked handler's synthetic result carries. */
export const TEARDOWN_REASON = "claude-bridge: query torn down";

/**
 * Tracks the query contexts that are still live. A context left in the set after
 * teardown is the "un-released context" leak: it would let a later orphaned tool
 * result route into a query nobody owns. The plugin (cb-15) tracks on spawn and
 * teardown releases here.
 */
export class LiveQueries {
  private readonly contexts = new Set<QueryContext>();

  track(context: QueryContext): void {
    this.contexts.add(context);
  }

  release(context: QueryContext): boolean {
    return this.contexts.delete(context);
  }

  has(context: QueryContext): boolean {
    return this.contexts.has(context);
  }

  get size(): number {
    return this.contexts.size;
  }

  snapshot(): readonly QueryContext[] {
    return [...this.contexts];
  }
}

export interface TeardownRequest {
  readonly context: QueryContext;
  /** Owns the parked tools/call handlers for this query (cb-06). */
  readonly rendezvous?: ToolRendezvous | null;
  /** Mirror registry whose session must be force-rotated (cb-09). */
  readonly mirror?: MirrorRegistry | null;
  /** OpenCode session id whose mirror to rotate. */
  readonly sessionId?: string;
  readonly liveQueries?: LiveQueries | null;
  /** Surfaced to settled handlers and prompt acks; defaults to {@link TEARDOWN_REASON}. */
  readonly reason?: string;
  /** Rejection for queued/in-flight prompt acks; defaults to `new Error(reason)`. */
  readonly error?: Error;
}

export interface TeardownOutcome {
  readonly queryAborted: boolean;
  readonly promptStreamFailed: boolean;
  /** Parked tools/call handlers resolved with a text result. */
  readonly handlersReleased: number;
  readonly mirrorRotated: boolean;
}

/**
 * The single teardown path. Idempotent: a second call on an already-torn-down
 * context finds no live query, stream, handler, or mirror entry and is a no-op.
 */
export function teardownQuery(request: TeardownRequest): TeardownOutcome {
  const { context } = request;
  const reason = request.reason ?? TEARDOWN_REASON;

  const queryAborted = abortSdkQuery(context);
  const promptStreamFailed = failPromptStream(context, request.error ?? new Error(reason));
  const handlersReleased = releaseHandlers(request.rendezvous ?? null, reason);
  const mirrorRotated = rotateMirror(request.mirror ?? null, request.sessionId);
  clearPerQueryState(context);
  request.liveQueries?.release(context);

  return { queryAborted, promptStreamFailed, handlersReleased, mirrorRotated };
}

export interface LeakScanRequest {
  readonly context: QueryContext;
  readonly rendezvous?: ToolRendezvous | null;
  readonly liveQueries?: LiveQueries | null;
}

export interface LeakReport {
  /** Human-readable description of each leaked artifact; empty when clean. */
  readonly leaks: readonly string[];
}

/** Pure leak scan: names every artifact a torn-down context must not retain. */
export function scanLeaks(scan: LeakScanRequest): LeakReport {
  const leaks: string[] = [];
  const { context } = scan;

  if (context.activeQuery !== null) {
    leaks.push(`dangling query (activeQuery=${describe(context.activeQuery)})`);
  }
  if (context.promptStream !== null) {
    leaks.push("unended prompt stream");
  }

  const contextHandlers = context.pendingToolCalls.size + context.pendingResults.size;
  if (contextHandlers > 0) {
    const ids = [...context.pendingToolCalls.keys()].join(", ");
    leaks.push(`pending handler(s) on the query context: ${contextHandlers}${ids ? ` (${ids})` : ""}`);
  }

  const rendezvous = scan.rendezvous ?? null;
  if (rendezvous !== null) {
    if (rendezvous.pendingToolCallCount > 0) {
      leaks.push(`pending tool handler(s) parked in the rendezvous: ${rendezvous.pendingToolCallCount}`);
    }
    if (rendezvous.pendingResultCount > 0) {
      leaks.push(`unreleased tool result(s) buffered in the rendezvous: ${rendezvous.pendingResultCount}`);
    }
  }

  if (scan.liveQueries?.has(context)) {
    leaks.push("unreleased query context (still tracked as live)");
  }

  return { leaks };
}

/**
 * Fail-loud leak assertion (port of pi-bridge `reportLeaks`). Throws naming
 * every leaked artifact; returns a zero-leak report otherwise.
 */
export function reportLeaks(label: string, scan: LeakScanRequest): LeakReport {
  const report = scanLeaks(scan);
  if (report.leaks.length > 0) {
    throw new TeardownLeakError(label, report.leaks);
  }
  return report;
}

/**
 * A teardown left live state behind. Classified in the `stream` taxonomy because
 * the leaked artifacts are stream-lifecycle obligations (acks, parked handlers,
 * a dangling query); the message names each one.
 */
export class TeardownLeakError extends BridgeError {
  readonly leaks: readonly string[];

  constructor(label: string, leaks: readonly string[]) {
    super("stream", "CB_STREAM_MAPPING_FAILED", `claude-bridge: ${label} leaked state — ${leaks.join("; ")}`, {
      details: { label, leaks: [...leaks] },
    });
    this.name = "TeardownLeakError";
    this.leaks = leaks;
  }
}

// ---------------------------------------------------------------------------
// Steps.
// ---------------------------------------------------------------------------

function abortSdkQuery(context: QueryContext): boolean {
  const query = context.activeQuery;
  context.activeQuery = null;
  if (query === null || query === undefined || !isAbortableQuery(query)) return false;
  // interrupt() asks the CLI to stop gracefully; close() kills it. Both are
  // needed — interrupt alone lets the current API call finish.
  try {
    const interrupted = query.interrupt?.();
    void Promise.resolve(interrupted).catch(() => {});
  } catch {
    // The child is already gone; close() below is still attempted.
  }
  try {
    query.close?.();
  } catch {
    // Already closed.
  }
  return true;
}

function isAbortableQuery(value: unknown): value is AbortableQuery {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { interrupt?: unknown; close?: unknown };
  return typeof candidate.interrupt === "function" || typeof candidate.close === "function";
}

function failPromptStream(context: QueryContext, error: Error): boolean {
  const stream = context.promptStream;
  context.promptStream = null;
  if (stream === null) return false;
  stream.fail(error);
  return true;
}

function releaseHandlers(rendezvous: ToolRendezvous | null, reason: string): number {
  if (rendezvous === null) return 0;
  const parked = rendezvous.pendingToolCallCount;
  rendezvous.releasePendingToolCalls(reason);
  return parked;
}

function rotateMirror(mirror: MirrorRegistry | null, sessionId: string | undefined): boolean {
  if (mirror === null || sessionId === undefined) return false;
  return mirror.markAborted(sessionId);
}

function clearPerQueryState(context: QueryContext): void {
  context.pendingToolCalls.clear();
  context.pendingResults.clear();
  context.turnToolCallIds.length = 0;
  context.rateLimitRejection = null;
  context.lastRateLimitWarnStep = null;
  context.lastRateLimitWarnThreshold = undefined;
  context.historyStale = false;
  context.missedSteer = false;
  context.turnOutput = null;
  context.turnStarted = false;
  context.turnSawStreamEvent = false;
  context.turnSawToolCall = false;
  context.turnStreamMessageId = undefined;
  context.turnStreamOpen = false;
  context.turnStreamBlockStart = 0;
}

function describe(value: unknown): string {
  if (typeof value === "object" && value !== null) return Object.prototype.toString.call(value);
  return typeof value;
}

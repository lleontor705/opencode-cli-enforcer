/**
 * agy (Google Antigravity CLI) EventMapper: `init` / `step_update` / `result`
 * NDJSON stream events -> normalized events -> the seam's `TurnResult`
 * (REQ-CB-AGY-001, design D11/D12).
 *
 * Two agy semantics are load-bearing and each has a dedicated oracle:
 *
 * - Cumulative-per-session accounting. `result.usage`, `result.num_turns` and
 *   `result.duration_seconds` accumulate across every turn of a conversation,
 *   while `response` is turn-scoped. The host token accounting must never see a
 *   running total, so this mapper subtracts the session baseline captured at
 *   turn start via the seam's {@link usageDelta}. Step-level `usage` blocks are
 *   per-step contributions, not running totals.
 * - Step-level granularity is a capability downgrade versus Claude's
 *   token-level streaming: agy emits an `ACTIVE`/`DONE` pair per step and the
 *   complete tool call arrives in one `tool_info` block at `DONE`. There is no
 *   partial tool-input stream, no reasoning/thinking text stream, and no
 *   mid-turn steering. The downgrade is reported honestly through
 *   {@link AGY_MAPPER_CAPABILITIES} instead of being papered over.
 *
 * Framing failures are never dropped: a line that is not a JSON object, or one
 * that omits the `event` discriminator, fails loud with a classified taxonomy
 * error. Only unrecognized-but-well-formed event names are skipped, matching
 * agy's own forward-compatibility rule.
 */

import type { EventMapper, TurnResult, TurnStatus, TurnUsage } from "../provider/seams.js";
import { EMPTY_USAGE, usageDelta } from "../provider/seams.js";
import { bridgeError } from "../errors/taxonomy.js";

// ---------------------------------------------------------------------------
// Raw stream shapes (verified against antigravity.google/docs/cli/headless).
// ---------------------------------------------------------------------------

export interface AgyUsagePayload {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly thinking_tokens?: number | null;
  readonly cache_read_tokens?: number | null;
  readonly total_tokens?: number | null;
}

export interface AgyToolError {
  readonly type?: string;
  readonly message?: string;
}

export interface AgyToolInfo {
  readonly name?: string;
  readonly parameters?: Record<string, unknown>;
  readonly output?: string | null;
  readonly error?: AgyToolError | string | null;
}

export interface AgySubagentInfo {
  readonly subagents?: readonly unknown[];
}

export interface AgyStepUpdate {
  readonly conversation_id?: string;
  readonly step_index?: number;
  readonly state?: "ACTIVE" | "DONE" | string;
  readonly step_type?: "user_input" | "agent_response" | "tool" | "checkpoint" | string;
  readonly tool_name?: string;
  readonly text_delta?: string | null;
  readonly duration_seconds?: number;
  readonly usage?: AgyUsagePayload | null;
  readonly tool_info?: AgyToolInfo | null;
  readonly subagent_info?: AgySubagentInfo | null;
}

export interface AgyInitPayload {
  readonly cwd?: string;
  readonly tools?: readonly string[];
  readonly permission_mode?: string;
  readonly model?: string;
  readonly agent?: string;
  readonly json_schema?: unknown;
}

export interface AgyResultPayload {
  readonly conversation_id?: string;
  readonly status?: "SUCCESS" | "ERROR" | "CANCELED" | "INTERRUPTED" | "INVALID" | "WAITING" | "RUNNING" | string;
  readonly response?: string;
  readonly error?: string;
  readonly duration_seconds?: number;
  readonly num_turns?: number;
  readonly usage?: AgyUsagePayload | null;
  readonly structured_output?: unknown;
  readonly json_schema?: unknown;
}

export interface AgyRawEvent {
  readonly event: string;
  readonly conversation_id?: string;
  readonly init?: AgyInitPayload;
  readonly step_update?: AgyStepUpdate;
  readonly result?: AgyResultPayload;
}

// ---------------------------------------------------------------------------
// Normalized event vocabulary (host-facing, provider-owned so the core stays
// schema-agnostic; see the EventMapper<Raw, Normalized> seam).
// ---------------------------------------------------------------------------

export type NormalizedAgyEvent =
  | { readonly kind: "session"; readonly sessionId: string; readonly tools: readonly string[] }
  | { readonly kind: "text-delta"; readonly id: string; readonly delta: string }
  | {
      readonly kind: "tool-call";
      readonly id: string;
      readonly toolName: string;
      readonly input: Record<string, unknown>;
      readonly output: string;
      readonly isError: boolean;
    }
  | { readonly kind: "error"; readonly message: string };

// ---------------------------------------------------------------------------
// Honest capability metadata for the agy downgrade.
// ---------------------------------------------------------------------------

export interface AgyMapperCapabilities {
  /** Text streams per step, not per token. */
  readonly streamingGranularity: "step";
  /** Tool input arrives whole; there is no partial-input stream like Claude's. */
  readonly partialToolInput: false;
  /** No reasoning/thinking text stream (agy counts `thinking_tokens` only). */
  readonly reasoningStream: false;
  /** Steering is enqueued and delivered at the next turn boundary. */
  readonly midTurnSteer: false;
  /** Cumulative-per-session counters are converted to turn-scoped deltas here. */
  readonly usageAccounting: "cumulative-normalized-at-seam";
}

export const AGY_MAPPER_CAPABILITIES: AgyMapperCapabilities = Object.freeze({
  streamingGranularity: "step",
  partialToolInput: false,
  reasoningStream: false,
  midTurnSteer: false,
  usageAccounting: "cumulative-normalized-at-seam",
});

// ---------------------------------------------------------------------------
// Framing.
// ---------------------------------------------------------------------------

/**
 * Parse one NDJSON line into a raw agy event.
 *
 * A malformed frame is a hard protocol violation, not noise to discard: the
 * transport has no way to recover the turn it belonged to, so it is surfaced
 * as a classified `stream`/`CB_STREAM_MAPPING_FAILED` error.
 */
export function parseAgyLine(line: string): AgyRawEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw bridgeError(
      "stream",
      "CB_STREAM_MAPPING_FAILED",
      `agy stream frame is not valid JSON: ${preview(line)}`,
      { cause },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw bridgeError(
      "stream",
      "CB_STREAM_MAPPING_FAILED",
      `agy stream frame is not a JSON object: ${preview(line)}`,
    );
  }
  const event = (parsed as { event?: unknown }).event;
  if (typeof event !== "string" || event.length === 0) {
    throw bridgeError(
      "stream",
      "CB_STREAM_MAPPING_FAILED",
      `agy stream frame is missing its "event" discriminator: ${preview(line)}`,
    );
  }
  return parsed as AgyRawEvent;
}

// ---------------------------------------------------------------------------
// The mapper.
// ---------------------------------------------------------------------------

export class AgyEventMapper implements EventMapper<AgyRawEvent, NormalizedAgyEvent> {
  readonly capabilities: AgyMapperCapabilities = AGY_MAPPER_CAPABILITIES;

  private sessionId: string | undefined;
  private tools: readonly string[] = [];
  /** Cumulative usage at the start of the current turn = end of the last one. */
  private baseline: TurnUsage = EMPTY_USAGE;
  private textSeq = 0;

  /** Conversation id captured from `init`/`result`, if one was seen. */
  get capturedSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Cumulative usage the next turn's delta will be measured against. */
  get sessionBaseline(): TurnUsage {
    return this.baseline;
  }

  /** Reset the session baseline (e.g. when the host rotates conversations). */
  resetSession(baseline: TurnUsage = EMPTY_USAGE): void {
    this.sessionId = undefined;
    this.tools = [];
    this.baseline = baseline;
    this.textSeq = 0;
  }

  map(raw: AgyRawEvent): readonly NormalizedAgyEvent[] {
    switch (raw.event) {
      case "init":
        return this.mapInit(raw);
      case "step_update":
        return this.mapStepUpdate(raw);
      case "result":
        return this.mapResult(raw);
      // Unrecognized but well-formed events are skipped, mirroring agy's own
      // forward-compatibility rule for newer protocol versions.
      default:
        return [];
    }
  }

  /** Parse one NDJSON line and normalize it (framing errors fail loud). */
  mapLine(line: string): readonly NormalizedAgyEvent[] {
    return this.map(parseAgyLine(line));
  }

  /**
   * Fold one turn's raw events into the seam's {@link TurnResult}.
   *
   * The returned usage is `usageDelta(cumulativeAtTurnEnd, baselineAtTurnStart)`
   * and the baseline then advances to the turn's ending cumulative, so two
   * consecutive turns on the same mapper sum to the session total exactly once.
   * Must be called at most once per turn.
   */
  toTurnResult(rawEvents: readonly AgyRawEvent[]): TurnResult {
    let sessionId: string | undefined;
    let cumulative: TurnUsage | undefined;
    let stepUsage: TurnUsage = EMPTY_USAGE;
    let status: TurnStatus = "completed";
    let response: string | undefined;
    const fragments: string[] = [];

    for (const raw of rawEvents) {
      if (raw.event === "init") {
        if (raw.conversation_id) sessionId = raw.conversation_id;
        if (raw.init?.tools) this.tools = raw.init.tools;
        continue;
      }
      if (raw.event === "step_update") {
        const step = raw.step_update;
        if (!step) continue;
        if (step.conversation_id) sessionId = step.conversation_id;
        if (typeof step.text_delta === "string" && step.text_delta.length > 0) {
          fragments.push(step.text_delta);
        }
        stepUsage = sumUsage(stepUsage, toTurnUsage(step.usage));
        continue;
      }
      if (raw.event === "result") {
        const result = raw.result;
        if (!result) continue;
        if (result.conversation_id) sessionId = result.conversation_id;
        status = mapAgyStatus(result.status);
        if (typeof result.response === "string") response = result.response;
        cumulative = toTurnUsage(result.usage);
      }
    }

    // A turn normally ends with a `result`; when it did not (transport drop),
    // the step-level contributions are the only evidence of what was spent.
    const turnCumulative = cumulative ?? sumUsage(this.baseline, stepUsage);
    const usage = usageDelta(turnCumulative, this.baseline);
    this.baseline = turnCumulative;

    const text = response !== undefined && response.length > 0 ? response : fragments.join("");
    return {
      status,
      text,
      usage,
      sessionId: sessionId ?? this.sessionId ?? "unknown",
    };
  }

  // -- Raw event handlers ---------------------------------------------------

  private mapInit(raw: AgyRawEvent): readonly NormalizedAgyEvent[] {
    const sessionId = raw.conversation_id;
    if (!sessionId) {
      throw bridgeError("stream", "CB_STREAM_MAPPING_FAILED", "agy init frame is missing conversation_id");
    }
    this.sessionId = sessionId;
    this.tools = raw.init?.tools ?? [];
    return [{ kind: "session", sessionId, tools: this.tools }];
  }

  private mapStepUpdate(raw: AgyRawEvent): readonly NormalizedAgyEvent[] {
    const step = raw.step_update;
    if (!step) {
      throw bridgeError("stream", "CB_STREAM_MAPPING_FAILED", "agy step_update frame is missing its payload");
    }
    if (step.conversation_id) this.sessionId = step.conversation_id;

    if (typeof step.text_delta === "string" && step.text_delta.length > 0) {
      return [{ kind: "text-delta", id: `text-${step.step_index ?? this.textSeq++}`, delta: step.text_delta }];
    }
    if (step.step_type === "tool" || step.tool_info) {
      const info = step.tool_info;
      if (!info) return [];
      return [normalizeToolCall(step)];
    }
    // user_input, checkpoint and subagent_info steps carry no host-facing part.
    return [];
  }

  private mapResult(raw: AgyRawEvent): readonly NormalizedAgyEvent[] {
    const result = raw.result;
    if (!result) {
      throw bridgeError("stream", "CB_STREAM_MAPPING_FAILED", "agy result frame is missing its payload");
    }
    if (result.conversation_id) this.sessionId = result.conversation_id;
    const status = mapAgyStatus(result.status);
    if (status === "completed") return [];
    const message =
      typeof result.error === "string" && result.error.length > 0
        ? result.error
        : `agy turn ended with status ${result.status ?? "unknown"}`;
    return [{ kind: "error", message }];
  }
}

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

/** Map agy's terminal status onto the seam's normalized {@link TurnStatus}. */
export function mapAgyStatus(status: string | undefined): TurnStatus {
  switch (status) {
    case "SUCCESS":
      return "completed";
    case "CANCELED":
    case "INTERRUPTED":
    case "WAITING":
      return "aborted";
    case "ERROR":
    case "INVALID":
    case "RUNNING":
      return "failed";
    // An unknown terminal status is a protocol surprise, not a success.
    default:
      return "failed";
  }
}

/** Convert an agy usage block into the seam's turn-scoped counters. */
export function toTurnUsage(usage: AgyUsagePayload | null | undefined): TurnUsage {
  return {
    inputTokens: counter(usage?.input_tokens),
    outputTokens: counter(usage?.output_tokens),
    cacheReadTokens: counter(usage?.cache_read_tokens),
    // agy reports no cache-write counter.
    cacheWriteTokens: 0,
  };
}

function normalizeToolCall(step: AgyStepUpdate): NormalizedAgyEvent {
  const info = step.tool_info ?? {};
  const toolName = info.name ?? step.tool_name ?? "";
  return {
    kind: "tool-call",
    id: `tool-${step.step_index ?? 0}`,
    toolName,
    input: info.parameters ?? {},
    output: typeof info.output === "string" ? info.output : "",
    isError: isToolError(info.error),
  };
}

function isToolError(error: AgyToolInfo["error"]): boolean {
  if (error == null) return false;
  if (typeof error === "string") return error.length > 0;
  return true;
}

function sumUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

function counter(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function preview(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed;
}

/**
 * agy (Google Antigravity CLI) SessionStore — opaque conversationRef capture and resume
 * (REQ-CB-AGY-001 session half, design D4/D11).
 *
 * agy persists conversations itself, one SQLite database per conversation, in its own
 * client-side store. That store is provider-private: this module NEVER opens, reads,
 * writes, or parses it (D11 hard rule — the handle stays opaque end-to-end). The bridge
 * learns a conversation's identity only from the `conversation_id` field carried by the
 * stream's `init` and `result` events, and resumes it with the measured
 * `--conversation <uuid>` flag. (`--continue` also exists, but it is implicit "most
 * recent"; the explicit flag is preferred so a handle always names the exact conversation.)
 *
 * Capability-honest gaps versus the Claude mirror (src/session/mirror.ts, cb-09):
 *  - No REBUILD/rewrite path: agy owns its storage format, so the bridge cannot
 *    reconstruct host history into it. A host history rewrite therefore degrades to a
 *    documented clean-start — the handle is dropped, a fresh conversation begins, and the
 *    resulting prompt-cache loss is accepted.
 *  - No force-rotate: agy exposes no way to rotate an aborted conversation's storage in
 *    place, so an abort also degrades to clean-start on the next turn — the only safe
 *    option, since reusing a conversation whose turn was killed mid-flight is undefined.
 *
 * This module is deliberately filesystem-free: it imports nothing but the seam types and
 * the error taxonomy, so "never touches provider storage" is a structural property.
 */

import { bridgeError } from "../errors/taxonomy.js";
import type { SessionHandle, SessionStore } from "../provider/seams.js";

export const AGY_PROVIDER_ID = "agy";

/** Serialization version stamped onto every persisted agy handle. */
export const AGY_HANDLE_VERSION = 1;

/** JSON-safe, versioned encoding of an agy {@link SessionHandle}. */
export interface SerializedAgyHandle {
  readonly v: typeof AGY_HANDLE_VERSION;
  readonly provider: typeof AGY_PROVIDER_ID;
  readonly conversationRef: string;
}

/**
 * Documented capability surface of the agy session seam. `supportsRebuild` and
 * `supportsForceRotate` are false not by omission but because agy storage is opaque to the
 * bridge; both paths collapse into `clean-start`.
 */
export const AGY_SESSION_CAPABILITIES = Object.freeze({
  provider: AGY_PROVIDER_ID,
  supportsReuse: true,
  supportsRebuild: false,
  supportsForceRotate: false,
  cleanStartCauses: Object.freeze([
    "no-handle",
    "history-stale",
    "aborted",
    "diverged-provider",
  ] as const),
});

/** Why a turn could not reuse its prior conversation. */
export type AgyCleanStartCause = (typeof AGY_SESSION_CAPABILITIES.cleanStartCauses)[number];

export type AgySessionTransition = "reuse" | "clean-start";

export interface AgyTurnPlan {
  readonly transition: AgySessionTransition;
  /** Handle to resume, or null to start a fresh conversation. */
  readonly handle: SessionHandle | null;
  /** Resume argv for the transport (cb-21); empty on clean-start. */
  readonly resumeArgs: readonly string[];
  /** Present only when the transition is clean-start. */
  readonly cause?: AgyCleanStartCause;
}

export interface AgyTurnInput {
  readonly handle?: SessionHandle | null;
  /** The host rewrote this session's history (compaction or revert). */
  readonly historyStale?: boolean;
  /** The previous turn was aborted; its conversation must not be reused. */
  readonly aborted?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Pull the conversation id out of any event shape capture accepts. The real wire
 * discriminates on `event.event`; the legacy/typed shape uses `event.type`; and the
 * mapper's normalized session event uses `kind: "session"` + `sessionId`.
 */
function agyConversationRef(event: Record<string, unknown>): string | undefined {
  const name = event.event ?? event.type;
  if (name === "init") return asConversationRef(event.conversation_id);
  if (name === "result") {
    // Real wire nests the id under `result`; keep tolerating a flat `conversation_id`.
    const nested = isRecord(event.result) ? event.result.conversation_id : undefined;
    return asConversationRef(nested) ?? asConversationRef(event.conversation_id);
  }
  if (event.kind === "session") return asConversationRef(event.sessionId);
  return undefined;
}

function asConversationRef(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value : undefined;
}

export class AgySessionStore implements SessionStore {
  /**
   * Capture the opaque handle from an `init` or `result` stream event.
   *
   * The real agy wire discriminates on `event.event` (not `event.type`) and carries the id
   * at the top level for `init` but nested under the payload for `result`; the mapper's
   * normalized session event (`{kind: "session", sessionId}`) is accepted too, so capture
   * works whether it is fed the raw frame or the seam-normalized one. Anything else —
   * including a recognized event without a usable id — yields `undefined`, so the caller
   * keeps whatever handle it already had. Malformed frames are *not* silently swallowed:
   * they fail loud upstream in the mapper's framed/parse stage, which owns the taxonomy.
   */
  capture(event: unknown): SessionHandle | undefined {
    if (!isRecord(event)) return undefined;
    const conversationRef = agyConversationRef(event);
    if (conversationRef === undefined) return undefined;
    return { provider: AGY_PROVIDER_ID, conversationRef };
  }

  serialize(handle: SessionHandle): string {
    const conversationRef = this.requireAgyRef(handle);
    const serialized: SerializedAgyHandle = {
      v: AGY_HANDLE_VERSION,
      provider: AGY_PROVIDER_ID,
      conversationRef,
    };
    return JSON.stringify(serialized);
  }

  deserialize(value: string): SessionHandle {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (cause) {
      throw bridgeError(
        "session-mirror",
        "CB_SESSION_MIRROR_INTEGRITY",
        "claude-bridge: malformed agy session handle (not JSON)",
        { cause },
      );
    }
    if (
      !isRecord(parsed) ||
      parsed.v !== AGY_HANDLE_VERSION ||
      parsed.provider !== AGY_PROVIDER_ID ||
      !isNonEmptyString(parsed.conversationRef)
    ) {
      throw bridgeError(
        "session-mirror",
        "CB_SESSION_MIRROR_INTEGRITY",
        "claude-bridge: malformed agy session handle (version/provider/ref)",
      );
    }
    return { provider: AGY_PROVIDER_ID, conversationRef: parsed.conversationRef };
  }

  /**
   * Extra argv to resume a conversation. No handle means a new session, so there is
   * nothing to resume: `[]`.
   */
  resumeArgs(handle?: SessionHandle | null): readonly string[] {
    if (handle === undefined || handle === null) return [];
    return ["--conversation", this.requireAgyRef(handle)];
  }

  /**
   * Decide whether the coming turn reuses the captured conversation or clean-starts.
   * agy has no rebuild or force-rotate path, so every "cannot safely continue" input —
   * missing, foreign, or stale handle, or a prior abort — collapses to a dropped handle.
   */
  planTurn(input: AgyTurnInput): AgyTurnPlan {
    const cleanStart = (cause: AgyCleanStartCause): AgyTurnPlan => ({
      transition: "clean-start",
      handle: null,
      resumeArgs: [],
      cause,
    });

    const handle = input.handle ?? null;
    if (handle === null) return cleanStart("no-handle");
    if (handle.provider !== AGY_PROVIDER_ID) return cleanStart("diverged-provider");
    if (input.historyStale) return cleanStart("history-stale");
    if (input.aborted) return cleanStart("aborted");

    return {
      transition: "reuse",
      handle,
      resumeArgs: this.resumeArgs(handle),
    };
  }

  private requireAgyRef(handle: SessionHandle): string {
    if (handle.provider !== AGY_PROVIDER_ID) {
      throw bridgeError(
        "session-mirror",
        "CB_SESSION_MIRROR_DIVERGENCE",
        `claude-bridge: agy session handle carries foreign provider "${handle.provider}"`,
      );
    }
    if (!isNonEmptyString(handle.conversationRef)) {
      throw bridgeError(
        "session-mirror",
        "CB_SESSION_MIRROR_INTEGRITY",
        "claude-bridge: agy session handle has an empty conversationRef",
      );
    }
    return handle.conversationRef;
  }
}

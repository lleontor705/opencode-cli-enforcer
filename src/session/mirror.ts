/**
 * Per-OpenCode-session Claude Code mirror state machine (REQ-CB-SESS-001, D4).
 *
 * Ported in intent from pi-claude-bridge `syncSharedSession`/`SessionState`.
 * This module owns the decision half of the mirror: which transition a turn
 * takes, and the per-session state those transitions read and write. It never
 * touches the JSONL on disk — that is the `MirrorPersistence` seam, implemented
 * by src/session/io.ts (cb-10) — so the state machine stays unit-testable and
 * the provider seam stays storage-agnostic.
 *
 * The mirror is keyed by the OpenCode session it serves: one bridge process
 * serves several sessions at once, so a single shared slot would let one
 * session's shape-matching context REUSE or rebuild another session's file.
 */

import type { CarriedAttachment } from "./attachments.js";

/**
 * Disposition of one session's mirror.
 *
 * `empty` has no Claude Code session yet; `aligned` matches the host history at
 * `latestCursor`; `rebuild-pending` saw a host history rewrite and must rewrite
 * the file before the next reuse; `quarantined` follows an abort, where the
 * killed subprocess may still be flushing a late record and the next turn must
 * rotate to a fresh file rather than race that orphan write.
 */
export type MirrorPhase = "empty" | "aligned" | "rebuild-pending" | "quarantined";

/** Per-OpenCode-session mirror state. */
export interface MirrorState {
  readonly ccSessionId: string | null;
  readonly latestCursor: number;
  readonly needsRebuild: boolean;
  readonly phase: MirrorPhase;
}

export type MirrorTransitionKind =
  | "reuse"
  | "clean-start-preserve"
  | "clean-start"
  | "rebuild"
  | "force-rotate";

/** The host-side message shape the mirror reasons about. */
export interface HostMessage {
  readonly role: string;
  readonly [key: string]: unknown;
}

export interface MirrorTurnInput {
  /** Host conversation history, already excluding system messages. */
  readonly priorMessages: readonly HostMessage[];
  readonly state: MirrorState | null;
  /** Per-query: the host rewrote the history this query was built from. */
  readonly historyStale: boolean;
}

export interface MirrorPlan {
  readonly transition: MirrorTransitionKind;
  /** Claude Code session id to resume, or null to spawn a fresh session. */
  readonly resumeSessionId: string | null;
  /** A full-file JSONL rewrite from host history is required. */
  readonly rewrite: boolean;
  /** The rewrite keeps the existing Claude Code session id. */
  readonly preserveSessionId: boolean;
  /** The rewrite mints a fresh id to dodge an orphan writer. */
  readonly rotate: boolean;
  /** Host message count the mirror is aligned to once this plan is applied. */
  readonly cursor: number;
  readonly nextPhase: MirrorPhase;
}

/**
 * Decide the transition for one turn. Pure; the caller commits the resulting
 * state once the persistence seam confirms what was actually written.
 */
export function decideMirrorTurn(input: MirrorTurnInput): MirrorPlan {
  const { priorMessages, state, historyStale } = input;
  const cursor = priorMessages.length;

  // A quarantined mirror must rotate before it can be reused: reusing the same
  // id/path would race the killed subprocess' orphan write into the fresh file.
  if (state !== null && state.phase === "quarantined") {
    return {
      transition: "force-rotate",
      resumeSessionId: null,
      rewrite: true,
      preserveSessionId: false,
      rotate: true,
      cursor,
      nextPhase: cursor === 0 ? "empty" : "aligned",
    };
  }

  const mustRebuild = historyStale || (state?.needsRebuild ?? false);

  if (state !== null && !mustRebuild) {
    if (priorMessages.length >= state.latestCursor) {
      const missed = priorMessages.slice(state.latestCursor);
      const trailingAssistantOnly =
        missed.length === 1 && missed[0]?.role === "assistant";
      if (missed.length === 0 || trailingAssistantOnly) {
        return {
          transition: "reuse",
          resumeSessionId: state.ccSessionId,
          rewrite: false,
          preserveSessionId: false,
          rotate: false,
          cursor,
          nextPhase: "aligned",
        };
      }
      // Missed non-trailing content: the incoming context cannot be a pure
      // continuation, so rewrite the full history below, preserving the id.
    } else {
      // Shorter than the cursor: cannot be a continuation of the cached
      // session, so rewrite from host history while keeping the id stable.
      return {
        transition: "clean-start-preserve",
        resumeSessionId: state.ccSessionId,
        rewrite: true,
        preserveSessionId: true,
        rotate: false,
        cursor,
        nextPhase: "aligned",
      };
    }
  }

  // REBUILD path: a full overwrite at the same path, or a fresh session when
  // there is no id to preserve (first turn, dropped mirror, or post-abort).
  if (priorMessages.length === 0) {
    return {
      transition: "clean-start",
      resumeSessionId: null,
      rewrite: false,
      preserveSessionId: false,
      rotate: true,
      cursor: 0,
      nextPhase: "empty",
    };
  }

  const previousId = state?.ccSessionId ?? null;
  return {
    transition: "rebuild",
    resumeSessionId: previousId,
    rewrite: true,
    preserveSessionId: previousId !== null,
    rotate: previousId === null,
    cursor,
    nextPhase: "aligned",
  };
}

export interface MirrorWriteRequest {
  readonly sessionId: string;
  readonly cwd: string;
  readonly priorMessages: readonly HostMessage[];
  /** Id the rewrite preserves, or null to mint a fresh one. */
  readonly resumeSessionId: string | null;
  readonly rotate: boolean;
  /** Attachments read from the file before it was overwritten. */
  readonly carried: readonly CarriedAttachment[];
  readonly model?: string;
}

export interface MirrorWriteOutcome {
  readonly ccSessionId: string;
  readonly recordCount: number;
}

/**
 * Persistence seam. src/session/io.ts (cb-10) implements this with
 * cc-session-io, honoring CLAUDE_CONFIG_DIR and verifying each write; the
 * mirror never imports cc-session-io itself.
 */
export interface MirrorPersistence {
  /** Read carried `@file` attachments before the file is deleted/overwritten. */
  readCarriedAttachments(ccSessionId: string, cwd: string): readonly CarriedAttachment[];
  /** Delete the session file so a preserved-id rewrite does not append to it. */
  deleteSession(ccSessionId: string, cwd: string): void;
  writeSession(request: MirrorWriteRequest): MirrorWriteOutcome;
}

export interface MirrorSnapshot {
  readonly sessionId: string;
  readonly state: MirrorState;
}

/**
 * The per-session mirror map. Every read and write addresses one key, so a
 * rewrite mark for one OpenCode session never touches another's mirror — the
 * property a module-global `historyStale` flag lost.
 */
export class MirrorRegistry {
  private readonly mirrors = new Map<string, MirrorState>();

  get(sessionId: string): MirrorState | null {
    return this.mirrors.get(sessionId) ?? null;
  }

  set(sessionId: string, state: MirrorState | null): void {
    if (state === null) {
      this.mirrors.delete(sessionId);
      return;
    }
    this.mirrors.set(sessionId, state);
  }

  snapshots(): readonly MirrorSnapshot[] {
    return [...this.mirrors.entries()].map(([sessionId, state]) => ({ sessionId, state }));
  }

  /**
   * The host rewrote this session's history (compact, revert, tree navigation).
   * Marks only this session's mirror; a rewrite attributed to another session
   * must not force a rebuild here. Returns false when no mirror exists yet —
   * the rewrite then reaches the decision through the per-query `historyStale`.
   */
  markRebuildForSession(sessionId: string, _event: string): boolean {
    const state = this.mirrors.get(sessionId);
    if (!state) return false;
    this.mirrors.set(sessionId, { ...state, needsRebuild: true, phase: "rebuild-pending" });
    return true;
  }

  /**
   * The query was aborted and its Claude Code subprocess killed. The orphaned
   * writer may still flush a late record, so the mirror must rotate rather than
   * rebuild in place. Returns false when no mirror exists yet.
   */
  markAborted(sessionId: string): boolean {
    const state = this.mirrors.get(sessionId);
    if (!state) return false;
    this.mirrors.set(sessionId, { ...state, needsRebuild: true, phase: "quarantined" });
    return true;
  }

  planTurn(sessionId: string, input: Omit<MirrorTurnInput, "state">): MirrorPlan {
    return decideMirrorTurn({ ...input, state: this.get(sessionId) });
  }

  commit(sessionId: string, plan: MirrorPlan, ccSessionId: string | null): MirrorState {
    const state: MirrorState = {
      ccSessionId: ccSessionId ?? plan.resumeSessionId,
      latestCursor: plan.cursor,
      needsRebuild: false,
      phase: plan.nextPhase,
    };
    this.mirrors.set(sessionId, state);
    return state;
  }
}

export interface MirrorSyncInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly priorMessages: readonly HostMessage[];
  readonly historyStale?: boolean;
  readonly model?: string;
}

export interface MirrorSyncResult {
  /** Id to resume the Claude Code query from, or null to spawn fresh. */
  readonly sessionId: string | null;
  readonly plan: MirrorPlan;
  readonly state: MirrorState;
  readonly carried: readonly CarriedAttachment[];
  readonly recordCount: number;
}

/**
 * Ensure the mirror holds every prior message before the current turn, and
 * report the session id the query should resume from.
 */
export function syncMirror(
  registry: MirrorRegistry,
  input: MirrorSyncInput,
  persistence: MirrorPersistence,
): MirrorSyncResult {
  const previous = registry.get(input.sessionId);
  const plan = decideMirrorTurn({
    priorMessages: input.priorMessages,
    state: previous,
    historyStale: input.historyStale ?? false,
  });

  if (plan.transition === "reuse") {
    const state = registry.commit(input.sessionId, plan, previous?.ccSessionId ?? null);
    return { sessionId: plan.resumeSessionId, plan, state, carried: [], recordCount: 0 };
  }

  if (plan.transition === "clean-start") {
    const state = registry.commit(input.sessionId, plan, null);
    return { sessionId: null, plan, state, carried: [], recordCount: 0 };
  }

  // Before deleteSession: it wipes the file the carried attachments live in.
  const carried = previous?.ccSessionId
    ? persistence.readCarriedAttachments(previous.ccSessionId, input.cwd)
    : [];
  // A preserved-id rewrite must not append to the old file. force-rotate skips
  // the delete on purpose: the orphan writer flushes into a dead inode.
  if (plan.preserveSessionId && previous?.ccSessionId) {
    persistence.deleteSession(previous.ccSessionId, input.cwd);
  }
  const written = persistence.writeSession({
    sessionId: input.sessionId,
    cwd: input.cwd,
    priorMessages: input.priorMessages,
    resumeSessionId: plan.resumeSessionId,
    rotate: plan.rotate,
    carried,
    ...(input.model ? { model: input.model } : {}),
  });
  const state = registry.commit(input.sessionId, plan, written.ccSessionId);
  return {
    sessionId: written.ccSessionId,
    plan,
    state,
    carried,
    recordCount: written.recordCount,
  };
}

/**
 * cc-session-io-backed implementation of the mirror persistence seam
 * (REQ-CB-SESS-002, design D4).
 *
 * mirror.ts owns *when* the JSONL is rewritten; this module owns *how* it lands
 * on disk: under `~/.claude/projects` (or `CLAUDE_CONFIG_DIR`), as a full-file
 * rewrite that preserves the Claude Code session id, with `@file` attachments
 * re-materialized at stable ordinals, and a fail-closed post-write integrity
 * gate. A write here returns a verified mirror or throws — the caller never gets
 * a success answer for a file the bridge cannot re-read.
 */

import {
  createSession,
  deleteSession as deleteCcSession,
  openSession,
  repairToolPairing,
  serializeRecord,
} from "cc-session-io";

import { collectCarriedAttachments, placeCarriedAttachments } from "./attachments.js";
import type { CarriedAttachment } from "./attachments.js";
import type {
  HostMessage,
  MirrorPersistence,
  MirrorWriteOutcome,
  MirrorWriteRequest,
} from "./mirror.js";
import { convertMessages } from "../stream/convert.js";
import type { BridgeMessage } from "../stream/convert.js";
import { assertSessionIntegrity } from "./verify.js";
import type { SessionWriteVerification } from "./verify.js";

/**
 * The post-write integrity gate. Injectable so the abort path can be exercised
 * deterministically; defaults to the fail-closed {@link assertSessionIntegrity}.
 */
export type SessionIntegrityGate = (verification: SessionWriteVerification) => void;

export interface MirrorPersistenceOptions {
  /** Claude config root. Defaults to `CLAUDE_CONFIG_DIR`, then `~/.claude`. */
  readonly claudeDir?: string;
  readonly integrityGate?: SessionIntegrityGate;
}

/**
 * mirror.ts deliberately keeps host messages open (`{ role, ...fields }`) so the
 * state machine never couples to a provider's block grammar; cb-08's canonical
 * conversion reads the same fields. This narrows the open shape to that
 * conversion's input instead of re-implementing the host<->Anthropic grammar.
 */
function asBridgeMessages(messages: readonly HostMessage[]): BridgeMessage[] {
  return messages as unknown as BridgeMessage[];
}

export function createMirrorPersistence(
  options: MirrorPersistenceOptions = {},
): MirrorPersistence {
  const configDir = (): string | undefined => options.claudeDir ?? process.env.CLAUDE_CONFIG_DIR;

  return {
    readCarriedAttachments(ccSessionId: string, cwd: string): readonly CarriedAttachment[] {
      try {
        const previous = openSession({
          sessionId: ccSessionId,
          projectPath: cwd,
          claudeDir: configDir(),
        });
        return collectCarriedAttachments(previous.records);
      } catch {
        // A post-abort rebuild can read a file the killed CC subprocess was
        // midway through writing, and cc-session-io parses each line with a bare
        // JSON.parse, so a truncated tail throws. Carrying no attachment is the
        // pre-existing behaviour, so a lost attachment stays lost rather than
        // becoming a failed turn.
        return [];
      }
    },

    deleteSession(ccSessionId: string, cwd: string): void {
      deleteCcSession(ccSessionId, cwd, configDir());
    },

    writeSession(request: MirrorWriteRequest): MirrorWriteOutcome {
      const session = createSession({
        projectPath: request.cwd,
        claudeDir: configDir(),
        ...(request.resumeSessionId !== null ? { sessionId: request.resumeSessionId } : {}),
        ...(request.model ? { model: request.model } : {}),
      });

      const { anthropicMessages } = convertMessages(asBridgeMessages(request.priorMessages));
      // Placement runs against the repaired array because that is the index
      // space importMessages reads. Attachments are links in Claude Code's uuid
      // chain, so they are written in order with the messages, not appended.
      const repaired = repairToolPairing(anthropicMessages);
      const placed = request.carried.length
        ? placeCarriedAttachments(request.carried, repaired)
        : undefined;

      if (repaired.length > 0) {
        session.importMessages(
          repaired,
          placed?.attachments.length ? { attachments: placed.attachments } : undefined,
        );
      }
      session.save();

      // A no-message turn writes no file, so there is nothing to verify. Any
      // real write is gated: a mismatch throws out of writeSession and the turn
      // aborts the mirror path rather than resuming a corrupt file.
      if (session.records.length > 0) {
        const gate = options.integrityGate ?? assertSessionIntegrity;
        gate({
          jsonlPath: session.jsonlPath,
          expectedSessionId: session.sessionId,
          expectedLines: session.records.map(serializeRecord),
        });
      }

      return { ccSessionId: session.sessionId, recordCount: session.records.length };
    },
  };
}

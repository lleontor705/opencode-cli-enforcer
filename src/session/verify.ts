/**
 * Post-write integrity verification for the Claude Code session mirror
 * (REQ-CB-SESS-002, design D4).
 *
 * Ported from pi-claude-bridge `src/session-verify.ts`, which returned a warning
 * list and left surfacing to the caller. The bridge has to be fail-closed here,
 * so the same checks are paired with `assertSessionIntegrity`: a mirror the
 * bridge cannot prove it wrote is a mirror the next turn must not silently
 * resume on. Reading the whole file and comparing it line by line — rather than
 * a count plus first/last check — is what distinguishes "a session-shaped file
 * exists" from "this is the file this write produced".
 */

import { readFileSync, statSync } from "node:fs";

export interface SessionWriteVerification {
  readonly jsonlPath: string;
  /** Session id every record in the file must claim. */
  readonly expectedSessionId: string;
  /** The serialized records the write intended, in order, without newlines. */
  readonly expectedLines: readonly string[];
}

function nonEmptyLines(content: string): string[] {
  return content.split("\n").filter((line) => line.trim().length > 0);
}

/**
 * Re-read the written file and report every way it differs from the intended
 * write. Returns an empty array only when the file is exactly what was written.
 */
export function verifyWrittenSession(verification: SessionWriteVerification): string[] {
  const warnings: string[] = [];
  const { jsonlPath, expectedSessionId, expectedLines } = verification;

  let size: number;
  try {
    size = statSync(jsonlPath).size;
  } catch (error) {
    return [`file missing after save — path=${jsonlPath} err=${(error as Error).message}`];
  }

  let content: string;
  try {
    content = readFileSync(jsonlPath, "utf8");
  } catch (error) {
    return [`file unreadable — path=${jsonlPath} size=${size} err=${(error as Error).message}`];
  }

  const lines = nonEmptyLines(content);
  if (lines.length !== expectedLines.length) {
    warnings.push(
      `record count mismatch — expected=${expectedLines.length} actual=${lines.length} path=${jsonlPath} bytes=${content.length}`,
    );
    return warnings;
  }

  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== expectedLines[i]) {
      warnings.push(`line ${i} mismatch — path=${jsonlPath}`);
      break;
    }
  }

  if (lines.length > 0) {
    try {
      const first = JSON.parse(lines[0]!) as { sessionId?: unknown };
      const last = JSON.parse(lines[lines.length - 1]!) as { sessionId?: unknown };
      if (first.sessionId !== expectedSessionId || last.sessionId !== expectedSessionId) {
        warnings.push(
          `sessionId drift — expected=${expectedSessionId} first=${String(first.sessionId)} last=${String(last.sessionId)}`,
        );
      }
    } catch (error) {
      warnings.push(`malformed JSONL — path=${jsonlPath} err=${(error as Error).message}`);
    }
  }

  return warnings;
}

/** Thrown when a written mirror cannot be re-verified. Fail-closed: the caller
 *  must treat the write as failed and abort the mirror path for this turn. */
export class SessionIntegrityError extends Error {
  readonly warnings: readonly string[];

  constructor(warnings: readonly string[]) {
    super(`session mirror failed integrity verification: ${warnings.join("; ")}`);
    this.name = "SessionIntegrityError";
    this.warnings = warnings;
  }
}

/** Fail-closed form of {@link verifyWrittenSession}. */
export function assertSessionIntegrity(verification: SessionWriteVerification): void {
  const warnings = verifyWrittenSession(verification);
  if (warnings.length > 0) throw new SessionIntegrityError(warnings);
}

import { bridgeError } from "./taxonomy.js";

/**
 * Fail-loud prompt projection (REQ-CB-ERR-002, design D5).
 *
 * Ported from pi-claude-bridge `src/prompt-capture.ts` (assertSendablePrompt and
 * resolveOrDerive's refusal contract): projection MUST throw when a part cannot
 * be sent, never silently drop the user's instructions. A failed turn is
 * recoverable; a turn that quietly ignored its policy is not.
 */

/** Pi's own preamble. Machine-generated, so operator text never carries it;
 *  forwarding it makes Claude Code's subscription path read the request as a
 *  third-party app. */
export const PI_PREAMBLE = "You are an expert coding assistant operating inside pi";

/** Both doc paths from pi's documentation-routing line. Anthropic's subscription
 *  gate rejects a system prompt carrying both, while either alone passes. */
export const ANTHROPIC_THIRD_PARTY_TRIGGERS = ["docs/custom-provider.md", "docs/packages.md"] as const;

/** One piece of the projected prompt, labelled so a refusal can name where the
 *  offending text was found. */
export interface SendablePromptPart {
  readonly label: string;
  readonly text: string;
}

export interface PromptProjectionContext {
  /** Bridge boundary that recorded the capture (before_agent_start | agent_start | turn_start). */
  readonly source?: string;
  /** Number of inherited captures substituted into this projection. */
  readonly inheritedCaptures?: number;
}

/**
 * Throws a taxonomy-classified error naming every unsendable part. Returns
 * silently when the whole projection is sendable.
 */
export function assertSendablePrompt(
  parts: readonly SendablePromptPart[],
  context: PromptProjectionContext = {},
): void {
  const findings: string[] = [];
  for (const { label, text } of parts) {
    const offset = preambleAtLineStart(text);
    if (offset !== -1) {
      findings.push(`pi's preamble ("${PI_PREAMBLE}") in ${label}, at offset ${offset} of ${text.length} chars`);
    }
    // The pair has to co-occur in one part; the two phrases split across parts are not detected.
    if (ANTHROPIC_THIRD_PARTY_TRIGGERS.every((trigger) => text.includes(trigger))) {
      findings.push(`${ANTHROPIC_THIRD_PARTY_TRIGGERS.join(" and ")} in ${label}`);
    }
  }
  if (findings.length === 0) return;

  throw bridgeError(
    "stream",
    "CB_STREAM_UNSENDABLE_PROMPT",
    [
      "prompt-capture: refusing to send this prompt. Claude Code's Anthropic path reads a request",
      "  carrying pi's harness, or the phrase pair its subscription gate rejects, as a third-party",
      "  app: it fails with 400 or is billed as extra usage.",
      ...findings.map((finding) => `  Found: ${finding}.`),
      `  Capture: ${context.source ?? "unknown"}, ${context.inheritedCaptures ?? 0} inherited capture(s) substituted.`,
      "  If this is your own text, reword or remove it from the system prompt.",
    ].join("\n"),
    { details: { findings } },
  );
}

/**
 * Asserts the projection is sendable, then joins every part. Because the join is
 * built from the parts themselves, no instruction can be dropped in transit.
 */
export function projectSendablePrompt(
  parts: readonly SendablePromptPart[],
  context: PromptProjectionContext = {},
): string | undefined {
  assertSendablePrompt(parts, context);
  return parts.length > 0 ? parts.map((part) => part.text).join("\n\n") : undefined;
}

/** Offset of pi's preamble at the start of a line, or -1. A mid-line mention is
 *  someone describing pi's prompt, not pi's prompt itself. */
function preambleAtLineStart(text: string): number {
  for (
    let offset = text.indexOf(PI_PREAMBLE);
    offset !== -1;
    offset = text.indexOf(PI_PREAMBLE, offset + PI_PREAMBLE.length)
  ) {
    if (offset === 0 || text[offset - 1] === "\n") return offset;
  }
  return -1;
}

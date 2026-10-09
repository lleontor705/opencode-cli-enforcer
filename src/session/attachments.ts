/**
 * Claude Code `@file` attachment carry-over across a session rebuild
 * (REQ-CB-SESS-001/-002, design D4).
 *
 * Ported from pi-claude-bridge `src/attachments.ts`. Claude Code expands an
 * `@file` mention itself and records the expansion as a `type:"attachment"`
 * record in its own session JSONL; the bridge never sees it. Rebuilding a
 * session from host history would therefore drop the file while keeping the
 * prompt text that referred to it, silently removing context the model was
 * reasoning about. The ordinal mapping below re-attaches the expansion to the
 * same host prompt on the rebuilt side.
 *
 * The ordinal is the mapping key rather than the record index: a rebuild does
 * not reproduce the old record list one-for-one (`importMessages` splits a
 * message carrying tool results into two records, and Claude Code appends
 * records of its own), but the sequence of user prompts is the same
 * conversation either way.
 */

import type { ImportAttachment, JsonlRecord } from "cc-session-io";

// Only `@file` expansions are carried: they are the one thing the bridge
// genuinely never sees. `edited_text_file` is excluded even though it also
// carries file content — Claude Code writes one after editing a file, the edit
// is already in host history as a tool call and result, and those records
// usually parent to a tool result, which has no position in the ordinal scheme.
// Everything else Claude Code rewrites every turn (`skill_listing`,
// `task_reminder`, `mcp_instructions_delta`, …) and loses nothing.
const CONTENT_BEARING = new Set(["file"]);

export interface CarriedAttachment {
  attachment: { type: string; [key: string]: unknown };
  /** Position of the parent among the session's text-bearing user records. */
  userOrdinal: number;
  /** That record's text, to verify the ordinal still points at the same turn. */
  parentText: string;
}

type Rec = Record<string, unknown>;

/**
 * Minimal text projection of a content field. The canonical host<->Anthropic
 * conversion is owned by src/stream/convert.ts (cb-08); the ordinal mapping
 * only needs the text form of a user prompt, so it keeps a local copy to stay
 * decoupled from a module this task does not own.
 */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  let hasText = false;
  for (const block of content as Rec[]) {
    if (block.type === "text" && block.text) {
      parts.push(String(block.text));
      hasText = true;
    } else if (block.type !== "text" && block.type !== "image") {
      parts.push(`[${String(block.type)}]`);
    }
  }
  return hasText ? parts.join("\n") : "";
}

/** A user record holding a prompt, as opposed to one holding tool results. */
function userPromptText(record: Rec): string | undefined {
  if (record.type !== "user") return undefined;
  const content = (record.message as Rec | undefined)?.content;
  if (Array.isArray(content) && content.some((b) => (b as Rec)?.type === "tool_result")) {
    return undefined;
  }
  const text = contentToText(content);
  return text ? text : undefined;
}

/**
 * Content-bearing attachments in a session, each tagged with where its parent
 * sits among the text-bearing user records.
 *
 * Attachments chain to one another — a run of them hangs off one prompt — so an
 * ordinal is resolved transitively up the parent links until it reaches a
 * prompt. Recorded for every attachment, not just the ones carried, since a
 * content-bearing one can chain off a listing the mapping ignores.
 */
export function collectCarriedAttachments(records: readonly JsonlRecord[]): CarriedAttachment[] {
  const ordinalOf = new Map<string, number>();
  const textOf = new Map<string, string>();
  let ordinal = 0;
  const carried: CarriedAttachment[] = [];

  for (const raw of records) {
    const record = raw as Rec;
    const prompt = userPromptText(record);
    if (prompt !== undefined) {
      ordinalOf.set(String(record.uuid), ordinal++);
      textOf.set(String(record.uuid), prompt);
      continue;
    }
    if (record.type !== "attachment") continue;
    const parent = record.parentUuid as string | null;
    if (parent === null || !ordinalOf.has(parent)) continue;
    const inherited = ordinalOf.get(parent)!;
    ordinalOf.set(String(record.uuid), inherited);
    textOf.set(String(record.uuid), textOf.get(parent)!);

    const attachment = record.attachment as { type: string; [key: string]: unknown } | undefined;
    if (!attachment || !CONTENT_BEARING.has(attachment.type)) continue;
    carried.push({ attachment, userOrdinal: inherited, parentText: textOf.get(parent)! });
  }
  return carried;
}

/**
 * Resolve each carried attachment to a position in the array about to be
 * imported — the messages *after* conversion and repair, since that is the
 * index space `importMessages` reads.
 *
 * Deliberately conservative: attaching a file to the wrong turn tells the model
 * it saw something at a point it did not, which is worse than the loss this
 * exists to prevent. So the ordinal has to land on a prompt whose text still
 * matches; any disagreement is reported and dropped rather than approximated.
 */
export function placeCarriedAttachments(
  carried: readonly CarriedAttachment[],
  messages: readonly { role: string; content: unknown }[],
): { attachments: ImportAttachment[]; skipped: string[] } {
  const prompts: { index: number; text: string }[] = [];
  messages.forEach((msg, index) => {
    if (msg.role !== "user") return;
    if (Array.isArray(msg.content) && msg.content.some((b) => (b as Rec)?.type === "tool_result")) {
      return;
    }
    const text = contentToText(msg.content);
    if (text) prompts.push({ index, text });
  });

  const attachments: ImportAttachment[] = [];
  const skipped: string[] = [];
  for (const item of carried) {
    const name = String(item.attachment.filename ?? item.attachment.type);
    const candidate = prompts[item.userOrdinal];
    if (!candidate) {
      skipped.push(`${name}: prompt #${item.userOrdinal} is no longer in history`);
      continue;
    }
    if (candidate.text !== item.parentText) {
      skipped.push(`${name}: prompt #${item.userOrdinal} changed`);
      continue;
    }
    attachments.push({ afterIndex: candidate.index, attachment: item.attachment });
  }
  return { attachments, skipped };
}

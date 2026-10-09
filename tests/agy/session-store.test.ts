/**
 * Deterministic oracle for the agy SessionStore seam (REQ-CB-AGY-001 session half,
 * design D4/D11).
 *
 * Proves, without touching any agy transport or provider storage:
 *  1. The opaque `{provider: "agy", conversationRef: <uuid>}` handle is captured from
 *     `init` and `result` stream events — in the real wire shape (`event.event`, id nested
 *     under `result`) and from the mapper's normalized session event — and from nothing else.
 *  2. Resume argv is exactly `--conversation <uuid>`; a missing handle means a new session.
 *  3. Serialization is versioned and round-trips the ref and provider.
 *  4. Every "cannot safely continue" input collapses to a documented clean-start, because
 *     agy has no REBUILD or force-rotate path.
 *  5. The module is structurally filesystem-free — it cannot read or write the provider's
 *     SQLite store because it imports no storage module and calls no fs API.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { BridgeError } from "../../src/errors/taxonomy.ts";
import type { SessionStore } from "../../src/provider/seams.ts";
import {
  AGY_HANDLE_VERSION,
  AGY_PROVIDER_ID,
  AGY_SESSION_CAPABILITIES,
  AgySessionStore,
} from "../../src/agy/session-store.ts";

const SEAM_STORE: SessionStore = new AgySessionStore();

function store(): AgySessionStore {
  return new AgySessionStore();
}

/**
 * The cb-26 recorded agy stream, read verbatim. These are the ground-truth frames the
 * production capture path must accept, so the oracles below feed them unchanged.
 */
const AGY_FIXTURE_FRAMES: readonly Record<string, unknown>[] = readFileSync(
  new URL("../fixtures/agy-streams/text-turn.jsonl", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as Record<string, unknown>);

const AGY_FIXTURE_CONVERSATION_ID = "0f6c2f0e-1b7a-4a1c-9d1e-2f3a4b5c6d7e";

function fixtureFrame(event: string): Record<string, unknown> {
  const frame = AGY_FIXTURE_FRAMES.find((candidate) => candidate.event === event);
  assert.ok(frame, `fixture must carry a "${event}" frame`);
  return frame;
}

describe("REQ-CB-AGY-001 agy SessionStore", () => {
  it("TestREQ_CB_AGY_001_captures_handle_from_init_event", () => {
    const handle = store().capture({
      event: "init",
      conversation_id: "conv-init-1",
      init: { tools: [], permission_mode: "request-review" },
    });
    assert.deepEqual(handle, { provider: "agy", conversationRef: "conv-init-1" });
  });

  it("TestREQ_CB_AGY_001_captures_handle_from_result_event", () => {
    const handle = store().capture({
      event: "result",
      result: { conversation_id: "conv-result-1", status: "SUCCESS" },
    });
    assert.deepEqual(handle, { provider: "agy", conversationRef: "conv-result-1" });
  });

  it("TestREQ_CB_AGY_001_capture_ignores_non_conversation_events", () => {
    const s = store();
    assert.equal(
      s.capture({ event: "step_update", step_update: { conversation_id: "x" } }),
      undefined,
    );
    assert.equal(s.capture({ event: "init" }), undefined);
    assert.equal(s.capture({ event: "init", conversation_id: "" }), undefined);
    assert.equal(s.capture({ event: "init", conversation_id: 42 }), undefined);
    assert.equal(s.capture({ event: "result", result: {} }), undefined);
    assert.equal(s.capture({ conversation_id: "orphan" }), undefined);
    assert.equal(s.capture({ kind: "text-delta", id: "t1", delta: "hi" }), undefined);
    assert.equal(s.capture(null), undefined);
    assert.equal(s.capture(undefined), undefined);
    assert.equal(s.capture("init"), undefined);
    assert.equal(s.capture([{ event: "init", conversation_id: "x" }]), undefined);
  });

  it("TestREQ_CB_AGY_001_capture_tolerates_normalized_session_event", () => {
    const handle = store().capture({ kind: "session", sessionId: "conv-normalized-9", tools: [] });
    assert.deepEqual(handle, { provider: "agy", conversationRef: "conv-normalized-9" });
  });

  it("TestREQ_CB_AGY_001_capture_tolerates_legacy_type_discriminator", () => {
    assert.deepEqual(store().capture({ type: "init", conversation_id: "legacy-1" }), {
      provider: "agy",
      conversationRef: "legacy-1",
    });
    assert.deepEqual(
      store().capture({ type: "result", result: { conversation_id: "legacy-2" } }),
      { provider: "agy", conversationRef: "legacy-2" },
    );
  });

  it("TestREQ_CB_AGY_001_captures_handle_from_verbatim_fixture_init_frame", () => {
    const initFrame = fixtureFrame("init");
    // Verbatim real wire: discriminator is `event`, id is top-level, no `type` key.
    assert.equal(initFrame.event, "init");
    assert.equal(initFrame.type, undefined);
    assert.equal(initFrame.conversation_id, AGY_FIXTURE_CONVERSATION_ID);

    assert.deepEqual(store().capture(initFrame), {
      provider: "agy",
      conversationRef: AGY_FIXTURE_CONVERSATION_ID,
    });
  });

  it("TestREQ_CB_AGY_001_captures_handle_from_verbatim_fixture_result_frame", () => {
    const resultFrame = fixtureFrame("result");
    const payload = resultFrame.result as Record<string, unknown>;
    // Real wire nests the id under `result`, not at the frame's top level.
    assert.equal(resultFrame.conversation_id, undefined);
    assert.equal(payload.conversation_id, AGY_FIXTURE_CONVERSATION_ID);

    assert.deepEqual(store().capture(resultFrame), {
      provider: "agy",
      conversationRef: AGY_FIXTURE_CONVERSATION_ID,
    });
  });

  it("TestREQ_CB_AGY_001_resume_args_emit_explicit_conversation_flag", () => {
    const handle = { provider: AGY_PROVIDER_ID, conversationRef: "conv-resume-7" };
    assert.deepEqual(store().resumeArgs(handle), ["--conversation", "conv-resume-7"]);
    assert.deepEqual(SEAM_STORE.resumeArgs(handle), ["--conversation", "conv-resume-7"]);
  });

  it("TestREQ_CB_AGY_001_missing_handle_means_new_session", () => {
    const s = store();
    assert.deepEqual(s.resumeArgs(null), []);
    assert.deepEqual(s.resumeArgs(undefined), []);

    const plan = s.planTurn({ handle: null });
    assert.equal(plan.transition, "clean-start");
    assert.equal(plan.handle, null);
    assert.deepEqual(plan.resumeArgs, []);
    assert.equal(plan.cause, "no-handle");
  });

  it("TestREQ_CB_AGY_001_serialize_deserialize_roundtrip_preserves_ref_and_provider", () => {
    const s = store();
    const handle = { provider: AGY_PROVIDER_ID, conversationRef: "conv-roundtrip-3" };

    const encoded = s.serialize(handle);
    assert.deepEqual(JSON.parse(encoded), {
      v: AGY_HANDLE_VERSION,
      provider: "agy",
      conversationRef: "conv-roundtrip-3",
    });

    const decoded = s.deserialize(encoded);
    assert.deepEqual(decoded, handle);
    assert.equal(decoded.provider, "agy");
    assert.equal(decoded.conversationRef, "conv-roundtrip-3");
    assert.deepEqual(s.deserialize(s.serialize(decoded)), decoded);
  });

  it("TestREQ_CB_AGY_001_deserialize_rejects_malformed_handles", () => {
    const s = store();
    const malformed = [
      "not json",
      "null",
      "{}",
      JSON.stringify({ provider: "agy", conversationRef: "x" }),
      JSON.stringify({ v: 99, provider: "agy", conversationRef: "x" }),
      JSON.stringify({ v: 1, provider: "claude", conversationRef: "x" }),
      JSON.stringify({ v: 1, provider: "agy", conversationRef: "" }),
      JSON.stringify({ v: 1, provider: "agy" }),
    ];

    for (const value of malformed) {
      assert.throws(
        () => s.deserialize(value),
        (error: unknown) =>
          error instanceof BridgeError && error.code === "CB_SESSION_MIRROR_INTEGRITY",
        `expected integrity error for ${value}`,
      );
    }
  });

  it("TestREQ_CB_AGY_001_serialize_rejects_foreign_handle", () => {
    assert.throws(
      () => store().serialize({ provider: "claude", conversationRef: "x" }),
      (error: unknown) =>
        error instanceof BridgeError && error.code === "CB_SESSION_MIRROR_DIVERGENCE",
    );
  });

  it("TestREQ_CB_AGY_001_clean_start_on_history_stale_drops_handle", () => {
    const handle = { provider: AGY_PROVIDER_ID, conversationRef: "conv-stale" };
    const plan = store().planTurn({ handle, historyStale: true });
    assert.equal(plan.transition, "clean-start");
    assert.equal(plan.handle, null);
    assert.deepEqual(plan.resumeArgs, []);
    assert.equal(plan.cause, "history-stale");
  });

  it("TestREQ_CB_AGY_001_clean_start_on_abort_replaces_force_rotate", () => {
    const handle = { provider: AGY_PROVIDER_ID, conversationRef: "conv-aborted" };
    const plan = store().planTurn({ handle, aborted: true });
    assert.equal(plan.transition, "clean-start");
    assert.equal(plan.handle, null);
    assert.equal(plan.cause, "aborted");
  });

  it("TestREQ_CB_AGY_001_clean_start_on_diverged_provider", () => {
    const plan = store().planTurn({ handle: { provider: "claude", conversationRef: "cc-1" } });
    assert.equal(plan.transition, "clean-start");
    assert.equal(plan.handle, null);
    assert.equal(plan.cause, "diverged-provider");
  });

  it("TestREQ_CB_AGY_001_reuse_plan_resumes_exact_conversation", () => {
    const handle = { provider: AGY_PROVIDER_ID, conversationRef: "conv-reuse" };
    const plan = store().planTurn({ handle });
    assert.equal(plan.transition, "reuse");
    assert.equal(plan.handle, handle);
    assert.deepEqual(plan.resumeArgs, ["--conversation", "conv-reuse"]);
    assert.equal(plan.cause, undefined);
  });

  it("TestREQ_CB_AGY_001_capability_flags_are_honest", () => {
    assert.equal(AGY_SESSION_CAPABILITIES.supportsReuse, true);
    assert.equal(AGY_SESSION_CAPABILITIES.supportsRebuild, false);
    assert.equal(AGY_SESSION_CAPABILITIES.supportsForceRotate, false);
    assert.deepEqual([...AGY_SESSION_CAPABILITIES.cleanStartCauses].sort(), [
      "aborted",
      "diverged-provider",
      "history-stale",
      "no-handle",
    ]);
  });

  it("TestREQ_CB_AGY_001_store_is_structurally_filesystem_free", () => {
    const source = readFileSync(new URL("../../src/agy/session-store.ts", import.meta.url), "utf8");

    const importSpecifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(
      [...new Set(importSpecifiers)].sort(),
      ["../errors/taxonomy.js", "../provider/seams.js"],
      "the store must depend on nothing but the seams and the error taxonomy",
    );

    const forbidden = [
      "node:fs",
      'from "fs"',
      "from 'fs'",
      "require(",
      "import(",
      "process.binding",
      "readFile",
      "writeFile",
      "openSync",
      "readdir",
      "statSync",
      "existsSync",
      "createReadStream",
      "better-sqlite3",
      "~/.gemini",
      ".db",
    ];
    for (const token of forbidden) {
      assert.ok(
        !source.includes(token),
        `agy SessionStore must never access provider storage; found "${token}"`,
      );
    }

    assert.match(source, /conversation_id/);
    assert.match(source, /"--conversation"|--conversation/);
    assert.match(source, /opaque/i);
  });
});

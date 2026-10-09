import test from "node:test";
import assert from "node:assert/strict";

import type { JsonlRecord } from "cc-session-io";

import {
  MirrorRegistry,
  decideMirrorTurn,
  syncMirror,
  type MirrorPersistence,
  type MirrorState,
  type MirrorWriteRequest,
} from "../../src/session/mirror.js";
import { collectCarriedAttachments, placeCarriedAttachments } from "../../src/session/attachments.js";

const user = (text: string): { role: string; content: string } => ({ role: "user", content: text });
const assistant = (text: string): { role: string; content: string } => ({
  role: "assistant",
  content: text,
});

const aligned: MirrorState = {
  ccSessionId: "cc-1",
  latestCursor: 2,
  needsRebuild: false,
  phase: "aligned",
};

interface PersistenceCalls {
  reads: string[];
  deletes: string[];
  writes: MirrorWriteRequest[];
}

function fakePersistence(
  calls: PersistenceCalls,
  outcome: { ccSessionId: string; recordCount?: number } = { ccSessionId: "cc-fresh" },
): MirrorPersistence {
  return {
    readCarriedAttachments: (ccSessionId) => {
      calls.reads.push(ccSessionId);
      return [];
    },
    deleteSession: (ccSessionId) => {
      calls.deletes.push(ccSessionId);
    },
    writeSession: (request) => {
      calls.writes.push(request);
      return { ccSessionId: outcome.ccSessionId, recordCount: outcome.recordCount ?? request.priorMessages.length };
    },
  };
}

test("TestREQ_CB_SESS_001_mirror_state_machine", async (t) => {
  await t.test("aligned mirror REUSEs with no rewrite", () => {
    const plan = decideMirrorTurn({
      priorMessages: [user("hi"), assistant("hello")],
      state: aligned,
      historyStale: false,
    });

    assert.equal(plan.transition, "reuse");
    assert.equal(plan.rewrite, false);
    assert.equal(plan.resumeSessionId, "cc-1");
    assert.equal(plan.preserveSessionId, false);
    assert.equal(plan.rotate, false);
    assert.equal(plan.cursor, 2);

    const registry = new MirrorRegistry();
    registry.set("s1", aligned);
    const calls: PersistenceCalls = { reads: [], deletes: [], writes: [] };
    const result = syncMirror(
      registry,
      { sessionId: "s1", cwd: "/work", priorMessages: [user("hi"), assistant("hello")] },
      fakePersistence(calls),
    );

    assert.equal(result.plan.transition, "reuse");
    assert.equal(result.sessionId, "cc-1");
    assert.deepEqual(calls.writes, []);
    assert.deepEqual(calls.deletes, []);
    assert.equal(registry.get("s1")?.latestCursor, 2);
    assert.equal(registry.get("s1")?.phase, "aligned");
  });

  await t.test("trailing assistant advances the cursor but still REUSEs", () => {
    const plan = decideMirrorTurn({
      priorMessages: [user("hi"), assistant("hello"), assistant("extra")],
      state: aligned,
      historyStale: false,
    });

    assert.equal(plan.transition, "reuse");
    assert.equal(plan.rewrite, false);
    assert.equal(plan.cursor, 3);
  });

  await t.test("host history rewrite marks needsRebuild per session, then REBUILDs", () => {
    const registry = new MirrorRegistry();
    registry.set("s1", aligned);
    registry.set(
      "s2",
      { ccSessionId: "cc-2", latestCursor: 2, needsRebuild: false, phase: "aligned" },
    );

    assert.equal(registry.markRebuildForSession("s1", "session.compacted"), true);
    // The mark is scoped to the rewriting session; s2's conversation is untouched.
    assert.equal(registry.get("s1")?.needsRebuild, true);
    assert.equal(registry.get("s1")?.phase, "rebuild-pending");
    assert.equal(registry.get("s2")?.needsRebuild, false);

    const plan = registry.planTurn("s1", {
      priorMessages: [user("hi"), assistant("hello"), user("again")],
      historyStale: false,
    });

    assert.equal(plan.transition, "rebuild");
    assert.equal(plan.rewrite, true);
    assert.equal(plan.preserveSessionId, true);
    assert.equal(plan.rotate, false);
    assert.equal(plan.resumeSessionId, "cc-1");
    assert.equal(plan.cursor, 3);

    const calls: PersistenceCalls = { reads: [], deletes: [], writes: [] };
    const result = syncMirror(
      registry,
      { sessionId: "s1", cwd: "/work", priorMessages: [user("hi"), assistant("hello"), user("again")] },
      fakePersistence(calls, { ccSessionId: "cc-1" }),
    );

    assert.equal(result.plan.transition, "rebuild");
    assert.equal(result.carried.length, 0);
    assert.equal(calls.reads.length, 1);
    assert.deepEqual(calls.deletes, ["cc-1"]);
    assert.equal(calls.writes.length, 1);
    assert.equal(calls.writes[0]?.resumeSessionId, "cc-1");
    assert.equal(calls.writes[0]?.rotate, false);
    // Full-file rewrite keeps the id and re-aligns the cursor.
    assert.equal(result.state.ccSessionId, "cc-1");
    assert.equal(result.state.latestCursor, 3);
    assert.equal(result.state.needsRebuild, false);
    assert.equal(result.state.phase, "aligned");
  });

  await t.test("per-query historyStale forces REBUILD", () => {
    const plan = decideMirrorTurn({
      priorMessages: [user("hi"), assistant("hello")],
      state: aligned,
      historyStale: true,
    });

    assert.equal(plan.transition, "rebuild");
    assert.equal(plan.rewrite, true);
    assert.equal(plan.preserveSessionId, true);
  });

  await t.test("shorter-than-cursor context takes clean-start-preserve", () => {
    const plan = decideMirrorTurn({
      priorMessages: [user("only one")],
      state: { ccSessionId: "cc-9", latestCursor: 5, needsRebuild: false, phase: "aligned" },
      historyStale: false,
    });

    assert.equal(plan.transition, "clean-start-preserve");
    assert.equal(plan.rewrite, true);
    assert.equal(plan.preserveSessionId, true);
    assert.equal(plan.resumeSessionId, "cc-9");
  });

  await t.test("first turn with no prior messages is a clean start", () => {
    const plan = decideMirrorTurn({ priorMessages: [], state: null, historyStale: false });

    assert.equal(plan.transition, "clean-start");
    assert.equal(plan.resumeSessionId, null);
    assert.equal(plan.rewrite, false);
    assert.equal(plan.nextPhase, "empty");
  });

  await t.test("aborted query quarantines and force-rotates on the next turn", () => {
    const registry = new MirrorRegistry();
    registry.set("s1", aligned);

    assert.equal(registry.markAborted("s1"), true);
    assert.equal(registry.get("s1")?.phase, "quarantined");
    assert.equal(registry.get("s1")?.needsRebuild, true);

    const plan = registry.planTurn("s1", {
      priorMessages: [user("hi"), assistant("hello"), user("more")],
      historyStale: false,
    });

    assert.equal(plan.transition, "force-rotate");
    assert.equal(plan.rewrite, true);
    assert.equal(plan.rotate, true);
    assert.equal(plan.preserveSessionId, false);
    assert.equal(plan.resumeSessionId, null);

    const calls: PersistenceCalls = { reads: [], deletes: [], writes: [] };
    const result = syncMirror(
      registry,
      { sessionId: "s1", cwd: "/work", priorMessages: [user("hi"), assistant("hello"), user("more")] },
      fakePersistence(calls, { ccSessionId: "cc-fresh" }),
    );

    // Rotate, do NOT delete: the orphan writer must flush into a dead inode.
    assert.deepEqual(calls.deletes, []);
    assert.equal(calls.writes.length, 1);
    assert.equal(calls.writes[0]?.rotate, true);
    assert.equal(calls.writes[0]?.resumeSessionId, null);
    assert.equal(result.sessionId, "cc-fresh");
    assert.equal(result.state.ccSessionId, "cc-fresh");
    assert.equal(result.state.phase, "aligned");
    assert.equal(result.state.needsRebuild, false);
  });
});

function attachmentRecords(): JsonlRecord[] {
  return [
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      message: { role: "user", content: "explain @a.ts and @b.ts" },
    },
    { type: "attachment", uuid: "a1", parentUuid: "u1", attachment: { type: "file", filename: "a.ts" } },
    { type: "attachment", uuid: "a2", parentUuid: "a1", attachment: { type: "file", filename: "b.ts" } },
    { type: "assistant", uuid: "as1", parentUuid: "a2" },
    {
      type: "user",
      uuid: "u2",
      parentUuid: "as1",
      message: { role: "user", content: "now @c.ts" },
    },
  ] as unknown as JsonlRecord[];
}

/** The same conversation rebuilt with fresh record uuids, as a rewrite produces. */
function rebuiltAttachmentRecords(): JsonlRecord[] {
  return [
    {
      type: "user",
      uuid: "r1",
      parentUuid: null,
      message: { role: "user", content: "explain @a.ts and @b.ts" },
    },
    { type: "attachment", uuid: "ra1", parentUuid: "r1", attachment: { type: "file", filename: "a.ts" } },
    { type: "attachment", uuid: "ra2", parentUuid: "ra1", attachment: { type: "file", filename: "b.ts" } },
    { type: "assistant", uuid: "ras1", parentUuid: "ra2" },
    {
      type: "user",
      uuid: "r2",
      parentUuid: "ras1",
      message: { role: "user", content: "now @c.ts" },
    },
  ] as unknown as JsonlRecord[];
}

test("TestREQ_CB_SESS_001_attachment_ordinals_are_stable_across_turns", () => {
  const first = collectCarriedAttachments(attachmentRecords());
  assert.deepEqual(
    first.map((item) => [item.attachment.filename, item.userOrdinal, item.parentText]),
    [
      ["a.ts", 0, "explain @a.ts and @b.ts"],
      ["b.ts", 0, "explain @a.ts and @b.ts"],
    ],
  );

  const second = collectCarriedAttachments(rebuiltAttachmentRecords());
  assert.deepEqual(
    second.map((item) => [item.attachment.filename, item.userOrdinal, item.parentText]),
    first.map((item) => [item.attachment.filename, item.userOrdinal, item.parentText]),
  );

  const messages = [
    user("explain @a.ts and @b.ts"),
    assistant("both files"),
    user("now @c.ts"),
  ];

  const placedFirst = placeCarriedAttachments(first, messages);
  const placedSecond = placeCarriedAttachments(second, messages);
  assert.deepEqual(placedFirst.skipped, []);
  assert.deepEqual(
    placedFirst.attachments.map((item) => [item.afterIndex, item.attachment.filename]),
    [
      [0, "a.ts"],
      [0, "b.ts"],
    ],
  );
  // Reproducible across turns: the same ordinals resolve to the same positions.
  assert.deepEqual(
    placedSecond.attachments.map((item) => [item.afterIndex, item.attachment.filename]),
    placedFirst.attachments.map((item) => [item.afterIndex, item.attachment.filename]),
  );

  // A prompt whose text changed is dropped rather than misplaced.
  const shifted = placeCarriedAttachments(first, [
    user("completely different opening"),
    assistant("both files"),
    user("now @c.ts"),
  ]);
  assert.equal(shifted.attachments.length, 0);
  assert.equal(shifted.skipped.length, 2);
});

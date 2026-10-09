import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession, openSession, serializeRecord } from "cc-session-io";

import { createMirrorPersistence } from "../../src/session/io.js";
import {
  SessionIntegrityError,
  assertSessionIntegrity,
  verifyWrittenSession,
} from "../../src/session/verify.js";
import { collectCarriedAttachments } from "../../src/session/attachments.js";
import { MirrorRegistry, syncMirror } from "../../src/session/mirror.js";

const user = (content: string): { role: string; content: string } => ({ role: "user", content });
const assistant = (text: string): { role: string; content: { type: string; text: string }[] } => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function nonEmptyLines(content: string): string[] {
  return content.split("\n").filter((line) => line.trim().length > 0);
}

test("TestREQ_CB_SESS_002_jsonl_integrity_attachments", async (t) => {
  await t.test("a preserved-id rewrite verifies sessionId and line content", () => {
    const root = tempDir("cb10-root-");
    const cwd = tempDir("cb10-cwd-");
    t.after(() => {
      rmSync(root, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    });

    const persistence = createMirrorPersistence({ claudeDir: root });
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const outcome = persistence.writeSession({
      sessionId: "opencode-s1",
      cwd,
      priorMessages: [user("first"), assistant("reply"), user("second")],
      resumeSessionId: sessionId,
      rotate: false,
      carried: [],
    });

    assert.equal(outcome.ccSessionId, sessionId);
    assert.equal(outcome.recordCount, 3);

    const reread = openSession({ sessionId, projectPath: cwd, claudeDir: root });
    assert.ok(existsSync(reread.jsonlPath));

    const lines = nonEmptyLines(readFileSync(reread.jsonlPath, "utf8"));
    // Line-by-line: the re-read file is exactly what the write serialized.
    assert.deepEqual(lines, reread.records.map(serializeRecord));
    assert.equal(JSON.parse(lines[0]!).sessionId, sessionId);
    assert.equal(JSON.parse(lines[2]!).sessionId, sessionId);

    assert.deepEqual(
      verifyWrittenSession({
        jsonlPath: reread.jsonlPath,
        expectedSessionId: sessionId,
        expectedLines: reread.records.map(serializeRecord),
      }),
      [],
    );
  });

  await t.test("a post-write mismatch fails closed", () => {
    const root = tempDir("cb10-root-");
    const cwd = tempDir("cb10-cwd-");
    t.after(() => {
      rmSync(root, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    });

    const persistence = createMirrorPersistence({ claudeDir: root });
    const sessionId = "33333333-3333-4333-8333-333333333333";
    persistence.writeSession({
      sessionId: "opencode-s2",
      cwd,
      priorMessages: [user("first"), assistant("reply")],
      resumeSessionId: sessionId,
      rotate: false,
      carried: [],
    });

    const reread = openSession({ sessionId, projectPath: cwd, claudeDir: root });
    const expected = {
      jsonlPath: reread.jsonlPath,
      expectedSessionId: sessionId,
      expectedLines: reread.records.map(serializeRecord),
    };

    // A late/foreign record the write never intended lands in the file: the
    // record count alone exposes it.
    const original = readFileSync(reread.jsonlPath, "utf8");
    writeFileSync(reread.jsonlPath, `${original}{"type":"user","sessionId":"other"}\n`, "utf8");

    const countWarnings = verifyWrittenSession(expected);
    assert.ok(
      countWarnings.some((warning) => warning.includes("record count mismatch")),
      countWarnings.join("; "),
    );
    assert.throws(() => assertSessionIntegrity(expected), SessionIntegrityError);

    // A same-length tamper the count cannot catch is exposed line by line.
    const lines = nonEmptyLines(original);
    lines[1] = JSON.stringify({ ...JSON.parse(lines[1]!), timestamp: "tampered" });
    writeFileSync(reread.jsonlPath, `${lines.join("\n")}\n`, "utf8");

    const lineWarnings = verifyWrittenSession(expected);
    assert.ok(
      lineWarnings.some((warning) => warning.includes("line 1 mismatch")),
      lineWarnings.join("; "),
    );
    assert.throws(() => assertSessionIntegrity(expected), SessionIntegrityError);
  });

  await t.test("an integrity failure aborts the mirror write", () => {
    const root = tempDir("cb10-root-");
    const cwd = tempDir("cb10-cwd-");
    t.after(() => {
      rmSync(root, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    });

    const sessionId = "44444444-4444-4444-8444-444444444444";
    const failing = createMirrorPersistence({
      claudeDir: root,
      integrityGate: () => {
        throw new SessionIntegrityError(["forced mismatch"]);
      },
    });

    assert.throws(
      () =>
        failing.writeSession({
          sessionId: "opencode-s3",
          cwd,
          priorMessages: [user("first"), assistant("reply")],
          resumeSessionId: sessionId,
          rotate: false,
          carried: [],
        }),
      SessionIntegrityError,
    );

    // The turn aborts: a rewrite whose verification fails never commits state.
    const registry = new MirrorRegistry();
    registry.set("s3", {
      ccSessionId: sessionId,
      latestCursor: 2,
      needsRebuild: false,
      phase: "aligned",
    });
    registry.markRebuildForSession("s3", "session.compacted");
    assert.throws(
      () =>
        syncMirror(
          registry,
          { sessionId: "s3", cwd, priorMessages: [user("first"), assistant("reply"), user("third")] },
          failing,
        ),
      SessionIntegrityError,
    );
  });

  await t.test("CLAUDE_CONFIG_DIR relocates the projects root", () => {
    const root = tempDir("cb10-env-");
    const cwd = tempDir("cb10-cwd-");
    t.after(() => {
      rmSync(root, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    });

    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = root;
    try {
      const persistence = createMirrorPersistence();
      const sessionId = "55555555-5555-4555-8555-555555555555";
      const outcome = persistence.writeSession({
        sessionId: "opencode-s5",
        cwd,
        priorMessages: [user("first"), assistant("reply")],
        resumeSessionId: sessionId,
        rotate: false,
        carried: [],
      });

      const reread = openSession({ sessionId: outcome.ccSessionId, projectPath: cwd, claudeDir: root });
      assert.ok(reread.jsonlPath.startsWith(root), reread.jsonlPath);
      assert.ok(existsSync(reread.jsonlPath));
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  await t.test("carried @file attachments keep their ordinals across a rewrite", () => {
    const root = tempDir("cb10-root-");
    const cwd = tempDir("cb10-cwd-");
    t.after(() => {
      rmSync(root, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    });

    const priorId = "66666666-6666-4666-8666-666666666666";
    const prior = createSession({ projectPath: cwd, claudeDir: root, sessionId: priorId });
    const prompt = prior.addUserMessage("explain @a.ts and @b.ts");
    const firstAttachment = prior.addAttachment(
      { type: "file", filename: "a.ts" },
      { parentUuid: prompt },
    );
    prior.addAttachment({ type: "file", filename: "b.ts" }, { parentUuid: firstAttachment });
    prior.addAssistantMessage([{ type: "text", text: "both files" }]);
    prior.addUserMessage("now @c.ts");
    prior.save();

    const persistence = createMirrorPersistence({ claudeDir: root });
    const carried = persistence.readCarriedAttachments(priorId, cwd);
    const projection = carried.map((item) => [
      item.attachment.filename,
      item.userOrdinal,
      item.parentText,
    ]);
    assert.deepEqual(projection, [
      ["a.ts", 0, "explain @a.ts and @b.ts"],
      ["b.ts", 0, "explain @a.ts and @b.ts"],
    ]);

    const outcome = persistence.writeSession({
      sessionId: "opencode-s6",
      cwd,
      priorMessages: [
        user("explain @a.ts and @b.ts"),
        assistant("both files"),
        user("now @c.ts"),
      ],
      resumeSessionId: priorId,
      rotate: false,
      carried,
    });
    assert.equal(outcome.ccSessionId, priorId);

    const reread = openSession({ sessionId: priorId, projectPath: cwd, claudeDir: root });
    const attachmentNames = reread.records
      .map((record) => record as { type?: string; attachment?: { type?: string; filename?: string } })
      .filter((record) => record.type === "attachment" && record.attachment?.type === "file")
      .map((record) => record.attachment?.filename);
    assert.deepEqual(attachmentNames, ["a.ts", "b.ts"]);

    // Reproducible across turns: the rebuilt file re-projects to the same ordinals.
    assert.deepEqual(
      collectCarriedAttachments(reread.records).map((item) => [
        item.attachment.filename,
        item.userOrdinal,
        item.parentText,
      ]),
      projection,
    );

    assert.deepEqual(
      verifyWrittenSession({
        jsonlPath: reread.jsonlPath,
        expectedSessionId: priorId,
        expectedLines: reread.records.map(serializeRecord),
      }),
      [],
    );
  });
});

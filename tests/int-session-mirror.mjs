/**
 * Session-mirror integration oracle (cb-17, spec pins
 * cortex:opencode-cli-enforcer#589/#592/#595/#600; REQ-CB-SESS-001/002).
 *
 * Two tiers:
 *
 * 1. On-disk tier (always runs): the mirror decision layer is driven through
 *    the *real* cc-session-io persistence seam with a temporary
 *    `CLAUDE_CONFIG_DIR`, so REUSE / REBUILD / forceRotate and the fail-closed
 *    integrity gate in `src/session/verify.ts` are proven against actual JSONL
 *    files rather than a fake store.
 * 2. Real-CLI tier (`CLAUDE_BRIDGE_INTEGRATION=1` + a working `claude`): a
 *    synthesized mirror is resumed by the real child, and the cb-16 live
 *    recording path (`tests/lib/record-sdk-streams.mjs`) is validated end to
 *    end. Absent the flag or binary the tier skips and names the operator
 *    action; the on-disk tier still runs.
 *
 * Oracles are deadline-bounded and use synthetic prompts only — no real user
 * conversation is ever recorded.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openSession, serializeRecord } from "cc-session-io";

import { createMirrorPersistence } from "../src/session/io.js";
import { MirrorRegistry, syncMirror } from "../src/session/mirror.js";
import {
  SessionIntegrityError,
  assertSessionIntegrity,
  verifyWrittenSession,
} from "../src/session/verify.js";

// ---------------------------------------------------------------------------
// Environment gate.
// ---------------------------------------------------------------------------

function commandPath(command) {
  const probe = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout.trim().length > 0 ? probe.stdout.trim() : null;
}

function commandVersion(path) {
  if (path === null) return null;
  const probe = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 10_000 });
  return probe.status === 0 ? probe.stdout.trim() : null;
}

const CLAUDE_PATH = commandPath("claude");
const CLAUDE_VERSION = commandVersion(CLAUDE_PATH);
const INTEGRATION_ENABLED = process.env.CLAUDE_BRIDGE_INTEGRATION === "1";
const REAL_CLI = INTEGRATION_ENABLED && CLAUDE_PATH !== null && CLAUDE_VERSION !== null;

const SKIP_REAL = REAL_CLI
  ? false
  : `claude CLI unavailable (CLAUDE_BRIDGE_INTEGRATION=${process.env.CLAUDE_BRIDGE_INTEGRATION ?? "unset"}, ` +
    `claude=${CLAUDE_PATH ?? "absent"}, version=${CLAUDE_VERSION ?? "n/a"}) — operator action: install a working, ` +
    `authenticated claude CLI and re-run with CLAUDE_BRIDGE_INTEGRATION=1`;

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const user = (content) => ({ role: "user", content });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

function nonEmptyLines(content) {
  return content.split("\n").filter((line) => line.trim().length > 0);
}

function verificationOf(session) {
  return {
    jsonlPath: session.jsonlPath,
    expectedSessionId: session.sessionId,
    expectedLines: session.records.map(serializeRecord),
  };
}

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Run `fn(root)` with CLAUDE_CONFIG_DIR pointed at a throwaway directory. */
async function withTempClaudeDir(fn) {
  const root = tempDir("cb-int-claude-");
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    return await fn(root);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

async function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`oracle deadline exceeded (${ms}ms): ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function cliUnusable(result) {
  if (!result || result.type !== "result") return "the claude CLI produced no result frame";
  const message = String(result.result ?? "");
  if (result.is_error && /login|log in|authenticat|api key|credential|unauthor|401|403|oauth|subscription/i.test(message)) {
    return message;
  }
  return null;
}

// ---------------------------------------------------------------------------
// On-disk tier.
// ---------------------------------------------------------------------------

test("TestREQ_CB_SESS_001_int_session_mirror_reuse_across_turns", async () => {
  await withTempClaudeDir(async (root) => {
    const cwd = tempDir("cb-int-cwd-");
    try {
      const persistence = createMirrorPersistence();
      const registry = new MirrorRegistry();
      const sid = "opencode-int-reuse";

      const first = syncMirror(
        registry,
        { sessionId: sid, cwd, priorMessages: [user("hi"), assistant("REPLY-1")] },
        persistence,
      );
      assert.equal(first.state.phase, "aligned");
      assert.ok(first.sessionId, "a first write must mint a concrete CC session id");
      const ccId = first.sessionId;

      const session = openSession({ sessionId: ccId, projectPath: cwd, claudeDir: root });
      assert.ok(session.jsonlPath.startsWith(root), "CLAUDE_CONFIG_DIR must relocate the projects root");
      assert.deepEqual(verifyWrittenSession(verificationOf(session)), []);
      const before = readFileSync(session.jsonlPath, "utf8");

      // Growth of a single trailing assistant message is content CC itself wrote,
      // so the next turn continues the same session instead of rewriting it.
      const reuse = syncMirror(
        registry,
        {
          sessionId: sid,
          cwd,
          priorMessages: [user("hi"), assistant("REPLY-1"), assistant("REPLY-2-CC-WROTE")],
        },
        persistence,
      );

      assert.equal(reuse.plan.transition, "reuse");
      assert.equal(reuse.plan.rewrite, false);
      assert.equal(reuse.sessionId, ccId, "reuse must return the cached CC session id");
      assert.equal(reuse.recordCount, 0);
      assert.equal(
        readFileSync(session.jsonlPath, "utf8"),
        before,
        "a reuse must not touch the on-disk session file",
      );
      assert.equal(registry.get(sid)?.phase, "aligned");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("TestREQ_CB_SESS_001_int_session_mirror_rebuild_after_history_rewrite", async () => {
  await withTempClaudeDir(async (root) => {
    const cwd = tempDir("cb-int-cwd-");
    try {
      const persistence = createMirrorPersistence();
      const registry = new MirrorRegistry();
      const sid = "opencode-int-rebuild";

      const first = syncMirror(
        registry,
        { sessionId: sid, cwd, priorMessages: [user("hi"), assistant("R1")] },
        persistence,
      );
      const ccId = first.sessionId;

      assert.equal(registry.markRebuildForSession(sid, "session.compacted"), true);
      assert.equal(registry.get(sid)?.phase, "rebuild-pending");

      const rebuild = syncMirror(
        registry,
        {
          sessionId: sid,
          cwd,
          priorMessages: [user("hi"), assistant("R1"), user("rewritten")],
        },
        persistence,
      );
      assert.equal(rebuild.plan.transition, "rebuild");
      assert.equal(rebuild.plan.preserveSessionId, true);
      assert.equal(rebuild.plan.rotate, false);
      assert.equal(rebuild.sessionId, ccId, "a rebuild must preserve the CC session id");
      assert.equal(rebuild.recordCount, 3);

      const session = openSession({ sessionId: ccId, projectPath: cwd, claudeDir: root });
      assert.equal(session.records.length, 3);
      assert.deepEqual(verifyWrittenSession(verificationOf(session)), []);

      const reuse = syncMirror(
        registry,
        {
          sessionId: sid,
          cwd,
          priorMessages: [user("hi"), assistant("R1"), user("rewritten"), assistant("R2")],
        },
        persistence,
      );
      assert.equal(reuse.plan.transition, "reuse", "the rebuilt file must serve the next turn");
      assert.equal(reuse.sessionId, ccId);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("TestREQ_CB_SESS_001_int_session_mirror_force_rotate_after_abort", async () => {
  await withTempClaudeDir(async (root) => {
    const cwd = tempDir("cb-int-cwd-");
    try {
      const persistence = createMirrorPersistence();
      const registry = new MirrorRegistry();
      const sid = "opencode-int-rotate";

      const first = syncMirror(
        registry,
        { sessionId: sid, cwd, priorMessages: [user("hi"), assistant("R1")] },
        persistence,
      );
      const ccId = first.sessionId;
      const orphan = openSession({ sessionId: ccId, projectPath: cwd, claudeDir: root });
      const orphanContent = readFileSync(orphan.jsonlPath, "utf8");

      assert.equal(registry.markAborted(sid), true);
      assert.equal(registry.get(sid)?.phase, "quarantined");

      const rotated = syncMirror(
        registry,
        {
          sessionId: sid,
          cwd,
          priorMessages: [user("hi"), assistant("R1"), user("after-abort")],
        },
        persistence,
      );

      assert.equal(rotated.plan.transition, "force-rotate");
      assert.equal(rotated.plan.rotate, true);
      assert.equal(rotated.plan.preserveSessionId, false);
      assert.notEqual(rotated.sessionId, ccId, "an abort must rotate to a fresh CC session id");
      assert.ok(existsSync(orphan.jsonlPath), "force-rotate must not delete the orphaned file");
      assert.equal(
        readFileSync(orphan.jsonlPath, "utf8"),
        orphanContent,
        "the killed writer's file must be left untouched",
      );

      const fresh = openSession({ sessionId: rotated.sessionId, projectPath: cwd, claudeDir: root });
      assert.deepEqual(verifyWrittenSession(verificationOf(fresh)), []);
      assert.equal(rotated.state.phase, "aligned");

      const reuse = syncMirror(
        registry,
        {
          sessionId: sid,
          cwd,
          priorMessages: [user("hi"), assistant("R1"), user("after-abort"), assistant("R2")],
        },
        persistence,
      );
      assert.equal(reuse.plan.transition, "reuse");
      assert.equal(reuse.sessionId, rotated.sessionId);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("TestREQ_CB_SESS_002_int_session_mirror_integrity_is_fail_closed", async () => {
  await withTempClaudeDir(async (root) => {
    const cwd = tempDir("cb-int-cwd-");
    try {
      const persistence = createMirrorPersistence();
      const registry = new MirrorRegistry();
      const written = syncMirror(
        registry,
        { sessionId: "opencode-int-integrity", cwd, priorMessages: [user("hi"), assistant("R1")] },
        persistence,
      );
      const session = openSession({ sessionId: written.sessionId, projectPath: cwd, claudeDir: root });
      const expected = verificationOf(session);
      assert.deepEqual(verifyWrittenSession(expected), []);

      const original = readFileSync(session.jsonlPath, "utf8");
      writeFileSync(session.jsonlPath, `${original}{"type":"user","sessionId":"foreign"}\n`, "utf8");

      assert.ok(
        verifyWrittenSession(expected).some((warning) => warning.includes("record count mismatch")),
        "a late foreign record must be detected",
      );
      assert.throws(() => assertSessionIntegrity(expected), SessionIntegrityError);

      // The persistence seam must not report a success it cannot re-read.
      const failing = createMirrorPersistence({
        integrityGate: () => {
          throw new SessionIntegrityError(["forced mismatch"]);
        },
      });
      assert.throws(
        () =>
          failing.writeSession({
            sessionId: "opencode-int-integrity-fail",
            cwd,
            priorMessages: [user("hi"), assistant("R1")],
            resumeSessionId: null,
            rotate: true,
            carried: [],
          }),
        SessionIntegrityError,
      );
      assert.deepEqual(nonEmptyLines(readFileSync(session.jsonlPath, "utf8")).length, 3);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Real-CLI tier.
// ---------------------------------------------------------------------------

test(
  "TestREQ_CB_SESS_002_int_session_mirror_real_cli_resume",
  { skip: SKIP_REAL },
  async (t) => {
    await withTempClaudeDir(async (root) => {
      const cwd = tempDir("cb-int-real-cwd-");
      try {
        const persistence = createMirrorPersistence();
        const registry = new MirrorRegistry();
        const sid = "opencode-int-real";
        const written = syncMirror(
          registry,
          {
            sessionId: sid,
            cwd,
            priorMessages: [user("Remember the passphrase ORCHID."), assistant("Understood.")],
          },
          persistence,
        );
        const ccId = written.sessionId;

        const { query } = await import("@anthropic-ai/claude-agent-sdk");
        const { buildChildEnv } = await import("../src/config/schema.ts");
        const frames = [];
        await withDeadline(
          (async () => {
            for await (const message of query({
              prompt: "What passphrase did I ask you to remember?",
              options: {
                cwd,
                env: buildChildEnv(process.env),
                tools: [],
                permissionMode: "bypassPermissions",
                allowDangerouslySkipPermissions: true,
                strictMcpConfig: true,
                resume: ccId,
              },
            })) {
              frames.push(message);
            }
          })(),
          120_000,
          "real resume turn",
        );

        const result = frames.find((message) => message.type === "result");
        const unusable = cliUnusable(result);
        if (unusable !== null) {
          t.skip(`claude CLI present but not usable: ${unusable}`);
          return;
        }

        assert.equal(result.is_error, false);
        assert.equal(result.session_id, ccId, "resume must continue the mirrored session id");

        const after = openSession({ sessionId: ccId, projectPath: cwd, claudeDir: root });
        for (const record of after.records) {
          assert.equal(record.sessionId, ccId, "the resumed session must keep a single session id");
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  },
);

test(
  "TestREQ_CB_STRM_001_int_session_mirror_records_a_live_sdk_stream",
  { skip: SKIP_REAL },
  async () => {
    const dir = tempDir("cb-int-record-");
    const workdir = join(dir, "workdir");
    mkdirSync(workdir, { recursive: true });
    try {
      const { recordScenario } = await import("./lib/record-sdk-streams.mjs");
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const result = await withDeadline(
        recordScenario({
          name: "live-probe",
          prompt: "Reply with exactly the word GAMMA and nothing else.",
          queryImpl: query,
          fixturesDir: dir,
          workdir,
        }),
        120_000,
        "live recording",
      );

      assert.ok(result.count > 0, "a live recording must capture frames");
      assert.ok(
        result.messages.some((frame) => frame.type === "result"),
        "a live recording must carry a result frame",
      );
      assert.ok(!result.body.includes(workdir), "the scratch workdir must not survive scrubbing");
      assert.equal(typeof result.header?.recordedAt, "string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

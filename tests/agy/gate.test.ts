/**
 * Deterministic gate oracle for REQ-CB-AGY-001 (gate half).
 *
 * Proves two things without touching any agy transport code:
 *  1. `src/config/schema.ts` enforces exactly the four agy constraint ids and
 *     refuses to enable `providers.agy` until every id is acknowledged.
 *  2. `docs/agy-tos-acknowledgment.md` exists and is the operator-facing gate:
 *     it names all four ids, links all five Google AI Developer Forum threads,
 *     and carries the acknowledgment checklist plus the decision record.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { AGY_CONSTRAINTS, ConfigError, resolveConfig } from "../../src/config/schema.ts";

const AGY_GATE_IDS = [
  "tos-third-party-access-ambiguity",
  "fatal-control-frames",
  "no-mid-turn-steer",
  "auto-allowed-workspace-writes",
] as const;

const FORUM_THREAD_IDS = ["185992", "186954", "185494", "186952", "187241"] as const;

const DOC_PATH = new URL("../../docs/agy-tos-acknowledgment.md", import.meta.url);

function readDoc(): string {
  const content = readFileSync(DOC_PATH, "utf8");
  assert.ok(content.length > 0, "acknowledgment document must not be empty");
  return content;
}

function captureGateError(options: unknown): ConfigError {
  try {
    resolveConfig(options);
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError, received ${String(error)}`);
    return error;
  }
  assert.fail("expected the agy acknowledgment gate to throw, but resolveConfig returned");
}

describe("REQ-CB-AGY-001 pre-implementation ToS gate", () => {
  it("TestREQ_CB_AGY_001_gate_register_matches_contract", () => {
    const registerIds = AGY_CONSTRAINTS.map((constraint) => constraint.id);
    assert.equal(registerIds.length, AGY_GATE_IDS.length);
    assert.deepEqual([...registerIds].sort(), [...AGY_GATE_IDS].sort());
  });

  it("TestREQ_CB_AGY_001_gate_throws_without_full_coverage", () => {
    const missing = captureGateError({ providers: { agy: { enabled: true } } });
    assert.match(missing.message, /providers\.agy\.acknowledgedConstraints/);
    for (const id of AGY_GATE_IDS) {
      assert.ok(missing.message.includes(id), `gate error must name missing "${id}"`);
    }

    const partial = captureGateError({
      providers: { agy: { enabled: true, acknowledgedConstraints: [AGY_GATE_IDS[0]] } },
    });
    assert.ok(!partial.message.includes(AGY_GATE_IDS[0]), "acknowledged id must not be reported missing");
    for (const id of AGY_GATE_IDS.slice(1)) {
      assert.ok(partial.message.includes(id), `expected missing "${id}" to be named`);
    }

    const unknown = captureGateError({
      providers: { agy: { enabled: true, acknowledgedConstraints: [...AGY_GATE_IDS, "made-up-constraint"] } },
    });
    assert.match(unknown.message, /made-up-constraint/);

    const acknowledged = resolveConfig({
      providers: {
        agy: {
          enabled: true,
          acknowledgedConstraints: [...AGY_GATE_IDS],
          dangerouslySkipPermissionsConsent: true,
        },
      },
    });
    assert.equal(acknowledged.providers.agy.enabled, true);
    assert.deepEqual(acknowledged.providers.agy.acknowledgedConstraints, [...AGY_GATE_IDS]);
  });

  it("TestREQ_CB_AGY_001_gate_document_names_all_constraints_and_threads", () => {
    const doc = readDoc();
    for (const id of AGY_GATE_IDS) {
      assert.ok(doc.includes(id), `acknowledgment doc must name constraint id "${id}"`);
    }
    for (const thread of FORUM_THREAD_IDS) {
      assert.ok(doc.includes(`/t/${thread}`), `acknowledgment doc must link forum thread "${thread}"`);
    }
  });

  it("TestREQ_CB_AGY_001_gate_document_has_checklist_and_decision_record", () => {
    const doc = readDoc();
    assert.match(doc, /operator acknowledgment checklist/i);
    assert.match(doc, /decision record/i);
    assert.ok(doc.includes("- [ ]"), "checklist must expose unchecked acknowledgment items");
  });
});

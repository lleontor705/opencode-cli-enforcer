import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AGY_CONSTRAINTS,
  CHILD_ENV_HYGIENE,
  CHILD_ENV_SCRUB_PREFIXES,
  CLAUDE_CONSTRAINTS,
  DEFAULT_PROVIDER,
  PROVIDER_CONSTRAINTS,
  PROVIDER_IDS,
  resolveConfig,
} from "../../src/config/schema.ts";

/**
 * Read the first existing candidate relative to this test file. The README is
 * tracked as `README.md`; on a case-insensitive filesystem the leased
 * `readme.md` path resolves to the same inode, so both spellings are accepted.
 */
function readDoc(...candidates: readonly string[]): string {
  for (const relative of candidates) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  throw new Error(`none of these files exist: ${candidates.join(", ")}`);
}

const README = readDoc("../../README.md", "../../readme.md");
const CONFIG_REFERENCE = readDoc("../../docs/config.md");

const CONSTRAINT_IDS = [
  ...CLAUDE_CONSTRAINTS.map((constraint) => constraint.id),
  ...AGY_CONSTRAINTS.map((constraint) => constraint.id),
];

// Derive the documented option keys from the schema's own resolved shape so the
// oracle breaks when a schema option is added without documenting it.
const RESOLVED_DEFAULTS = resolveConfig({});
const TOP_LEVEL_OPTION_KEYS = ["providers", "defaultProvider"] as const;
const PROVIDER_OPTION_KEYS = PROVIDER_IDS.flatMap((providerId) =>
  Object.keys(RESOLVED_DEFAULTS.providers[providerId]),
);

function assertContains(haystack: string, needle: string, source: string): void {
  assert.ok(
    haystack.includes(needle),
    `${source} must document "${needle}"`,
  );
}

function assertSection(readme: string, pattern: RegExp, label: string): void {
  assert.match(
    readme,
    pattern,
    `README.md must contain a ${label} section heading`,
  );
}

describe("REQ-CB-DOC-001 config reference coverage", () => {
  it("documents every provider constraint id in docs/config.md", () => {
    assert.ok(CONSTRAINT_IDS.length >= 6, "expected both provider registers to be non-empty");
    for (const id of CONSTRAINT_IDS) {
      assertContains(CONFIG_REFERENCE, id, "docs/config.md");
    }
  });

  it("documents every top-level and per-provider option key in docs/config.md", () => {
    for (const key of TOP_LEVEL_OPTION_KEYS) {
      assertContains(CONFIG_REFERENCE, key, "docs/config.md");
    }
    for (const providerId of PROVIDER_IDS) {
      assertContains(CONFIG_REFERENCE, providerId, "docs/config.md");
    }
    assert.ok(PROVIDER_OPTION_KEYS.length >= 8, "expected provider option keys from the schema");
    for (const key of PROVIDER_OPTION_KEYS) {
      assertContains(CONFIG_REFERENCE, key, "docs/config.md");
    }
  });

  it("documents the child-env hygiene constants, scrub prefixes, and default provider", () => {
    for (const [name, value] of Object.entries(CHILD_ENV_HYGIENE)) {
      assertContains(CONFIG_REFERENCE, name, "docs/config.md");
      assertContains(CONFIG_REFERENCE, value, "docs/config.md");
    }
    for (const prefix of CHILD_ENV_SCRUB_PREFIXES) {
      assertContains(CONFIG_REFERENCE, prefix, "docs/config.md");
    }
    assertContains(CONFIG_REFERENCE, DEFAULT_PROVIDER, "docs/config.md");
  });

  it("documents CLAUDE_CONFIG_DIR and env hygiene", () => {
    assertContains(CONFIG_REFERENCE, "CLAUDE_CONFIG_DIR", "docs/config.md");
    assert.match(CONFIG_REFERENCE, /ANTHROPIC_/, "docs/config.md must document ANTHROPIC_* hygiene");
    assert.match(CONFIG_REFERENCE, /hygiene/i, "docs/config.md must document env hygiene");
  });

  it("documents the config error code and acknowledgment gate error semantics", () => {
    assertContains(CONFIG_REFERENCE, "config/invalid-options", "docs/config.md");
    assert.match(CONFIG_REFERENCE, /acknowledg/i, "docs/config.md must document the ack gate");
    assert.match(
      CONFIG_REFERENCE,
      /fail[- ]closed/i,
      "docs/config.md must document fail-closed validation",
    );
  });
});

describe("REQ-CB-DOC-001 README coverage", () => {
  it("contains install, quick start, and acknowledgment-gate sections", () => {
    assertSection(README, /^#{1,6}\s.*install/im, "install");
    assertSection(README, /^#{1,6}\s.*quick\s+start/im, "quick start");
    assertSection(README, /^#{1,6}\s.*acknowledg/im, "acknowledgment gate");
  });

  it("names the Operator Actions section and the acknowledgment gate", () => {
    assertSection(README, /^#{1,6}\s.*operator actions/im, "Operator Actions");
    assert.match(README, /acknowledgment gate/i, "README.md must name the acknowledgment gate");
  });

  it("describes the seven seams, the parked query, and the session mirror", () => {
    for (const seam of [
      "CliTransport",
      "EventMapper",
      "SessionStore",
      "ToolChannel",
      "PermissionPolicy",
      "SteeringPolicy",
      "ProviderProbe",
    ]) {
      assertContains(README, seam, "README.md");
    }
    assert.match(README, /parked/i, "README.md must describe the parked query");
    assert.match(README, /mirror/i, "README.md must describe the session mirror");
  });

  it("documents the shipped agy provider in the capability matrix and operator actions", () => {
    assertSection(README, /^#{1,6}\s.*capability\s+matrix/im, "capability matrix");
    assertSection(README, /^#{1,6}\s.*operator actions/im, "Operator Actions");
    // The capability matrix must present agy as shipped, not as a future plan.
    assert.match(README, /\bagy\b[^\n]*shipped/i, "README.md must present the agy provider as shipped");
    assertContains(README, "tos-third-party-access-ambiguity", "README.md");
  });

  it("does not present a vacuous document", () => {
    assert.ok(README.length > 2000, "README.md looks empty or truncated");
    assert.ok(CONFIG_REFERENCE.length > 2000, "docs/config.md looks empty or truncated");
    // Guard against a register that silently shrank: every provider has constraints.
    for (const providerId of PROVIDER_IDS) {
      assert.ok(
        PROVIDER_CONSTRAINTS[providerId].length > 0,
        `provider ${providerId} must carry a constraint register`,
      );
    }
  });
});

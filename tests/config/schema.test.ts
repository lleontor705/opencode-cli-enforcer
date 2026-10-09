import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AGY_CONSTRAINTS,
  CLAUDE_CONSTRAINTS,
  ConfigError,
  DEFAULT_CONFIG,
  buildChildEnv,
  resolveConfig,
} from "../../src/config/schema.ts";

const claudeConstraintIds = CLAUDE_CONSTRAINTS.map((constraint) => constraint.id);
const agyConstraintIds = AGY_CONSTRAINTS.map((constraint) => constraint.id);

function captureError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError, received ${String(error)}`);
    return error;
  }
  assert.fail("expected resolveConfig to throw, but it returned");
}

describe("REQ-CB-CFG-001 config schema", () => {
  it("TestREQ_CB_CFG_001_schema_validates applies every documented default", () => {
    const resolved = resolveConfig({});

    assert.equal(resolved.providers.claude.enabled, true);
    assert.equal(resolved.providers.claude.modelOverride, null);
    assert.equal(resolved.providers.claude.debugLogs, false);
    assert.equal(resolved.providers.claude.toolsAllow, null);
    assert.deepEqual(resolved.providers.claude.acknowledgedConstraints, claudeConstraintIds);

    assert.equal(resolved.providers.agy.enabled, false);
    assert.equal(resolved.providers.agy.dangerouslySkipPermissionsConsent, false);
    assert.deepEqual(resolved.providers.agy.acknowledgedConstraints, []);

    assert.equal(resolved.defaultProvider, "claude");

    assert.deepEqual(resolved.childEnv.set, {
      ENABLE_CLAUDEAI_MCP_SERVERS: "0",
      DISABLE_AUTO_COMPACT: "1",
    });
    assert.deepEqual([...resolved.childEnv.scrubPrefixes], ["ANTHROPIC_"]);

    assert.deepEqual(resolved, DEFAULT_CONFIG);
  });

  it("TestREQ_CB_CFG_001_schema_validates consumes provided options with defaults left intact", () => {
    const resolved = resolveConfig({
      providers: {
        claude: {
          enabled: true,
          modelOverride: "claude-sonnet-4",
          debugLogs: true,
          toolsAllow: ["bash", "read"],
        },
        agy: { enabled: false },
      },
    });

    assert.equal(resolved.providers.claude.modelOverride, "claude-sonnet-4");
    assert.equal(resolved.providers.claude.debugLogs, true);
    assert.deepEqual(resolved.providers.claude.toolsAllow, ["bash", "read"]);
    assert.deepEqual(resolved.providers.claude.acknowledgedConstraints, claudeConstraintIds);
    assert.equal(resolved.defaultProvider, "claude");
  });

  it("TestREQ_CB_CFG_001_schema_validates rejects a wrong-typed option naming the offending key", () => {
    const error = captureError(() =>
      resolveConfig({ providers: { claude: { toolsAllow: "yes" } } }),
    );

    assert.equal(error.code, "config/invalid-options");
    assert.match(error.message, /providers\.claude\.toolsAllow/);
    assert.match(error.message, /string\[\]/);
  });

  it("TestREQ_CB_CFG_001_schema_validates names the key and applies nothing on any invalid option", () => {
    const cases: ReadonlyArray<[unknown, RegExp]> = [
      [{ providers: { claude: { enabled: "yes" } } }, /providers\.claude\.enabled/],
      [{ providers: { claude: { debugLogs: 1 } } }, /providers\.claude\.debugLogs/],
      [{ providers: { claude: { modelOverride: 42 } } }, /providers\.claude\.modelOverride/],
      [{ providers: { claude: { toolsAllow: ["bash", 7] } } }, /providers\.claude\.toolsAllow\[1\]/],
      [{ providers: { claude: { unknownOption: true } } }, /providers\.claude\.unknownOption/],
      [{ providers: { gemini: { enabled: true } } }, /providers\.gemini/],
      [{ providers: "claude" }, /providers/],
      [{ defaultProvider: "gemini" }, /defaultProvider/],
      [{ defaultProvider: "agy" }, /defaultProvider/],
      [{ unknownTopLevel: true }, /unknownTopLevel/],
    ];

    for (const [options, pattern] of cases) {
      const error = captureError(() => resolveConfig(options));
      assert.match(error.message, pattern, `expected ${error.message} to name ${pattern}`);
    }

    // Fail-closed with no partial application: the schema holds no mutable state.
    assert.deepEqual(resolveConfig({}), DEFAULT_CONFIG);
  });

  it("TestREQ_CB_CFG_001_schema_validates enforces the per-provider acknowledgment gate", () => {
    const agyError = captureError(() => resolveConfig({ providers: { agy: { enabled: true } } }));
    assert.match(agyError.message, /providers\.agy\.acknowledgedConstraints/);
    assert.match(agyError.message, /missing/);
    for (const id of agyConstraintIds) {
      assert.ok(
        agyError.message.includes(id),
        `ack gate error must name missing acknowledgment "${id}": ${agyError.message}`,
      );
    }

    const partialError = captureError(() =>
      resolveConfig({
        providers: { agy: { enabled: true, acknowledgedConstraints: [agyConstraintIds[0]] } },
      }),
    );
    assert.ok(!partialError.message.includes(agyConstraintIds[0]));
    for (const id of agyConstraintIds.slice(1)) {
      assert.ok(partialError.message.includes(id), `expected missing "${id}" to be named`);
    }

    const acknowledged = resolveConfig({
      providers: {
        agy: {
          enabled: true,
          acknowledgedConstraints: [...agyConstraintIds],
          dangerouslySkipPermissionsConsent: true,
        },
      },
      defaultProvider: "agy",
    });
    assert.equal(acknowledged.providers.agy.enabled, true);
    assert.equal(acknowledged.providers.agy.dangerouslySkipPermissionsConsent, true);
    assert.equal(acknowledged.defaultProvider, "agy");

    const claudeError = captureError(() =>
      resolveConfig({
        providers: { claude: { enabled: true, acknowledgedConstraints: [claudeConstraintIds[0]] } },
      }),
    );
    assert.match(claudeError.message, /providers\.claude\.acknowledgedConstraints/);
    assert.ok(claudeError.message.includes(claudeConstraintIds[1]));

    const unknownAckError = captureError(() =>
      resolveConfig({
        providers: {
          agy: { enabled: true, acknowledgedConstraints: [...agyConstraintIds, "made-up-constraint"] },
        },
      }),
    );
    assert.match(unknownAckError.message, /made-up-constraint/);
  });

  it("buildChildEnv applies hygiene constants and scrubs ANTHROPIC_* from the child env", () => {
    const childEnv = buildChildEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "secret",
      ANTHROPIC_BASE_URL: "https://example.invalid",
      ENABLE_CLAUDEAI_MCP_SERVERS: "1",
      DISABLE_AUTO_COMPACT: undefined,
      HOME: "/home/operator",
    });

    assert.deepEqual(childEnv, {
      PATH: "/usr/bin",
      HOME: "/home/operator",
      ENABLE_CLAUDEAI_MCP_SERVERS: "0",
      DISABLE_AUTO_COMPACT: "1",
    });
  });
});

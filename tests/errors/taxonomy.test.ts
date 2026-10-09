import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ANTHROPIC_THIRD_PARTY_TRIGGERS,
  PI_PREAMBLE,
  assertSendablePrompt,
  projectSendablePrompt,
  type SendablePromptPart,
} from "../../src/errors/assert-sendable-prompt.js";
import {
  BRIDGE_ERROR_CATEGORIES,
  BRIDGE_ERROR_CODES,
  BridgeError,
  bridgeError,
  categoryOfCode,
  classifyTransportError,
  codesForCategory,
  isBridgeErrorCategory,
  isBridgeErrorCode,
  isTransientTransportError,
  toBridgeError,
} from "../../src/errors/taxonomy.js";

test("TestREQ_CB_ERR_002_prompt_projection_fails_loud", () => {
  const preamblePart: SendablePromptPart = {
    label: "the custom prompt",
    text: `${PI_PREAMBLE}\nContinue the task.`,
  };
  assert.throws(
    () => assertSendablePrompt([{ label: "the project context block", text: "context" }, preamblePart], {
      source: "before_agent_start",
      inheritedCaptures: 1,
    }),
    (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.category, "stream");
      assert.equal(error.code, "CB_STREAM_UNSENDABLE_PROMPT");
      assert.ok(isBridgeErrorCode(error.code));
      // The refusal must name the offending part, never fail anonymously.
      assert.match(error.message, /the custom prompt/);
      assert.equal(error.retryable, false);
      return true;
    },
  );

  const pair: SendablePromptPart = {
    label: "the appended instructions",
    text: `${ANTHROPIC_THIRD_PARTY_TRIGGERS[0]} and ${ANTHROPIC_THIRD_PARTY_TRIGGERS[1]}`,
  };
  assert.throws(() => assertSendablePrompt([pair]), /the appended instructions/);

  // A clean projection is sendable and round-trips every part.
  const sendable: SendablePromptPart[] = [
    { label: "the project context block", text: "project context" },
    { label: "the appended instructions", text: `${ANTHROPIC_THIRD_PARTY_TRIGGERS[0]} only` },
    { label: "the custom prompt", text: "standing instructions" },
  ];
  assert.doesNotThrow(() => assertSendablePrompt(sendable));
  assert.equal(
    projectSendablePrompt(sendable),
    ["project context", `${ANTHROPIC_THIRD_PARTY_TRIGGERS[0]} only`, "standing instructions"].join("\n\n"),
  );
});

test("TestREQ_CB_ERR_002_closed_taxonomy_codes", () => {
  assert.deepEqual(
    [...BRIDGE_ERROR_CATEGORIES],
    ["config", "transport", "tool", "stream", "rate-limit", "session-mirror"],
  );

  for (const category of BRIDGE_ERROR_CATEGORIES) {
    assert.ok(isBridgeErrorCategory(category));
    const codes = codesForCategory(category);
    assert.ok(codes.length > 0);
    for (const code of codes) {
      assert.ok(isBridgeErrorCode(code));
      assert.equal(categoryOfCode(code as never), category);
      const error = bridgeError(category, code as never, "classified failure");
      assert.ok(error instanceof BridgeError);
      assert.equal(error.category, category);
      assert.equal(error.code, code);
      assert.ok(BRIDGE_ERROR_CATEGORIES.includes(error.category));
      assert.ok(isBridgeErrorCode(error.code));
    }
  }

  // Every closed set has a boundary: unknown codes and mismatched combinations fail loud.
  assert.equal(isBridgeErrorCode("CB_NOT_A_CODE"), false);
  assert.equal(isBridgeErrorCategory("telemetry"), false);
  assert.throws(() => bridgeError("config", "CB_TOOL_UNKNOWN" as never, "mismatch"), /does not belong to category/);
});

test("TestREQ_CB_ERR_002_transient_transport_is_retryable", () => {
  const transient = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  assert.equal(isTransientTransportError(transient), true);

  const classified = classifyTransportError(transient);
  assert.equal(classified.category, "transport");
  assert.equal(classified.code, "CB_TRANSPORT_TRANSIENT");
  assert.equal(classified.retryable, true);
  assert.equal(classified.cause, transient);

  const permanent = new Error("protobuf framing rejected");
  const permanentError = classifyTransportError(permanent);
  assert.equal(permanentError.category, "transport");
  assert.equal(permanentError.code, "CB_TRANSPORT_PROTOCOL");
  assert.equal(permanentError.retryable, false);

  // Classification is idempotent and already-classified errors pass through untouched.
  assert.equal(classifyTransportError(classified), classified);
  assert.equal(toBridgeError(classified, "tool", "CB_TOOL_UNKNOWN"), classified);
  const wrapped = toBridgeError(new Error("boom"), "tool", "CB_TOOL_UNKNOWN");
  assert.equal(wrapped.category, "tool");
  assert.equal(wrapped.code, "CB_TOOL_UNKNOWN");
});

/**
 * Import-guard oracle for the agy provider package shim
 * (REQ-CB-AGY-001, design D11/D12).
 *
 * OpenCode core imports `src/agy/provider-package.mjs` directly via its
 * `file://` URL, so the file must parse as plain JavaScript under both Bun and
 * Node (no TypeScript annotations, no imports). Nothing else in the repo
 * imports it, so this suite is the only regression net keeping TS syntax or a
 * dependency from creeping back in and aborting `loadSDKFactory`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as agyProviderPackage from "../src/agy/provider-package.mjs";

const DUMMY_SDK_MESSAGE =
  "agy: the dummy SDK's languageModel was invoked; the LanguageModelV3 adapter must be supplied by the aisdk language hook";

describe("agy provider-package.mjs", () => {
  it("imports cleanly and exports exactly createAgyProviderSdk", () => {
    assert.deepEqual(Object.keys(agyProviderPackage).sort(), ["createAgyProviderSdk"]);
  });

  it("factory returns an SDK object exposing a languageModel function", () => {
    const sdk = agyProviderPackage.createAgyProviderSdk({});
    assert.equal(typeof sdk.languageModel, "function");
  });

  it("languageModel throws the dummy-SDK guard message", () => {
    const sdk = agyProviderPackage.createAgyProviderSdk({});
    assert.throws(() => sdk.languageModel("gemini-3.8-flash"), {
      message: DUMMY_SDK_MESSAGE,
    });
  });
});

/**
 * Import-guard and catalog package oracle for the `claude` provider package shim
 * (REQ-CB-PROV-001).
 *
 * OpenCode v2 only enters `AISDK.language` (and therefore only invokes
 * `ctx.aisdk.hook("language", ...)`) when `Provider.Info.package` starts with
 * `aisdk:`. Built-in `opencode.provider.dynamic` imports the `file://` target
 * and invokes the first `create*` export before `runLanguage` overrides
 * `event.language` with the Claude `LanguageModelV3` adapter.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { claudeBridgeProviderInfo } from "../../src/provider/models.js";
import * as claudeProviderPackage from "../../src/provider/provider-package.mjs";

const DUMMY_SDK_MESSAGE =
  "claude: the dummy SDK's languageModel was invoked; the LanguageModelV3 adapter must be supplied by the aisdk language hook";

const EXPECTED_SHIM_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "provider",
  "provider-package.mjs",
);

describe("claude provider-package.mjs shim and provider info", () => {
  it("claudeBridgeProviderInfo().package uses aisdk:file:// pointing to src/provider/provider-package.mjs", () => {
    const info = claudeBridgeProviderInfo();
    assert.ok(
      info.package.startsWith("aisdk:file://"),
      `expected aisdk:file:// prefix, got ${info.package}`,
    );
    const specifier = info.package.slice("aisdk:".length);
    const resolvedPath = fileURLToPath(specifier);
    assert.equal(resolvedPath, EXPECTED_SHIM_PATH);
    assert.equal(existsSync(resolvedPath), true);
  });

  it("exports exactly createClaudeBridgeProviderSdk as the create* factory", async () => {
    const keys = Object.keys(claudeProviderPackage).sort();
    assert.deepEqual(keys, ["createClaudeBridgeProviderSdk"]);

    const specifier = claudeBridgeProviderInfo().package.slice("aisdk:".length);
    const loaded = (await import(specifier)) as Record<string, unknown>;
    const factoryName = Object.keys(loaded).find((key) => key.startsWith("create"));
    assert.equal(factoryName, "createClaudeBridgeProviderSdk");
    assert.equal(typeof loaded[factoryName!], "function");
  });

  it("dummy SDK languageModel throws the guard error if ever called directly", () => {
    const sdk = claudeProviderPackage.createClaudeBridgeProviderSdk({});
    assert.equal(typeof sdk.languageModel, "function");
    assert.throws(() => sdk.languageModel("claude-sonnet-5"), {
      message: DUMMY_SDK_MESSAGE,
    });
  });
});

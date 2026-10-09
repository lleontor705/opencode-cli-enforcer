import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Model, Provider } from "@opencode/plugin";

import {
  CLAUDE_BRIDGE_PROVIDER_ID,
  CLAUDE_CODE_MODELS,
  projectClaudeCodeModels,
  resolveClaudeCodeRuntimeModel,
  type LongContextSettings,
} from "../../src/provider/models.js";
import {
  LANGUAGE_MODEL_PENDING_CODE,
  getProviderCatalog,
  registerClaudeBridge,
  type ClaudeBridgeContext,
} from "../../src/provider/registration.js";
import { createProviderRegistry } from "../../src/provider/registry.js";

// ---------------------------------------------------------------------------
// Fake OpenCode v2 host: a persistent provider editor that re-runs registered
// transforms on reload (hot-reload semantics) and a providerID-scoped hook bus.
// ---------------------------------------------------------------------------

interface FakeEditorRecord {
  readonly provider: Provider.Info;
  readonly models: readonly Model.Info[];
}

class FakeProviderEditor {
  readonly records: FakeEditorRecord[] = [];

  get(providerID: string): FakeEditorRecord | undefined {
    return this.records.find((record) => record.provider.id === providerID);
  }

  list(): readonly FakeEditorRecord[] {
    return this.records;
  }

  add(input: { info: Provider.Info; models: readonly Model.Info[] }): void {
    this.records.push({ provider: input.info, models: input.models });
  }
}

interface LanguageHookInput {
  readonly model: Model.Info;
  readonly sdk: unknown;
  readonly options: Record<string, unknown>;
  language?: { readonly modelId: string; doStream(options: unknown): unknown } | undefined;
}

interface FakeHost {
  readonly editor: FakeProviderEditor;
  readonly ctx: ClaudeBridgeContext;
  readonly hooks: ReadonlyArray<{ name: string; options?: { providerID?: string } }>;
  readonly reload: () => Promise<void>;
  readonly fireLanguage: (input: LanguageHookInput, providerID: string) => void;
}

function createFakeHost(): FakeHost {
  const editor = new FakeProviderEditor();
  const transforms: Array<(target: FakeProviderEditor) => void> = [];
  const hooks: Array<{
    name: string;
    options?: { providerID?: string };
    callback: (input: LanguageHookInput) => void;
  }> = [];

  const ctx = {
    provider: {
      transform: async (callback: (target: FakeProviderEditor) => void) => {
        transforms.push(callback);
        return { dispose: async () => {} };
      },
    },
    aisdk: {
      hook: async (
        name: string,
        callback: (input: LanguageHookInput) => void,
        options?: { providerID?: string },
      ) => {
        hooks.push({ name, callback, options });
        return { dispose: async () => {} };
      },
    },
  } as unknown as ClaudeBridgeContext;

  return {
    editor,
    ctx,
    hooks,
    reload: async () => {
      for (const callback of transforms) callback(editor);
    },
    fireLanguage: (input, providerID) => {
      for (const hook of hooks.filter((candidate) => candidate.name === "language")) {
        const scope = hook.options?.providerID;
        if (scope === undefined || scope === providerID) hook.callback(input);
      }
    },
  };
}

const DEFAULT_SETTINGS: LongContextSettings = { plan: "pro", longContextExtraUsage: false };

describe("REQ-CB-PROV-001 provider registration and model catalog", () => {
  it("TestREQ_CB_PROV_001_registers_provider_and_models lists the catalog after reload", async () => {
    const host = createFakeHost();
    const registry = createProviderRegistry();

    const registration = await registerClaudeBridge(host.ctx, { registry });

    assert.equal(registration.catalog.providerId, CLAUDE_BRIDGE_PROVIDER_ID);
    assert.ok(registration.catalog.models.length >= 1);
    assert.equal(
      getProviderCatalog(registry, CLAUDE_BRIDGE_PROVIDER_ID)?.providerId,
      CLAUDE_BRIDGE_PROVIDER_ID,
    );

    await host.reload();

    const listed = host.editor.list().filter((record) => record.provider.id === CLAUDE_BRIDGE_PROVIDER_ID);
    assert.equal(listed.length, 1);
    const record = listed[0];
    assert.ok(record);
    assert.equal(record.provider.name, "Claude Code");
    assert.equal(record.provider.activation, "auto");
    assert.equal(record.provider.package, "@anthropic-ai/claude-agent-sdk");
    assert.ok(record.models.length >= 1);

    for (const model of record.models) {
      assert.equal(model.providerID, CLAUDE_BRIDGE_PROVIDER_ID);
      assert.equal(model.modelID, model.id);
      assert.ok(model.id.length > 0);
      assert.equal(model.capabilities.tools, true);
      assert.ok(model.capabilities.input.length >= 1);
      assert.ok(model.capabilities.output.length >= 1);
      assert.ok(model.limit.context >= 200_000);
    }

    const opus47 = record.models.find((model) => model.id === "claude-opus-4-7");
    assert.ok(opus47);
    assert.equal(opus47.limit.context, 1_000_000);
  });

  it("TestREQ_CB_PROV_001_registers_provider_and_models does not duplicate records across hot-reloads", async () => {
    const host = createFakeHost();
    await registerClaudeBridge(host.ctx, { registry: createProviderRegistry() });

    await host.reload();
    const afterFirstReload = host.editor.list().length;
    await host.reload();
    await host.reload();

    const bridgeRecords = host.editor.list().filter((record) => record.provider.id === CLAUDE_BRIDGE_PROVIDER_ID);
    assert.equal(bridgeRecords.length, 1);
    assert.equal(host.editor.list().length, afterFirstReload);
  });

  it("TestREQ_CB_PROV_001_registers_provider_and_models maps measured and plan-gated context windows", () => {
    const measured = resolveClaudeCodeRuntimeModel({ id: "claude-opus-4-7" }, DEFAULT_SETTINGS);
    assert.deepEqual(measured, { cliModelId: "claude-opus-4-7[1m]", contextWindow: 1_000_000 });

    const planGated = resolveClaudeCodeRuntimeModel({ id: "claude-opus-4-6" }, DEFAULT_SETTINGS);
    assert.deepEqual(planGated, { cliModelId: "claude-opus-4-6", contextWindow: 200_000 });

    const planGatedMax = resolveClaudeCodeRuntimeModel({ id: "claude-opus-4-6" }, {
      plan: "max",
      longContextExtraUsage: false,
    });
    assert.deepEqual(planGatedMax, { cliModelId: "claude-opus-4-6[1m]", contextWindow: 1_000_000 });

    const unmeasured = resolveClaudeCodeRuntimeModel({ id: "claude-unrated-1" }, DEFAULT_SETTINGS);
    assert.deepEqual(unmeasured, { cliModelId: "claude-unrated-1", contextWindow: 200_000 });

    assert.equal(CLAUDE_CODE_MODELS[0]?.id, "claude-fable-5-1");
    assert.ok(CLAUDE_CODE_MODELS.every((model) => !/-20\d{6}$/.test(model.id)));
  });
});

describe("REQ-CB-PROV-002 language model seam attach", () => {
  it("TestREQ_CB_PROV_002_language_model_hook is scoped by providerID claude-bridge", async () => {
    const host = createFakeHost();
    await registerClaudeBridge(host.ctx, { registry: createProviderRegistry() });

    const languageHook = host.hooks.find((hook) => hook.name === "language");
    assert.ok(languageHook);
    assert.deepEqual(languageHook.options, { providerID: CLAUDE_BRIDGE_PROVIDER_ID });

    const [model] = projectClaudeCodeModels();
    assert.ok(model);

    const bridgeInput: LanguageHookInput = { model, sdk: {}, options: {} };
    host.fireLanguage(bridgeInput, CLAUDE_BRIDGE_PROVIDER_ID);
    const attached = bridgeInput.language;
    assert.ok(attached);
    assert.equal(attached.modelId, model.id);
    assert.equal(attached.provider, CLAUDE_BRIDGE_PROVIDER_ID);
    assert.equal(attached.specificationVersion, "v3");
    assert.equal(attached.doStream && typeof attached.doStream, "function");
    assert.throws(
      () => attached.doStream({}),
      new RegExp(LANGUAGE_MODEL_PENDING_CODE.replace("/", "\\/")),
    );

    const foreignInput: LanguageHookInput = { model, sdk: {}, options: {} };
    host.fireLanguage(foreignInput, "anthropic");
    assert.equal(foreignInput.language, undefined);
  });
});

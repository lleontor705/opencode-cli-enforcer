/**
 * Claude provider registration into the OpenCode v2 seams (REQ-CB-PROV-001/002, D1).
 *
 * Catalog binding and the language-model hook are keyed by provider id and pushed
 * through the seam registry, so a second provider (agy) reuses this module with a
 * different id, catalog and language-model factory and no Claude-specific changes.
 */

import type { Plugin } from "@opencode/plugin";
import type { Model, Provider } from "@opencode/plugin";
import type { LanguageModelV3 } from "@ai-sdk/provider";

import { createProviderRegistry, type ProviderRegistry } from "./registry.js";
import {
  CLAUDE_BRIDGE_PROVIDER_ID,
  createClaudeBridgeCatalog,
  type ClaudeBridgeCatalog,
  type LongContextSettings,
} from "./models.js";

/** The plugin context surface this module depends on. */
export type ClaudeBridgeContext = Pick<Plugin.Context, "provider" | "aisdk">;

export interface Disposable {
  dispose(): Promise<void>;
}

export type LanguageModelFactory = (model: Model.Info) => LanguageModelV3;

export interface ProviderCatalog extends ClaudeBridgeCatalog {
  readonly languageModelFactory: LanguageModelFactory;
}

const catalogBindings = new WeakMap<ProviderRegistry, Map<string, ProviderCatalog>>();

/** Bind a provider catalog to a seam registry instance; upsert by id keeps it idempotent. */
export function registerProviderCatalog(registry: ProviderRegistry, catalog: ProviderCatalog): void {
  let bindings = catalogBindings.get(registry);
  if (bindings === undefined) {
    bindings = new Map();
    catalogBindings.set(registry, bindings);
  }
  bindings.set(catalog.providerId, catalog);
}

export function getProviderCatalog(
  registry: ProviderRegistry,
  providerId: string,
): ProviderCatalog | undefined {
  return catalogBindings.get(registry)?.get(providerId);
}

export const LANGUAGE_MODEL_PENDING_CODE = "stream/adapter-pending";

/**
 * Typed stand-in until the LanguageModelV3 adapter lands in cb-12. It fails loud
 * on first use instead of emitting an empty stream the driver would treat as a
 * completed turn.
 */
export function createPendingLanguageModel(model: Model.Info): LanguageModelV3 {
  const pending = (): never => {
    throw new Error(
      `${LANGUAGE_MODEL_PENDING_CODE}: the cli-providers LanguageModelV3 adapter lands in task cb-12`,
    );
  };
  return {
    specificationVersion: "v3",
    provider: CLAUDE_BRIDGE_PROVIDER_ID,
    modelId: model.id,
    supportedUrls: {},
    doGenerate: pending,
    doStream: pending,
  };
}

/**
 * Register the provider + model catalog. The editor is re-runnable across
 * hot-reloads, so the `get` guard keeps the add idempotent and prevents duplicate
 * cli-providers records from accumulating.
 */
export function bindProviderEditor(
  ctx: ClaudeBridgeContext,
  catalog: ProviderCatalog,
): Promise<Disposable> {
  return ctx.provider.transform((editor) => {
    if (editor.get(catalog.providerId)) return;
    editor.add({ info: catalog.info, models: catalog.models });
  });
}

/** Attach the custom language model, scoped to this provider id only. */
export function bindLanguageModel(
  ctx: ClaudeBridgeContext,
  catalog: ProviderCatalog,
): Promise<Disposable> {
  return ctx.aisdk.hook(
    "language",
    (input) => {
      input.language = catalog.languageModelFactory(input.model);
    },
    { providerID: catalog.providerId },
  );
}

export interface ClaudeBridgeRegistrationOptions {
  readonly settings?: LongContextSettings;
  readonly languageModelFactory?: LanguageModelFactory;
  /** Shared seam registry; a throwaway one is created when omitted. */
  readonly registry?: ProviderRegistry;
}

export interface ClaudeBridgeRegistration {
  readonly registry: ProviderRegistry;
  readonly catalog: ProviderCatalog;
  readonly registrations: readonly Disposable[];
}

export async function registerClaudeBridge(
  ctx: ClaudeBridgeContext,
  options: ClaudeBridgeRegistrationOptions = {},
): Promise<ClaudeBridgeRegistration> {
  const registry = options.registry ?? createProviderRegistry();
  const catalog: ProviderCatalog = {
    ...createClaudeBridgeCatalog(options.settings),
    languageModelFactory: options.languageModelFactory ?? createPendingLanguageModel,
  };
  registerProviderCatalog(registry, catalog);

  const registrations = [
    await bindProviderEditor(ctx, catalog),
    await bindLanguageModel(ctx, catalog),
  ];
  return { registry, catalog, registrations };
}

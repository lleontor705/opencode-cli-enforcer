/**
 * Static projection of the Claude Code model catalog (REQ-CB-PROV-001, D1).
 *
 * The catalog is pinned rather than discovered: the Claude Agent SDK child exposes
 * no enumerable model list, so the registered ids and context windows must match
 * what the bridge actually requests or the host status bar and the
 * auto-compaction threshold misreport. Ported from pi-claude-bridge models.ts.
 */

import { Model, Provider } from "@opencode/plugin";

/** OpenCode provider id owned by this plugin. */
export const CLAUDE_BRIDGE_PROVIDER_ID = "claude-bridge";

export const CLAUDE_BRIDGE_PROVIDER_NAME = "Claude Code";

const TWO_HUNDRED_K_CONTEXT = 200_000;
const ONE_M_CONTEXT = 1_000_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

export interface LongContextSettings {
  readonly plan: "pro" | "max";
  readonly longContextExtraUsage: boolean;
  /** Ids measured to never serve 1M even when the plan would otherwise allow it. */
  readonly forceTwoHundredK?: readonly string[];
}

/** Conservative default: the safe 200K projection until a plan is known. */
export const DEFAULT_LONG_CONTEXT_SETTINGS: LongContextSettings = {
  plan: "pro",
  longContextExtraUsage: false,
};

export interface ClaudeCodeModel {
  readonly id: string;
  readonly name: string;
  readonly family: string;
  /** Media types accepted as prompt input. */
  readonly input: readonly string[];
}

export interface ClaudeCodeRuntimeModel {
  readonly cliModelId: string;
  readonly contextWindow: number;
}

interface ClaudeCodeCatalogEntry extends ClaudeCodeModel {}

// Display order: flagship families first, unknown families sink below all known ones.
const FAMILY_ORDER: readonly string[] = ["fable", "opus", "sonnet", "haiku"];

// `[1m]` ids measured to serve 1M context on every plan; bare ids serve 200K.
const MEASURED_ONE_M = new Set<string>([
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-sonnet-5-5",
]);

// `[1m]` ids that serve 1M only when the plan grants it.
const PLAN_GATED_ONE_M: Readonly<Record<string, (settings: LongContextSettings) => boolean>> = {
  "claude-opus-4-6": (settings) => settings.plan === "max" || settings.longContextExtraUsage,
  "claude-sonnet-4-6": (settings) => settings.longContextExtraUsage,
};

const CLAUDE_CODE_MODEL_SEED: readonly ClaudeCodeCatalogEntry[] = [
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", family: "fable", input: ["text", "image"] },
  { id: "claude-fable-5", name: "Claude Fable 5", family: "fable", input: ["text", "image"] },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", family: "opus", input: ["text", "image"] },
  { id: "claude-opus-5", name: "Claude Opus 5", family: "opus", input: ["text", "image"] },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", family: "opus", input: ["text", "image"] },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", family: "opus", input: ["text", "image"] },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", family: "opus", input: ["text", "image"] },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", family: "sonnet", input: ["text", "image"] },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", family: "sonnet", input: ["text", "image"] },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", family: "sonnet", input: ["text", "image"] },
];

// Dated snapshot ids (claude-opus-4-5-20251101) must never be exposed: they would
// steal first-partial-match shortcuts from the bare id.
function isDatedAlias(id: string): boolean {
  return /-20\d{6}$/.test(id);
}

// Version rank of a claude id, e.g. claude-opus-4-7 -> { family: "opus", tuple: [4, 7] }.
function versionRank(id: string): { family: string; tuple: [number, number] } {
  const [, family, major, minor] = id.split("-");
  return { family, tuple: [Number(major) || 0, Number(minor) || 0] };
}

/** Newest generation first within a family; families ordered by `FAMILY_ORDER`. */
export function orderClaudeCodeModels(
  models: readonly ClaudeCodeModel[],
): ClaudeCodeModel[] {
  return models
    .filter((model) => !isDatedAlias(model.id))
    .sort((a, b) => {
      const fa = FAMILY_ORDER.indexOf(versionRank(a.id).family);
      const fb = FAMILY_ORDER.indexOf(versionRank(b.id).family);
      const ta = fa === -1 ? FAMILY_ORDER.length : fa;
      const tb = fb === -1 ? FAMILY_ORDER.length : fb;
      if (ta !== tb) return ta - tb;
      const [amajor, aminor] = versionRank(a.id).tuple;
      const [bmajor, bminor] = versionRank(b.id).tuple;
      if (amajor !== bmajor) return bmajor - amajor;
      if (aminor !== bminor) return bminor - aminor;
      return a.id.localeCompare(b.id);
    });
}

export const CLAUDE_CODE_MODELS: readonly ClaudeCodeModel[] =
  orderClaudeCodeModels(CLAUDE_CODE_MODEL_SEED);

/**
 * The `[1m]` suffix is the only reliable way to request 1M context through the SDK;
 * an unentitled `[1m]` id is rejected outright, so only measured-good ids get it.
 */
export function resolveClaudeCodeRuntimeModel(
  model: { id: string },
  settings: LongContextSettings,
): ClaudeCodeRuntimeModel {
  if (settings.forceTwoHundredK?.includes(model.id)) {
    return { cliModelId: model.id, contextWindow: TWO_HUNDRED_K_CONTEXT };
  }
  if (MEASURED_ONE_M.has(model.id)) {
    return { cliModelId: `${model.id}[1m]`, contextWindow: ONE_M_CONTEXT };
  }
  const planGate = PLAN_GATED_ONE_M[model.id];
  if (planGate !== undefined) {
    const useOneM = planGate(settings);
    return {
      cliModelId: useOneM ? `${model.id}[1m]` : model.id,
      contextWindow: useOneM ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
    };
  }
  return { cliModelId: model.id, contextWindow: TWO_HUNDRED_K_CONTEXT };
}

const CLAUDE_BRIDGE_PROVIDER_ID_BRAND = Provider.ID.make(CLAUDE_BRIDGE_PROVIDER_ID);

export function claudeBridgeProviderInfo(): Provider.Info {
  return {
    ...Provider.Info.empty(CLAUDE_BRIDGE_PROVIDER_ID_BRAND),
    name: CLAUDE_BRIDGE_PROVIDER_NAME,
    package: "@anthropic-ai/claude-agent-sdk",
  };
}

/**
 * Project the static catalog onto OpenCode `Model.Info` records. `limit.context`
 * mirrors the window the bridge requests for the given plan so compaction math
 * stays honest.
 */
export function projectClaudeCodeModels(
  settings: LongContextSettings = DEFAULT_LONG_CONTEXT_SETTINGS,
): readonly Model.Info[] {
  return CLAUDE_CODE_MODELS.map((model) => {
    const runtime = resolveClaudeCodeRuntimeModel(model, settings);
    return {
      ...Model.Info.default(CLAUDE_BRIDGE_PROVIDER_ID_BRAND, Model.ID.make(model.id)),
      name: model.name,
      family: Model.Family.make(model.family),
      capabilities: { tools: true, input: [...model.input], output: ["text"] },
      limit: { context: runtime.contextWindow, output: DEFAULT_MAX_OUTPUT_TOKENS },
    };
  });
}

export interface ClaudeBridgeCatalog {
  readonly providerId: string;
  readonly info: Provider.Info;
  readonly models: readonly Model.Info[];
}

export function createClaudeBridgeCatalog(
  settings: LongContextSettings = DEFAULT_LONG_CONTEXT_SETTINGS,
): ClaudeBridgeCatalog {
  return {
    providerId: CLAUDE_BRIDGE_PROVIDER_ID,
    info: claudeBridgeProviderInfo(),
    models: projectClaudeCodeModels(settings),
  };
}

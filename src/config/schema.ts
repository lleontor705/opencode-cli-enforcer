export type ProviderId = "claude" | "agy";

export const PROVIDER_IDS = ["claude", "agy"] as const;

export interface ProviderConstraint {
  readonly id: string;
  readonly summary: string;
}

export const CLAUDE_CONSTRAINTS: readonly ProviderConstraint[] = [
  {
    id: "child-env-hygiene",
    summary:
      "The Claude Code child must receive a scrubbed environment (ENABLE_CLAUDEAI_MCP_SERVERS=0, DISABLE_AUTO_COMPACT=1, ANTHROPIC_* removed) so an exported ANTHROPIC_API_KEY cannot hijack subscription auth.",
  },
  {
    id: "session-mirror-rebuild-cost",
    summary:
      "Host history rewrites (compaction or revert) force a full session-mirror rebuild, which re-sends the whole conversation and accepts a prompt-cache miss.",
  },
];

export const AGY_CONSTRAINTS: readonly ProviderConstraint[] = [
  {
    id: "tos-third-party-access-ambiguity",
    summary:
      "Google Antigravity Additional Terms leave third-party programmatic access ambiguous (google-ai devforum threads 185992, 186954, 185494, 186952, 187241); enabling agy is an explicit operator risk decision.",
  },
  {
    id: "fatal-control-frames",
    summary:
      "In-stream control_request/control_response frames and slash commands are fatal to the agy child (exit 2); only user message events may be written to stdin.",
  },
  {
    id: "no-mid-turn-steer",
    summary:
      "agy cannot be steered mid-turn; steering requests are queued and delivered at the next turn boundary.",
  },
  {
    id: "auto-allowed-workspace-writes",
    summary:
      "agy auto-allows workspace writes by default; permission enforcement relies on declarative allow-rules and explicit --dangerously-skip-permissions consent.",
  },
];

export const PROVIDER_CONSTRAINTS: Readonly<Record<ProviderId, readonly ProviderConstraint[]>> = {
  claude: CLAUDE_CONSTRAINTS,
  agy: AGY_CONSTRAINTS,
};

export const CHILD_ENV_HYGIENE = {
  ENABLE_CLAUDEAI_MCP_SERVERS: "0",
  DISABLE_AUTO_COMPACT: "1",
} as const;

export const CHILD_ENV_SCRUB_PREFIXES = ["ANTHROPIC_"] as const;

export const CONFIG_ERROR_CODE = "config/invalid-options" as const;

export class ConfigError extends Error {
  readonly code = CONFIG_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface ResolvedClaudeConfig {
  readonly enabled: boolean;
  readonly modelOverride: string | null;
  readonly debugLogs: boolean;
  readonly toolsAllow: readonly string[] | null;
  readonly acknowledgedConstraints: readonly string[];
}

export interface ResolvedAgyConfig {
  readonly enabled: boolean;
  readonly dangerouslySkipPermissionsConsent: boolean;
  readonly acknowledgedConstraints: readonly string[];
}

export interface ResolvedProvidersConfig {
  readonly claude: ResolvedClaudeConfig;
  readonly agy: ResolvedAgyConfig;
}

export interface ResolvedChildEnv {
  readonly set: Readonly<Record<string, string>>;
  readonly scrubPrefixes: readonly string[];
}

export interface ResolvedConfig {
  readonly providers: ResolvedProvidersConfig;
  readonly defaultProvider: ProviderId;
  readonly childEnv: ResolvedChildEnv;
}

export const DEFAULT_PROVIDER: ProviderId = "claude";

const CLAUDE_DEFAULTS = {
  enabled: true,
  modelOverride: null,
  debugLogs: false,
  toolsAllow: null,
} as const;

const AGY_DEFAULTS = {
  enabled: false,
  dangerouslySkipPermissionsConsent: false,
} as const;

const CLAUDE_ACKNOWLEDGED_BY_DEFAULT: readonly string[] = CLAUDE_CONSTRAINTS.map((c) => c.id);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function invalid(path: string, detail: string): never {
  throw new ConfigError(`${path}: ${detail}`);
}

function assertNoUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid(`${path}.${key}`, "unknown option");
  }
}

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value === "boolean") return value;
  invalid(path, `expected boolean, received ${typeName(value)}`);
}

function readString(value: unknown, path: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  invalid(path, `expected non-empty string, received ${typeName(value)}`);
}

function readStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) invalid(path, `expected string[], received ${typeName(value)}`);
  return value.map((entry, index) => readString(entry, `${path}[${index}]`));
}

function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

function assertAcknowledged(
  provider: ProviderId,
  enabled: boolean,
  acknowledged: readonly string[],
): void {
  const path = `providers.${provider}.acknowledgedConstraints`;
  const registerIds = PROVIDER_CONSTRAINTS[provider].map((constraint) => constraint.id);
  const unknown = acknowledged.filter((id) => !registerIds.includes(id));
  if (unknown.length > 0) {
    invalid(path, `unknown constraint id(s): ${unknown.join(", ")}`);
  }
  if (!enabled) return;
  const missing = registerIds.filter((id) => !acknowledged.includes(id));
  if (missing.length > 0) {
    throw new ConfigError(
      `${path}: provider "${provider}" is enabled but its constraint register is not fully acknowledged; missing: ${missing.join(", ")}`,
    );
  }
}

function resolveClaude(raw: unknown): ResolvedClaudeConfig {
  const path = "providers.claude";
  if (raw === undefined) {
    return { ...CLAUDE_DEFAULTS, acknowledgedConstraints: [...CLAUDE_ACKNOWLEDGED_BY_DEFAULT] };
  }
  if (!isRecord(raw)) invalid(path, `expected object, received ${typeName(raw)}`);
  assertNoUnknownKeys(
    raw,
    ["enabled", "modelOverride", "debugLogs", "toolsAllow", "acknowledgedConstraints"],
    path,
  );
  const enabled =
    raw.enabled === undefined ? CLAUDE_DEFAULTS.enabled : readBoolean(raw.enabled, `${path}.enabled`);
  const modelOverride =
    raw.modelOverride === undefined ? null : readString(raw.modelOverride, `${path}.modelOverride`);
  const debugLogs =
    raw.debugLogs === undefined ? false : readBoolean(raw.debugLogs, `${path}.debugLogs`);
  const toolsAllow =
    raw.toolsAllow === undefined ? null : readStringArray(raw.toolsAllow, `${path}.toolsAllow`);
  const acknowledgedConstraints =
    raw.acknowledgedConstraints === undefined
      ? [...CLAUDE_ACKNOWLEDGED_BY_DEFAULT]
      : readStringArray(raw.acknowledgedConstraints, `${path}.acknowledgedConstraints`);
  assertAcknowledged("claude", enabled, acknowledgedConstraints);
  return { enabled, modelOverride, debugLogs, toolsAllow, acknowledgedConstraints };
}

function resolveAgy(raw: unknown): ResolvedAgyConfig {
  const path = "providers.agy";
  if (raw === undefined) {
    return { ...AGY_DEFAULTS, acknowledgedConstraints: [] };
  }
  if (!isRecord(raw)) invalid(path, `expected object, received ${typeName(raw)}`);
  assertNoUnknownKeys(
    raw,
    ["enabled", "acknowledgedConstraints", "dangerouslySkipPermissionsConsent"],
    path,
  );
  const enabled =
    raw.enabled === undefined ? AGY_DEFAULTS.enabled : readBoolean(raw.enabled, `${path}.enabled`);
  const dangerouslySkipPermissionsConsent =
    raw.dangerouslySkipPermissionsConsent === undefined
      ? false
      : readBoolean(
          raw.dangerouslySkipPermissionsConsent,
          `${path}.dangerouslySkipPermissionsConsent`,
        );
  const acknowledgedConstraints =
    raw.acknowledgedConstraints === undefined
      ? []
      : readStringArray(raw.acknowledgedConstraints, `${path}.acknowledgedConstraints`);
  assertAcknowledged("agy", enabled, acknowledgedConstraints);
  return { enabled, dangerouslySkipPermissionsConsent, acknowledgedConstraints };
}

export function resolveConfig(options: unknown): ResolvedConfig {
  const raw = options === undefined || options === null ? {} : options;
  if (!isRecord(raw)) invalid("options", `expected object, received ${typeName(raw)}`);
  assertNoUnknownKeys(raw, ["providers", "defaultProvider"], "options");

  const providersRaw = raw.providers;
  let claudeRaw: unknown;
  let agyRaw: unknown;
  if (providersRaw === undefined) {
    claudeRaw = undefined;
    agyRaw = undefined;
  } else if (!isRecord(providersRaw)) {
    invalid("providers", `expected object, received ${typeName(providersRaw)}`);
  } else {
    assertNoUnknownKeys(providersRaw, [...PROVIDER_IDS], "providers");
    claudeRaw = providersRaw.claude;
    agyRaw = providersRaw.agy;
  }

  const claude = resolveClaude(claudeRaw);
  const agy = resolveAgy(agyRaw);

  let defaultProvider: ProviderId = DEFAULT_PROVIDER;
  if (raw.defaultProvider !== undefined) {
    const value = readString(raw.defaultProvider, "defaultProvider");
    if (!isProviderId(value)) {
      invalid("defaultProvider", `expected one of ${PROVIDER_IDS.join(", ")}, received "${value}"`);
    }
    defaultProvider = value;
  }

  const enabled: Record<ProviderId, boolean> = { claude: claude.enabled, agy: agy.enabled };
  if (!enabled[defaultProvider]) {
    invalid("defaultProvider", `provider "${defaultProvider}" is not enabled`);
  }

  return {
    providers: { claude, agy },
    defaultProvider,
    childEnv: {
      set: { ...CHILD_ENV_HYGIENE },
      scrubPrefixes: [...CHILD_ENV_SCRUB_PREFIXES],
    },
  };
}

export const DEFAULT_CONFIG: ResolvedConfig = resolveConfig({});

export function buildChildEnv(
  base: Readonly<Record<string, string | undefined>>,
  childEnv: ResolvedChildEnv = DEFAULT_CONFIG.childEnv,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (childEnv.scrubPrefixes.some((prefix) => key.startsWith(prefix))) continue;
    result[key] = value;
  }
  return { ...result, ...childEnv.set };
}

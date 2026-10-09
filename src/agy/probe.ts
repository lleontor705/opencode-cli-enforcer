/**
 * agy (Google Antigravity CLI) ProviderProbe and provider-registry integration
 * (REQ-CB-AGY-001, design D11/D12).
 *
 * Two responsibilities live here because they share one fact: how the bridge
 * learns that agy is present and how it exposes agy through the cb-02 registry.
 *
 * Probe. Every side effect (PATH lookup, file existence, env lookup, command
 * execution) goes through the injectable {@link AgyProbeIo} seam, so the unit
 * tier runs with no real CLI and no real filesystem. Health is a cached-credential
 * presence check: the OAuth token file's *existence* is the only signal the probe
 * is allowed to consume — the file is never opened, read, parsed, or logged
 * (D12). A quota-spending `agy -p` ping exists but is opt-in and off by default.
 *
 * Registration. {@link registerAgyProvider} binds the Wave B adapter pieces
 * (transport cb-21, mapper cb-22, session store cb-23, tool channel cb-24) into
 * one cb-02 `Provider` and registers the static model catalog through the same
 * cb-05 binding Claude uses, so a second provider is a config-level difference.
 * Capability flags are honest: agy has neither interactive approval nor mid-turn
 * steering, so the core degrades by policy rather than by accident.
 *
 * Resume accounting. agy reports cumulative-per-session usage, and cb-22's mapper
 * normalizes it to turn-scoped deltas against a baseline. The opaque handle in
 * src/agy/session-store.ts deliberately carries no usage, so the last cumulative
 * value is kept out-of-band in {@link AgyUsageBaselineLedger} and supplied to the
 * binding as a {@link AgyUsageBaselineProvider} callback. cb-26's integration
 * tests must verify that a resumed turn is not double-counted (see
 * {@link primeAgyResumeBaseline}).
 */

import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

import type { LanguageModelV3 } from "@ai-sdk/provider";
import { Model, Provider as PluginProvider } from "@opencode/plugin";

import { AGY_CONSTRAINTS, type ResolvedAgyConfig } from "../config/schema.js";
import type { ProviderRegistry } from "../provider/registry.js";
import {
  registerProviderCatalog,
  type LanguageModelFactory,
  type ProviderCatalog,
} from "../provider/registration.js";
import type {
  CliTransport,
  Provider,
  ProviderHealth,
  ProviderProbe,
  SessionHandle,
  SessionStore,
  ToolChannel,
  TurnUsage,
} from "../provider/seams.js";
import { EMPTY_USAGE } from "../provider/seams.js";
import type { AgyEventMapper } from "./event-mapper.js";

export const AGY_PROVIDER_ID = "agy";
export const AGY_PROVIDER_NAME = "Google Antigravity";

/** Executable the probe inspects and the transport spawns. */
export const AGY_PROBE_DEFAULT_COMMAND = "agy";

/**
 * Cached OAuth credentials written by the agy CLI itself (viability evidence
 * #576). The probe only ever tests existence.
 */
export const AGY_OAUTH_TOKEN_RELATIVE_PATH = ".gemini/antigravity-cli/antigravity-oauth-token";

const AGY_PROVIDER_ID_BRAND = PluginProvider.ID.make(AGY_PROVIDER_ID);

// ---------------------------------------------------------------------------
// Static model catalog.
// ---------------------------------------------------------------------------

export interface AgyModelEntry {
  /** Slug accepted by `--model` and returned by `agy models`. */
  readonly slug: string;
  readonly name: string;
  readonly family: string;
}

/**
 * Captured from `agy models` on v1.3.2 (2026-10-09). Pinned, never discovered:
 * the plugin must not shell out to the CLI at load time, and the catalog must
 * match the slugs the bridge actually requests or the host status bar
 * misreports. Re-measure on a CLI bump.
 */
export const AGY_MODEL_CATALOG: readonly AgyModelEntry[] = Object.freeze([
  { slug: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", family: "gemini" },
  { slug: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)", family: "gemini" },
  { slug: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)", family: "gemini" },
  { slug: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", family: "gemini" },
  { slug: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)", family: "gemini" },
  { slug: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)", family: "gemini" },
  { slug: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)", family: "gemini" },
  { slug: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)", family: "gemini" },
  { slug: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)", family: "gemini" },
  { slug: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)", family: "gemini" },
  { slug: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)", family: "gemini" },
  { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)", family: "claude" },
  { slug: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", family: "claude" },
  { slug: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", family: "gpt-oss" },
]);

export const AGY_MODEL_SLUGS: readonly string[] = AGY_MODEL_CATALOG.map((entry) => entry.slug);

/**
 * agy reports no context window. 200K is a conservative placeholder so
 * compaction math stays bounded; it is not a measured limit and must be revised
 * once a per-model figure is measured.
 */
export const AGY_ASSUMED_CONTEXT_WINDOW = 200_000;
export const AGY_MAX_OUTPUT_TOKENS = 32_000;

export function agyProviderInfo(): PluginProvider.Info {
  return {
    ...PluginProvider.Info.empty(AGY_PROVIDER_ID_BRAND),
    name: AGY_PROVIDER_NAME,
    package: "antigravity-cli",
  };
}

/**
 * Project the static catalog onto OpenCode `Model.Info` records. Input is
 * text-only because the agy stream-json protocol accepts text blocks only
 * (D12), regardless of what the underlying model could accept.
 */
export function projectAgyModels(): readonly Model.Info[] {
  return AGY_MODEL_CATALOG.map((entry) => ({
    ...Model.Info.default(AGY_PROVIDER_ID_BRAND, Model.ID.make(entry.slug)),
    name: entry.name,
    family: Model.Family.make(entry.family),
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: AGY_ASSUMED_CONTEXT_WINDOW, output: AGY_MAX_OUTPUT_TOKENS },
  }));
}

export const AGY_LANGUAGE_MODEL_PENDING_CODE = "stream/agy-adapter-pending";

/**
 * Typed stand-in until the agy LanguageModelV3 adapter lands in cb-26. It fails
 * loud on first use instead of emitting an empty stream the driver would treat
 * as a completed turn.
 */
export function createPendingAgyLanguageModel(model: Model.Info): LanguageModelV3 {
  const pending = (): never => {
    throw new Error(
      `${AGY_LANGUAGE_MODEL_PENDING_CODE}: the agy LanguageModelV3 adapter lands in task cb-26`,
    );
  };
  return {
    specificationVersion: "v3",
    provider: AGY_PROVIDER_ID,
    modelId: model.id,
    supportedUrls: {},
    doGenerate: pending,
    doStream: pending,
  };
}

// ---------------------------------------------------------------------------
// Probe I/O seam.
// ---------------------------------------------------------------------------

export interface AgyCommandResult {
  /** Process exit code, or null when the command could not be executed at all. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Every side effect the probe performs. The interface has no file-reading member
 * by construction, so "never reads the token" is a structural property, not a
 * convention. Tests supply a recording fake; production uses {@link createDefaultProbeIo}.
 */
export interface AgyProbeIo {
  /** `command -v` semantics: absolute path of an executable, or undefined. */
  resolveExecutable(command: string): Promise<string | undefined>;
  /** Existence-only check; never reads file contents. */
  pathExists(targetPath: string): Promise<boolean>;
  getEnv(name: string): string | undefined;
  run(command: string, args: readonly string[]): Promise<AgyCommandResult>;
}

const PROBE_TIMEOUT_MS = 10_000;

function exitCodeOf(error: Error | null): number | null {
  if (error === null) return 0;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : null;
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

export function createDefaultProbeIo(): AgyProbeIo {
  return {
    async resolveExecutable(command) {
      const candidates = hasPathSeparator(command)
        ? [command]
        : (process.env.PATH ?? "")
            .split(path.delimiter)
            .filter((dir) => dir.length > 0)
            .map((dir) => path.join(dir, command));
      for (const candidate of candidates) {
        try {
          await access(candidate, fsConstants.X_OK);
          return candidate;
        } catch {
          // Not executable here; keep scanning PATH.
        }
      }
      return undefined;
    },
    async pathExists(targetPath) {
      try {
        await access(targetPath, fsConstants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    getEnv: (name) => process.env[name],
    run(command, args) {
      return new Promise<AgyCommandResult>((resolve) => {
        execFile(
          command,
          [...args],
          { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1 << 20, windowsHide: true },
          (error, stdout, stderr) => {
            resolve({
              code: exitCodeOf(error),
              stdout: String(stdout),
              stderr: String(stderr),
            });
          },
        );
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The probe.
// ---------------------------------------------------------------------------

export interface AgyProbeOptions {
  /** Executable to inspect. Defaults to `agy`. */
  readonly command?: string;
  readonly io?: AgyProbeIo;
  /** Overrides the home directory used to locate the token file. */
  readonly homeDir?: string;
  /** Explicit token path; wins over `homeDir`/env resolution when supplied. */
  readonly tokenPath?: string;
  /** Opt-in quota-spending ping. Off by default (it consumes subscription quota). */
  readonly cheapPing?: boolean;
  readonly pingArgs?: readonly string[];
}

/** Minimal opt-in probe prompt; each run spends subscription quota. */
export const AGY_DEFAULT_PING_ARGS: readonly string[] = Object.freeze(["-p", "ping"]);

const AGY_VERSION_PATTERN = /\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/;

/** Extract a semver-ish version token from `agy --version` output. */
export function parseAgyVersion(output: string): string | undefined {
  return AGY_VERSION_PATTERN.exec(output)?.[1];
}

export function agyOAuthTokenPath(homeDir: string): string {
  return path.join(homeDir, ...AGY_OAUTH_TOKEN_RELATIVE_PATH.split("/"));
}

export class AgyProbe implements ProviderProbe {
  private readonly command: string;
  private readonly io: AgyProbeIo;
  private readonly explicitHomeDir: string | undefined;
  private readonly explicitTokenPath: string | undefined;
  private readonly cheapPing: boolean;
  private readonly pingArgs: readonly string[];

  constructor(options: AgyProbeOptions = {}) {
    this.command = options.command ?? AGY_PROBE_DEFAULT_COMMAND;
    this.io = options.io ?? createDefaultProbeIo();
    this.explicitHomeDir = options.homeDir;
    this.explicitTokenPath = options.tokenPath;
    this.cheapPing = options.cheapPing ?? false;
    this.pingArgs = options.pingArgs ?? AGY_DEFAULT_PING_ARGS;
  }

  /** True when the configured command resolves to an executable on PATH. */
  async detect(): Promise<boolean> {
    return (await this.io.resolveExecutable(this.command)) !== undefined;
  }

  async version(): Promise<string | undefined> {
    const result = await this.io.run(this.command, ["--version"]);
    if (result.code !== 0) return undefined;
    return parseAgyVersion(`${result.stdout}\n${result.stderr}`);
  }

  /**
   * `unavailable` when the cached-credentials file is absent, `healthy` when it
   * is present. With the opt-in ping enabled, a failed ping downgrades that to
   * `degraded` without ever concluding the credentials are invalid.
   */
  async health(): Promise<ProviderHealth> {
    const tokenPath = this.resolveTokenPath();
    if (tokenPath.length === 0 || !(await this.io.pathExists(tokenPath))) {
      return "unavailable";
    }
    if (!this.cheapPing) return "healthy";
    const result = await this.io.run(this.command, this.pingArgs);
    return result.code === 0 ? "healthy" : "degraded";
  }

  private resolveTokenPath(): string {
    if (this.explicitTokenPath !== undefined) return this.explicitTokenPath;
    const home = this.explicitHomeDir ?? this.io.getEnv("HOME") ?? this.io.getEnv("USERPROFILE");
    if (home === undefined || home.length === 0) return "";
    return agyOAuthTokenPath(home);
  }
}

// ---------------------------------------------------------------------------
// Resume accounting.
// ---------------------------------------------------------------------------

/** Resolve the last cumulative (session-scoped) usage for a conversation handle. */
export type AgyUsageBaselineProvider = (handle: SessionHandle) => TurnUsage | undefined;

/**
 * Out-of-band store for the last cumulative usage observed per conversation.
 * The agy handle stays opaque (`{provider, conversationRef}`) by D11, so the
 * running total cannot be serialized into it; it lives here instead. Stored
 * values are defensive copies so a caller can never mutate the ledger's state.
 */
export class AgyUsageBaselineLedger {
  private readonly baselines = new Map<string, TurnUsage>();

  private static key(handle: SessionHandle): string {
    return `${handle.provider}:${handle.conversationRef}`;
  }

  record(handle: SessionHandle, cumulative: TurnUsage): void {
    this.baselines.set(AgyUsageBaselineLedger.key(handle), { ...cumulative });
  }

  get(handle: SessionHandle): TurnUsage | undefined {
    const stored = this.baselines.get(AgyUsageBaselineLedger.key(handle));
    return stored === undefined ? undefined : { ...stored };
  }

  /** Plain callback for the registry binding (no ledger identity leaks). */
  provider(): AgyUsageBaselineProvider {
    return (handle) => this.get(handle);
  }

  clear(handle?: SessionHandle): void {
    if (handle === undefined) this.baselines.clear();
    else this.baselines.delete(AgyUsageBaselineLedger.key(handle));
  }
}

/**
 * Seed the mapper's cumulative baseline before resuming a conversation, so the
 * first resumed turn is measured as a delta from the persisted total instead of
 * re-reporting the whole session. Resetting also clears the captured session id
 * and tool list; the resume stream's `init` event repopulates both.
 *
 * cb-26's integration tests must assert that resume-with-baseline never
 * double-counts a conversation's tokens.
 */
export function primeAgyResumeBaseline(
  mapper: Pick<AgyEventMapper, "resetSession">,
  handle: SessionHandle,
  usageBaselineProvider?: AgyUsageBaselineProvider,
): TurnUsage {
  const baseline = usageBaselineProvider?.(handle) ?? EMPTY_USAGE;
  mapper.resetSession(baseline);
  return baseline;
}

// ---------------------------------------------------------------------------
// Registry integration.
// ---------------------------------------------------------------------------

/**
 * Honest capability surface, fixed by agy's protocol (D12): no canUseTool
 * callback and no mid-turn steering. Kept as one frozen object so the provider
 * aggregate, the catalog metadata and the oracles cannot drift apart.
 */
export const AGY_PROVIDER_CAPABILITY_FLAGS = Object.freeze({
  supportsInteractiveApproval: false,
  supportsMidTurnSteer: false,
});

export interface AgyProviderBindings {
  /** Wave B transport (cb-21). */
  readonly transport: CliTransport;
  /** Wave B event mapper (cb-22); its cumulative usage is turn-normalized. */
  readonly eventMapper: AgyEventMapper;
  /** Wave B session store (cb-23). */
  readonly sessions: SessionStore;
  /** Wave B tool channel (cb-24). Injected so this task never owns channel.ts. */
  readonly tools: ToolChannel;
  /** Probe override; defaults to a fresh {@link AgyProbe}. */
  readonly probe?: ProviderProbe;
}

export function createAgyProvider(bindings: AgyProviderBindings): Provider {
  return {
    id: AGY_PROVIDER_ID,
    transport: bindings.transport,
    eventMapper: bindings.eventMapper,
    sessions: bindings.sessions,
    tools: bindings.tools,
    permissions: {
      supportsInteractiveApproval: AGY_PROVIDER_CAPABILITY_FLAGS.supportsInteractiveApproval,
    },
    steering: { supportsMidTurnSteer: AGY_PROVIDER_CAPABILITY_FLAGS.supportsMidTurnSteer },
    probe: bindings.probe ?? new AgyProbe(),
  };
}

export function createAgyProviderCatalog(
  languageModelFactory: LanguageModelFactory = createPendingAgyLanguageModel,
): ProviderCatalog {
  return {
    providerId: AGY_PROVIDER_ID,
    info: agyProviderInfo(),
    models: projectAgyModels(),
    languageModelFactory,
  };
}

export interface AgyRegistrationOptions extends AgyProviderBindings {
  readonly languageModelFactory?: LanguageModelFactory;
  /**
   * Ledger holding the last cumulative usage per conversation. Omitted -> a
   * fresh in-memory ledger is created and exposed on the result. The wiring
   * task records the mapper's ending cumulative here after each turn and seeds
   * it on resume via {@link primeAgyResumeBaseline}.
   */
  readonly baselines?: AgyUsageBaselineLedger;
}

export interface AgyRegistration {
  readonly provider: Provider;
  readonly catalog: ProviderCatalog;
  readonly baselines: AgyUsageBaselineLedger;
  readonly usageBaselineProvider: AgyUsageBaselineProvider;
}

/**
 * Bind agy into the cb-02 registry: the provider aggregate under id `agy` and
 * the model catalog through the cb-05 catalog binding, so catalog selection and
 * the `language` hook are config-level for a second provider.
 */
export function registerAgyProvider(
  registry: ProviderRegistry,
  options: AgyRegistrationOptions,
): AgyRegistration {
  const provider = createAgyProvider(options);
  registry.register(provider);
  const catalog = createAgyProviderCatalog(options.languageModelFactory);
  registerProviderCatalog(registry, catalog);
  const baselines = options.baselines ?? new AgyUsageBaselineLedger();
  return { provider, catalog, baselines, usageBaselineProvider: baselines.provider() };
}

/**
 * Defensive registration gate. `resolveConfig` already rejects an enabled
 * provider whose constraint register is incomplete (cb-03); this repeats the
 * check at the binding boundary so a hand-built config can never register agy
 * without the operator's explicit acknowledgment.
 */
export function agyRegistrationEnabled(
  agy: Pick<ResolvedAgyConfig, "enabled" | "acknowledgedConstraints">,
): boolean {
  if (!agy.enabled) return false;
  return AGY_CONSTRAINTS.every((constraint) =>
    agy.acknowledgedConstraints.includes(constraint.id),
  );
}

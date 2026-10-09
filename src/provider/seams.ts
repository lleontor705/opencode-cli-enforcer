/**
 * Provider-agnostic Layer-1 seams (REQ-CB-SEAM-001, D11).
 *
 * These seven interfaces are the only contracts the core may depend on.
 * Provider adapters (Claude in Wave A, agy in Wave B) implement them and are
 * bound to their implementations exclusively through the provider registry.
 *
 * Hard rule: no provider-specific type may appear in any signature below.
 */

export type ProviderId = string;

/** Normalized terminal state of a single turn, shared by every provider. */
export type TurnStatus = "completed" | "aborted" | "failed" | "rate-limited";

/**
 * Turn-scoped token accounting.
 *
 * Providers that report cumulative-per-session counters (agy) MUST convert them
 * to per-turn deltas inside their EventMapper; providers that report per-message
 * counters (Claude) pass them through unchanged. Normalizing here is what keeps
 * the host token accounting from double-counting a resumed session.
 */
export interface TurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export const EMPTY_USAGE: TurnUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/** Difference of two cumulative usage snapshots, clamped at zero per counter. */
export function usageDelta(cumulative: TurnUsage, baseline: TurnUsage): TurnUsage {
  return {
    inputTokens: Math.max(0, cumulative.inputTokens - baseline.inputTokens),
    outputTokens: Math.max(0, cumulative.outputTokens - baseline.outputTokens),
    cacheReadTokens: Math.max(0, cumulative.cacheReadTokens - baseline.cacheReadTokens),
    cacheWriteTokens: Math.max(0, cumulative.cacheWriteTokens - baseline.cacheWriteTokens),
  };
}

/** THE normalized turn output. Producing this value is an EventMapper's job. */
export interface TurnResult {
  readonly status: TurnStatus;
  readonly text: string;
  readonly usage: TurnUsage;
  readonly sessionId: string;
}

/** Opaque, provider-neutral conversation handle. Core never parses its backing store. */
export interface SessionHandle {
  readonly provider: ProviderId;
  readonly conversationRef: string;
}

/** Provider-neutral request describing one turn to be spawned. */
export interface TurnRequest {
  readonly model: string;
  readonly session?: SessionHandle;
  readonly cwd?: string;
}

// ---------------------------------------------------------------------------
// 1. CliTransport
// ---------------------------------------------------------------------------

export interface CliSpawnRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface SpawnedCli {
  readonly pid: number | undefined;
  /** Write a single NDJSON frame to child stdin. */
  writeLine(line: string): Promise<void>;
  /** Close child stdin, flushing buffered frames. */
  endInput(): Promise<void>;
  /** Line-oriented async view of child stdout. */
  stdoutLines(): AsyncIterable<string>;
  /** Resolve with all captured stderr once the child exits. */
  stderrText(): Promise<string>;
  /** Resolve with the child exit code. */
  exitCode(): Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

export interface WatchdogOptions {
  readonly timeoutMs: number;
  readonly onTimeout: (timeoutMs: number) => void;
}

export interface Watchdog {
  arm(): void;
  disarm(): void;
}

export interface ExitCodeMapping {
  readonly code: number;
  /** Stable provider-neutral error kind (errors taxonomy, cb-04). */
  readonly kind: string;
  readonly fatal: boolean;
  readonly message: string;
}

export interface CliTransport {
  buildArgv(request: TurnRequest): string[];
  spawn(request: CliSpawnRequest): Promise<SpawnedCli>;
  writeFrame(cli: SpawnedCli, frame: unknown): Promise<void>;
  readLines(cli: SpawnedCli): AsyncIterable<string>;
  captureStderr(cli: SpawnedCli): Promise<string>;
  mapExitCode(code: number, stderr: string): ExitCodeMapping;
  watchdog(cli: SpawnedCli, options: WatchdogOptions): Watchdog;
}

// ---------------------------------------------------------------------------
// 2. EventMapper
// ---------------------------------------------------------------------------

export interface EventMapper<Raw, Normalized> {
  /**
   * Translate one provider-native event into zero or more normalized events.
   * Returning `undefined` (or an empty array) drops the event.
   */
  map(raw: Raw): Normalized | readonly Normalized[] | undefined;
  /**
   * Fold a turn's native events into THE normalized TurnResult.
   * Usage normalization is contractually owned by this method.
   */
  toTurnResult(events: readonly Raw[]): TurnResult;
}

// ---------------------------------------------------------------------------
// 3. SessionStore
// ---------------------------------------------------------------------------

export interface SessionStore {
  /** Capture an opaque handle from a provider stream event when one is present. */
  capture(event: unknown): SessionHandle | undefined;
  /** Provider-neutral serialization of a handle; never the provider's own storage. */
  serialize(handle: SessionHandle): string;
  deserialize(value: string): SessionHandle;
  /** Extra argv required to resume the referenced conversation. */
  resumeArgs(handle: SessionHandle): readonly string[];
}

// ---------------------------------------------------------------------------
// 4. ToolChannel
// ---------------------------------------------------------------------------

export interface HostToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export interface HostToolResult {
  readonly content: string;
  readonly isError?: boolean;
}

export interface HostTool {
  readonly descriptor: HostToolDescriptor;
  call(input: unknown): Promise<HostToolResult>;
}

export interface ToolChannel {
  registerHostTools(tools: readonly HostTool[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// 5. PermissionPolicy
// ---------------------------------------------------------------------------

export interface PermissionPolicy {
  /** Honest capability flag: false means approvals degrade by policy, not accident. */
  readonly supportsInteractiveApproval: boolean;
}

// ---------------------------------------------------------------------------
// 6. SteeringPolicy
// ---------------------------------------------------------------------------

export interface SteeringPolicy {
  /** Honest capability flag: false means mid-turn steer is enqueued at turn boundary. */
  readonly supportsMidTurnSteer: boolean;
}

// ---------------------------------------------------------------------------
// 7. ProviderProbe
// ---------------------------------------------------------------------------

export type ProviderHealth = "healthy" | "degraded" | "unavailable";

export interface ProviderProbeResult {
  readonly detected: boolean;
  readonly health: ProviderHealth;
  readonly version?: string;
}

export interface ProviderProbe {
  detect(): Promise<boolean>;
  version(): Promise<string | undefined>;
  health(): Promise<ProviderHealth>;
}

// ---------------------------------------------------------------------------
// Provider aggregate bound by the registry
// ---------------------------------------------------------------------------

export interface Provider {
  readonly id: ProviderId;
  readonly transport: CliTransport;
  readonly eventMapper: EventMapper<unknown, unknown>;
  readonly sessions: SessionStore;
  readonly tools: ToolChannel;
  readonly permissions: PermissionPolicy;
  readonly steering: SteeringPolicy;
  readonly probe: ProviderProbe;
}

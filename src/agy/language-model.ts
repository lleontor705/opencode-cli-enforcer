/**
 * agy (Google Antigravity CLI) LanguageModelV3 adapter: the OpenCode generation
 * surface for the agy provider (REQ-CB-AGY-001, REQ-CB-PROV-002; design D11/D12).
 *
 * `createAgyLanguageModel` binds the shipped Wave B chain into the same
 * `aisdk.hook("language")` seam the Claude adapter uses: the cb-21 transport
 * spawns `agy --input-format stream-json --output-format stream-json` with the
 * model slug plus the cb-23 `resumeArgs` for the current conversation, one text
 * `user` frame is written, and the child's `init`/`step_update`/`result` stdout
 * lines are parsed and mapped by the cb-22 mapper into
 * `LanguageModelV3StreamPart`s.
 *
 * Five behaviours are load-bearing and each has a dedicated oracle:
 *
 * - Step-level rendering, capability-honest. agy emits `ACTIVE`/`DONE` per step
 *   and a whole `tool_info` block at `DONE`, so there is no partial tool input
 *   and no reasoning text stream: the adapter emits `tool-call` parts only, never
 *   `tool-input-*` or `reasoning-*`. Tool calls are marked `providerExecuted`
 *   because agy runs them itself through the cb-24/cb-29 MCP hop; re-dispatching
 *   them host-side would run the tool twice.
 * - Delta usage at the finish frame. The mapper already normalizes agy's
 *   cumulative-per-session counters into a turn delta against the conversation
 *   baseline; the synthesized `finish` reports exactly that, and the ending
 *   cumulative is recorded in the cb-25 ledger so a resumed turn is not
 *   double-counted.
 * - Resume across turns. The conversation id is captured from `init`/`result`
 *   through the cb-23 seam and fed back as `--conversation` on the next
 *   `doStream` of the same adapter instance; a turn that did not complete
 *   (abort, dead child, or a non-completed `result` status) drops the handle,
 *   because agy has no force-rotate and its conversation is undefined to
 *   continue.
 * - `options.abortSignal` kills the child and ends the step with an `error` part
 *   — never a hang. The transport watchdog bounds the same turn for the
 *   documented agy headless stall (google-antigravity/antigravity-cli#318).
 * - Fail-loud dead children. A child that exits without emitting a single frame
 *   (unauthenticated agy, expired token) is classified through the cb-21 exit
 *   map plus its captured stderr, so the turn ends with exactly one classified
 *   `error` part instead of closing an empty silent stream.
 *
 * The adapter fails loud — never with an empty stream — both when it is invoked
 * without a transport binding and when its child dies without emitting a single
 * frame, so a mis-wired registration or an unauthenticated CLI is visible on
 * first use.
 */

import type { Model } from "@opencode/plugin";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";

import { bridgeError, categoryOfCode, isBridgeErrorCode, toBridgeError } from "../errors/taxonomy.js";
import type {
  CliSpawnRequest,
  CliTransport,
  ExitCodeMapping,
  SessionHandle,
  SessionStore,
  SpawnedCli,
  TurnStatus,
  Watchdog,
} from "../provider/seams.js";
import { toLanguageModelV3Usage } from "../stream/mapping.js";
import type { AgyRawEvent, NormalizedAgyEvent } from "./event-mapper.js";
import { AgyEventMapper, parseAgyLine } from "./event-mapper.js";
import type { AgyUsageBaselineLedger } from "./probe.js";
import { primeAgyResumeBaseline } from "./probe.js";
import { AGY_PROVIDER_ID } from "./session-store.js";
import { AGY_TRANSPORT_DEFAULT_COMMAND } from "./transport.js";

/** Fail-loud code for an adapter invoked without its transport binding. */
export const AGY_LANGUAGE_MODEL_UNBOUND_CODE = "stream/agy-adapter-unbound";

/**
 * Host watchdog deadline for one turn: the transport's own `--print-timeout`
 * (5m) plus slack, so agy's deadline fires first and the host one only catches a
 * silent stall after it.
 */
export const AGY_LANGUAGE_MODEL_WATCHDOG_MS = 330_000;

export interface AgyLanguageModelConfig {
  /** Wave B transport (cb-21). Omitted -> every request fails loud on use. */
  readonly transport?: CliTransport;
  /**
   * Builds the cb-22 mapper for one turn. Each turn gets a private mapper so two
   * conversations sharing this adapter cannot cross-contaminate their cumulative
   * baselines; resume correctness comes from the cb-25 ledger, not from sharing
   * mapper state. Defaults to `new AgyEventMapper()`.
   */
  readonly mapperFactory?: () => AgyEventMapper;
  /** Wave B session store (cb-23); supplies `--conversation` resume argv. */
  readonly sessions?: SessionStore;
  /** Executable the transport spawns; the cb-25 probe resolves the real path. */
  readonly command?: string;
  readonly cwd?: string;
  readonly baseEnv?: Readonly<Record<string, string>>;
  /** Host watchdog deadline for one turn. Defaults to {@link AGY_LANGUAGE_MODEL_WATCHDOG_MS}. */
  readonly watchdogTimeoutMs?: number;
  /** Last cumulative usage per conversation (cb-25), kept out-of-band by D11. */
  readonly usageBaselines?: AgyUsageBaselineLedger;
}

const EMPTY_LMV3_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

/** Per-instance conversation state: one adapter instance serves one session. */
interface AgyConversationState {
  handle: SessionHandle | null;
  lastTurnAborted: boolean;
}

/**
 * Drives one agy child process per turn and renders its stdout into a
 * `LanguageModelV3StreamPart` stream.
 */
class AgyTurn {
  private readonly model: Model.Info;
  private readonly config: AgyLanguageModelConfig;
  private readonly transport: CliTransport;
  private readonly sessions: SessionStore;
  private readonly mapper: AgyEventMapper;
  private readonly state: AgyConversationState;

  private controller: ReadableStreamDefaultController<LanguageModelV3StreamPart> | null = null;
  private cli: SpawnedCli | null = null;
  private watchdog: Watchdog | null = null;
  private abortSignal: AbortSignal | undefined;

  private raws: AgyRawEvent[] = [];
  private textId: string | null = null;
  private settled = false;
  private closed = false;
  private failed = false;
  private aborted = false;

  constructor(
    model: Model.Info,
    config: AgyLanguageModelConfig,
    transport: CliTransport,
    sessions: SessionStore,
    mapper: AgyEventMapper,
    state: AgyConversationState,
  ) {
    this.model = model;
    this.config = config;
    this.transport = transport;
    this.sessions = sessions;
    this.mapper = mapper;
    this.state = state;
  }

  start(options: LanguageModelV3CallOptions): ReadableStream<LanguageModelV3StreamPart> {
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.push({ type: "stream-start", warnings: [] });
    void this.drive(options);
    return stream;
  }

  // -- Turn lifecycle -------------------------------------------------------

  private async drive(options: LanguageModelV3CallOptions): Promise<void> {
    this.bindAbort(options.abortSignal);
    if (this.settled) return;
    this.primeConversation();

    try {
      const argv = [...this.transport.buildArgv({ model: this.model.id }), ...this.resumeArgs()];
      const request: CliSpawnRequest = {
        command: this.config.command ?? AGY_TRANSPORT_DEFAULT_COMMAND,
        args: argv,
        ...(this.config.cwd !== undefined ? { cwd: this.config.cwd } : {}),
        ...(this.config.baseEnv !== undefined ? { env: { ...this.config.baseEnv } } : {}),
      };
      const cli = await this.transport.spawn(request);
      if (this.settled) {
        cli.kill();
        return;
      }
      this.cli = cli;
      this.armWatchdog(cli);

      await this.transport.writeFrame(cli, {
        event: "user",
        message: { content: agyPromptText(options.prompt) },
      });

      for await (const line of this.transport.readLines(cli)) {
        if (this.settled) break;
        this.consume(parseAgyLine(line));
      }
      // A child that dies before emitting a single frame (unauthenticated agy,
      // expired token, fatal frame) must not close an empty silent stream:
      // classify the exit through the cb-21 map and its captured stderr. The
      // exit wait is bounded by the armed watchdog, so a child that closed stdout
      // but stayed alive still fails loud rather than hanging.
      if (this.raws.length === 0 && !this.settled) {
        const [code, stderr] = await Promise.all([cli.exitCode(), this.transport.captureStderr(cli)]);
        this.fail(classifyDeadChild(this.transport.mapExitCode(code, stderr), stderr));
      }
      this.settle();
    } catch (error) {
      this.fail(toBridgeError(error, "stream", "CB_STREAM_MAPPING_FAILED"));
    } finally {
      this.releaseAbort();
      this.watchdog?.disarm();
      this.watchdog = null;
      const cli = this.cli;
      this.cli = null;
      if (cli !== null) {
        try {
          cli.kill();
        } catch {
          // A child that already exited rejects kill; nothing left to stop.
        }
      }
      this.closeStream();
    }
  }

  /**
   * Reset the shared mapper for a clean-start, or seed its cumulative baseline
   * from the cb-25 ledger when resuming, so the resumed turn reports its delta.
   */
  private primeConversation(): void {
    const handle = this.state.handle;
    if (handle !== null && !this.state.lastTurnAborted) {
      primeAgyResumeBaseline(this.mapper, handle, this.config.usageBaselines?.provider());
      return;
    }
    this.mapper.resetSession();
  }

  private resumeArgs(): string[] {
    const handle = this.state.handle;
    if (handle === null || this.state.lastTurnAborted) return [];
    return [...this.sessions.resumeArgs(handle)];
  }

  private consume(raw: AgyRawEvent): void {
    this.raws.push(raw);
    if (raw.event === "init" || raw.event === "result") {
      const handle = this.sessions.capture(raw);
      if (handle !== undefined) this.state.handle = handle;
    }
    this.emit(this.mapper.map(raw));
  }

  // -- Rendering ------------------------------------------------------------

  private emit(events: readonly NormalizedAgyEvent[]): void {
    for (const event of events) {
      if (this.settled) return;
      switch (event.kind) {
        case "session":
          break;
        case "text-delta":
          this.pushTextDelta(event.id, event.delta);
          break;
        case "tool-call":
          this.closeTextBlock();
          this.push({
            type: "tool-call",
            toolCallId: event.id,
            toolName: event.toolName,
            input: JSON.stringify(event.input),
            // agy executes the tool itself through its MCP client, so the host
            // must not re-dispatch a call the child already ran.
            providerExecuted: true,
          });
          break;
        case "error":
          this.fail(bridgeError("stream", "CB_STREAM_MAPPING_FAILED", event.message));
          break;
      }
    }
  }

  private pushTextDelta(id: string, delta: string): void {
    if (this.textId !== id) {
      this.closeTextBlock();
      this.textId = id;
      this.push({ type: "text-start", id });
    }
    this.push({ type: "text-delta", id, delta });
  }

  private closeTextBlock(): void {
    const id = this.textId;
    if (id === null) return;
    this.textId = null;
    this.push({ type: "text-end", id });
  }

  /**
   * Fold the turn once and close the stream. A turn that failed or aborted emits
   * no `finish` — the `error` part is its terminal record — but its frames still
   * advance the cumulative baseline so a later resume stays delta-correct.
   */
  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.closeTextBlock();

    if (this.raws.length > 0) {
      const turn = this.mapper.toTurnResult(this.raws);
      const handle = this.state.handle;
      if (handle !== null) this.config.usageBaselines?.record(handle, this.mapper.sessionBaseline);
      if (!this.failed) {
        this.push({
          type: "finish",
          usage: toLanguageModelV3Usage(turn.usage),
          finishReason: finishReasonFor(turn.status),
        });
      }
    }

    // `lastTurnAborted` means "this handle is not safe to continue": any turn
    // that ended in an `error` part — an abort, a dead child, or a `result`
    // frame whose status is not completed — drops the conversation, so the next
    // turn clean-starts instead of resuming a failed one (cb-23).
    this.state.lastTurnAborted = this.failed;
    this.closeStream();
  }

  private fail(error: unknown): void {
    if (this.settled) return;
    this.failed = true;
    this.closeTextBlock();
    this.push({ type: "error", error: toBridgeError(error, "stream", "CB_STREAM_MAPPING_FAILED") });
    this.settle();
  }

  // -- Abort and watchdog ---------------------------------------------------

  private bindAbort(signal: AbortSignal | undefined): void {
    this.abortSignal = signal;
    if (signal === undefined) return;
    if (signal.aborted) {
      this.abort();
      return;
    }
    signal.addEventListener("abort", this.onAbort, { once: true });
  }

  private releaseAbort(): void {
    this.abortSignal?.removeEventListener("abort", this.onAbort);
    this.abortSignal = undefined;
  }

  private readonly onAbort = (): void => {
    this.abort();
  };

  private abort(): void {
    if (this.settled) return;
    this.aborted = true;
    this.failed = true;
    this.closeTextBlock();
    this.push({
      type: "error",
      error: bridgeError("stream", "CB_STREAM_ABORTED", "cli-providers: agy stream aborted by abortSignal"),
    });
    const cli = this.cli;
    if (cli !== null) {
      try {
        cli.kill();
      } catch {
        // Already exited; the abort still ends the stream below.
      }
    }
    this.settle();
  }

  private armWatchdog(cli: SpawnedCli): void {
    const timeoutMs = this.config.watchdogTimeoutMs ?? AGY_LANGUAGE_MODEL_WATCHDOG_MS;
    const watchdog = this.transport.watchdog(cli, {
      timeoutMs,
      onTimeout: (expiredMs) =>
        this.fail(
          bridgeError(
            "transport",
            "CB_TRANSPORT_TRANSIENT",
            `cli-providers: agy turn produced no result within ${expiredMs} ms`,
          ),
        ),
    });
    this.watchdog = watchdog;
    watchdog.arm();
  }

  private push(part: LanguageModelV3StreamPart): void {
    const controller = this.controller;
    if (this.closed || controller === null) return;
    try {
      controller.enqueue(part);
    } catch {
      // The consumer cancelled the stream; stop enqueuing into it.
      this.closed = true;
    }
  }

  private closeStream(): void {
    if (this.closed) return;
    this.closed = true;
    const controller = this.controller;
    this.controller = null;
    if (controller === null) return;
    try {
      controller.close();
    } catch {
      // Already closed or cancelled by the reader.
    }
  }
}

/** Build the custom `LanguageModelV3` registration binds for one agy model. */
export function createAgyLanguageModel(
  model: Model.Info,
  config: AgyLanguageModelConfig = {},
): LanguageModelV3 {
  const state: AgyConversationState = { handle: null, lastTurnAborted: false };

  const requireBinding = <T>(value: T | undefined, binding: string): T => {
    if (value === undefined) {
      throw new Error(
        `${AGY_LANGUAGE_MODEL_UNBOUND_CODE}: agy LanguageModelV3 adapter invoked without its ${binding} binding`,
      );
    }
    return value;
  };

  const doStream = async (
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> => {
    const transport = requireBinding(config.transport, "transport");
    const sessions = requireBinding(config.sessions, "session store");
    const mapper = config.mapperFactory?.() ?? new AgyEventMapper();
    if (options.abortSignal?.aborted) return { stream: abortedStream() };
    const turn = new AgyTurn(model, config, transport, sessions, mapper, state);
    return { stream: turn.start(options) };
  };

  const doGenerate = async (
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3GenerateResult> => {
    const { stream } = await doStream(options);
    return collectGenerateResult(stream);
  };

  return {
    specificationVersion: "v3",
    provider: AGY_PROVIDER_ID,
    modelId: model.id,
    supportedUrls: {},
    doGenerate,
    doStream,
  };
}

/** `LanguageModelFactory` shape the cb-25 catalog binding accepts. */
export function createAgyLanguageModelFactory(
  config: AgyLanguageModelConfig = {},
): (model: Model.Info) => LanguageModelV3 {
  return (model) => createAgyLanguageModel(model, config);
}

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

async function collectGenerateResult(
  stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3GenerateResult> {
  const reader = stream.getReader();
  let text = "";
  let finishReason: LanguageModelV3FinishReason = { unified: "other", raw: undefined };
  let usage: LanguageModelV3Usage = EMPTY_LMV3_USAGE;
  const content: LanguageModelV3Content[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.type === "text-delta") text += value.delta;
    else if (value.type === "tool-call") content.push(value);
    else if (value.type === "finish") {
      finishReason = value.finishReason;
      usage = value.usage;
    }
  }

  if (text.length > 0) content.unshift({ type: "text", text });
  return { content, finishReason, usage, warnings: [] };
}

function abortedStream(): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue({
        type: "error",
        error: bridgeError("stream", "CB_STREAM_ABORTED", "cli-providers: agy request aborted before streaming"),
      });
      controller.close();
    },
  });
}

/** Map the seam's terminal status onto an LMV3 finish reason. */
function finishReasonFor(status: TurnStatus): LanguageModelV3FinishReason {
  switch (status) {
    case "completed":
      return { unified: "stop", raw: "SUCCESS" };
    case "rate-limited":
      return { unified: "error", raw: "RATE_LIMITED" };
    case "aborted":
      return { unified: "other", raw: "CANCELED" };
    case "failed":
      return { unified: "error", raw: "ERROR" };
  }
}

/**
 * The turn prompt agy can accept. agy's stdin filter takes text blocks only, so
 * a prompt that carries tool results (agy runs tools itself) or no user text
 * degrades to a neutral continue marker rather than an empty frame, which agy
 * rejects as fatal.
 */
function agyPromptText(prompt: LanguageModelV3Prompt): string {
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    const message = prompt[index];
    if (message === undefined || message.role !== "user") continue;
    const parts: string[] = [];
    for (const part of message.content) {
      if (part.type === "text" && part.text.length > 0) parts.push(part.text);
    }
    const text = parts.join("\n");
    if (text.length > 0) return text;
  }
  return "[continue]";
}

// ---------------------------------------------------------------------------
// Dead-child classification.
// ---------------------------------------------------------------------------

/**
 * stderr signatures that mean agy never authenticated the turn. A retry cannot
 * mint credentials, so these are classified non-retryable instead of inheriting
 * the cb-21 exit map's signature-based transient guess.
 */
const AGY_AUTH_FAILURE_SIGNATURES: readonly RegExp[] = [
  /\bauthenticat/i,
  /\bunauthori[sz]ed\b/i,
  /\bnot (?:signed|logged) in\b/i,
  /\bsign[- ]?in\b/i,
  /\blog[- ]?in\b/i,
  /\bcredential/i,
  /\bapi[- ]?key\b/i,
  /\boauth\b/i,
  /\btoken (?:is )?(?:expired|invalid|revoked)\b/i,
  /\b401\b/,
];

function isAgyAuthFailure(stderr: string): boolean {
  return AGY_AUTH_FAILURE_SIGNATURES.some((pattern) => pattern.test(stderr));
}

/**
 * Classify a turn whose child died before emitting a single stdout frame.
 *
 * Exit 2 keeps the cb-21 fatal-frame mapping verbatim and auth-shaped stderr is
 * named explicitly; every other exit keeps the map's own transient/protocol
 * classification. An unexplained exit-0 child is a protocol violation too: a
 * real agy turn reports at least an `init` or `result` frame.
 */
function classifyDeadChild(mapping: ExitCodeMapping, stderr: string): ReturnType<typeof bridgeError> {
  const detail = mapping.message.trim();
  const suffix = detail.length > 0 ? `: ${detail}` : "";
  if (mapping.kind === "CB_TRANSPORT_FATAL_FRAME") {
    return bridgeError(
      "transport",
      "CB_TRANSPORT_FATAL_FRAME",
      `cli-providers: agy exited ${mapping.code} with no stream frame (fatal frame)${suffix}`,
    );
  }
  if (isAgyAuthFailure(stderr)) {
    return bridgeError(
      "transport",
      "CB_TRANSPORT_PROTOCOL",
      `cli-providers: agy authentication required (agy exited ${mapping.code} with no stream frame)${suffix}`,
    );
  }
  const code = isBridgeErrorCode(mapping.kind) ? mapping.kind : "CB_TRANSPORT_PROTOCOL";
  return bridgeError(
    categoryOfCode(code),
    code,
    `cli-providers: agy exited ${mapping.code} with no stream frame${suffix}`,
    { retryable: code === "CB_TRANSPORT_TRANSIENT" },
  );
}

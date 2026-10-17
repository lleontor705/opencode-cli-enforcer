/**
 * agy (Google Antigravity CLI) CliTransport: the raw documented stream-json
 * protocol over stdin/stdout (REQ-CB-AGY-001, design D11/D12).
 *
 * agy has no TypeScript SDK, so the bridge speaks the CLI's documented headless
 * protocol directly:
 *
 *   spawn `agy --input-format stream-json --output-format stream-json`
 *         [`--model <slug>`] [`--conversation <uuid>`] `--print-timeout <duration>`
 *
 * one NDJSON `user` event per stdin line, one NDJSON event per stdout line.
 *
 * Two hard constraints shape this module:
 *
 * - The stdin writer is a *hard filter*, not a formatter. Only `user` events may
 *   ever reach the child: a `control_request`/`control_response` frame or an
 *   in-stream slash command makes agy end the session with exit 2, and a
 *   malformed user frame (missing `message`, unsupported block type, bad JSON)
 *   ends it with exit 1. Writing any of them would doom the child and corrupt the
 *   turn, so the filter throws a classified transport error *before* any byte is
 *   written.
 * - Known headless hang (google-antigravity/antigravity-cli#318): a turn can
 *   stall indefinitely. `--print-timeout` bounds agy's own wait and
 *   {@link AgyTransport.watchdog} bounds the host's, killing the child on expiry.
 *
 * Capability gap kept honest: parsing event *payloads* belongs to the mapper
 * (cb-22). The transport forwards only the three documented event kinds and drops
 * unrecognized ones, matching agy's own forward-compatibility rule for output.
 */

import { spawn as nodeSpawn } from "node:child_process";

import { bridgeError, classifyTransportError, isTransientTransportError } from "../errors/taxonomy.js";
import type {
  CliSpawnRequest,
  CliTransport,
  ExitCodeMapping,
  SpawnedCli,
  TurnRequest,
  Watchdog,
  WatchdogOptions,
} from "../provider/seams.js";

/** Executable the adapter drives. The probe/registry (cb-25) resolves the real path. */
export const AGY_TRANSPORT_DEFAULT_COMMAND = "agy";

/**
 * Provider id stamped on agy session handles. Kept transport-local so this module
 * stays a leaf; the registry (cb-25) is what binds the two together.
 */
const AGY_PROVIDER_ID = "agy";

/**
 * Host-side default for `--print-timeout`. agy's own default drifts across
 * versions (docs: 5m; v1.3.2 `--help`: 0s), so the bridge always passes an
 * explicit value and never relies on the child's default.
 */
export const AGY_DEFAULT_PRINT_TIMEOUT_MS = 300_000;

/** The complete set of stdout events the transport forwards to the mapper. */
const AGY_KNOWN_OUTPUT_EVENTS: ReadonlySet<string> = new Set(["init", "step_update", "result"]);

const MAX_FRAME_PREVIEW = 160;

// ---------------------------------------------------------------------------
// Child-process seam (injectable so the unit tier needs no real process).
// ---------------------------------------------------------------------------

export interface AgyWritableLike {
  write(chunk: string): unknown;
  end(chunk?: string): unknown;
}

export interface AgyReadableLike {
  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>;
}

export interface AgyChildProcessLike {
  readonly pid: number | undefined;
  readonly stdin: AgyWritableLike | null;
  readonly stdout: AgyReadableLike | null;
  readonly stderr: AgyReadableLike | null;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface AgySpawnInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export type AgySpawnFactory = (input: AgySpawnInput) => AgyChildProcessLike;

/** Injectable deadline source so watchdog oracles are deterministic, never wall-clock. */
export interface AgyTimerScheduler {
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface AgyTransportOptions {
  /** Per-turn `--print-timeout`, rendered as a Go duration. Default 5m. */
  readonly printTimeoutMs?: number;
  readonly spawn?: AgySpawnFactory;
  readonly scheduler?: AgyTimerScheduler;
}

function defaultSpawn(input: AgySpawnInput): AgyChildProcessLike {
  const child = nodeSpawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: input.env === undefined ? undefined : { ...input.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return child as unknown as AgyChildProcessLike;
}

const REAL_SCHEDULER: AgyTimerScheduler = {
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => {
    if (handle !== undefined) clearTimeout(handle as NodeJS.Timeout);
  },
};

// ---------------------------------------------------------------------------
// The stdin hard filter.
// ---------------------------------------------------------------------------

export interface AgyUserTextBlock {
  readonly type: "text";
  readonly text: string;
}

export interface AgyUserFrame {
  readonly event: "user";
  readonly message: { readonly content: string | readonly AgyUserTextBlock[] };
}

/**
 * Validate that `frame` is a well-formed agy `user` event and safe to write.
 *
 * Returns the narrowed frame on success; throws a `CB_TRANSPORT_FATAL_FRAME`
 * error on anything agy would treat as fatal, so the caller never writes it.
 */
export function assertWritableAgyFrame(frame: unknown): AgyUserFrame {
  if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
    throw fatalFrame("agy input frame must be a JSON object");
  }
  const record = frame as Record<string, unknown>;
  const event = record.event;
  if (typeof event !== "string" || event.length === 0) {
    throw fatalFrame('agy input frame is missing its "event" discriminator');
  }
  if (event !== "user") {
    throw fatalFrame(
      `agy input event "${event}" is not writable; only "user" events may ever be sent (control frames and slash commands abort the child)`,
    );
  }
  const content = readContent(record.message);
  if (content.startsWith("/")) {
    throw fatalFrame(
      `agy user frame is an in-stream slash command (${preview(content)}); agy answers those outside the event stream and would end the session with exit 2`,
    );
  }
  return frame as AgyUserFrame;
}

function readContent(message: unknown): string {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    throw fatalFrame('agy user frame is missing its "message" object');
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") {
    if (content.length === 0) throw fatalFrame("agy user frame has empty content");
    return content;
  }
  if (Array.isArray(content)) {
    if (content.length === 0) throw fatalFrame("agy user frame has an empty content block array");
    const parts: string[] = [];
    for (const block of content) {
      if (block === null || typeof block !== "object" || Array.isArray(block)) {
        throw fatalFrame("agy user frame content blocks must be objects");
      }
      const record = block as Record<string, unknown>;
      if (record.type !== "text" || typeof record.text !== "string") {
        throw fatalFrame(
          `agy user frame content block type ${JSON.stringify(record.type)} is unsupported; only "text" blocks may be sent`,
        );
      }
      parts.push(record.text);
    }
    return parts.join("");
  }
  throw fatalFrame("agy user frame content must be a string or an array of text blocks");
}

function fatalFrame(message: string): ReturnType<typeof bridgeError> {
  return bridgeError("transport", "CB_TRANSPORT_FATAL_FRAME", `cli-providers: ${message}`);
}

// ---------------------------------------------------------------------------
// The transport.
// ---------------------------------------------------------------------------

export class AgyTransport implements CliTransport {
  private readonly printTimeoutMs: number;
  private readonly spawnProcess: AgySpawnFactory;
  private readonly scheduler: AgyTimerScheduler;

  constructor(options: AgyTransportOptions = {}) {
    this.printTimeoutMs = options.printTimeoutMs ?? AGY_DEFAULT_PRINT_TIMEOUT_MS;
    this.spawnProcess = options.spawn ?? defaultSpawn;
    this.scheduler = options.scheduler ?? REAL_SCHEDULER;
  }

  buildArgv(request: TurnRequest): string[] {
    const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
    const model = request.model.trim();
    if (model.length > 0) args.push("--model", model);
    if (request.session !== undefined) {
      args.push("--conversation", requireAgyConversation(request.session));
    }
    args.push("--print-timeout", formatAgyDuration(this.printTimeoutMs));
    return args;
  }

  async spawn(request: CliSpawnRequest): Promise<SpawnedCli> {
    let child: AgyChildProcessLike;
    try {
      child = this.spawnProcess({
        command: request.command,
        args: [...request.args],
        cwd: request.cwd,
        env: request.env,
      });
    } catch (cause) {
      throw bridgeError(
        "transport",
        "CB_TRANSPORT_SPAWN_FAILED",
        `cli-providers: agy spawn failed: ${describe(cause)}`,
        { cause },
      );
    }
    return new AgySpawnedCli(child);
  }

  async writeFrame(cli: SpawnedCli, frame: unknown): Promise<void> {
    const writable = assertWritableAgyFrame(frame);
    await cli.writeLine(JSON.stringify(writable));
  }

  readLines(cli: SpawnedCli): AsyncIterable<string> {
    return this.iterateKnownOutputEvents(cli);
  }

  captureStderr(cli: SpawnedCli): Promise<string> {
    return cli.stderrText();
  }

  mapExitCode(code: number, stderr: string): ExitCodeMapping {
    const detail = stderr.trim();
    if (code === 0) {
      return { code, kind: "ok", fatal: false, message: detail.length > 0 ? detail : "agy exited 0" };
    }
    if (code === 2) {
      return {
        code,
        kind: "CB_TRANSPORT_FATAL_FRAME",
        fatal: true,
        message:
          detail.length > 0
            ? detail
            : "agy protocol violation: fatal frame (control_request/control_response or in-stream slash command)",
      };
    }
    const transient = isTransientTransportError({ code, message: detail });
    return {
      code,
      kind: transient ? "CB_TRANSPORT_TRANSIENT" : "CB_TRANSPORT_PROTOCOL",
      fatal: true,
      message: detail.length > 0 ? detail : `agy exited ${code}`,
    };
  }

  watchdog(cli: SpawnedCli, options: WatchdogOptions): Watchdog {
    let handle: unknown;
    let armed = false;

    const fire = (): void => {
      armed = false;
      handle = undefined;
      options.onTimeout(options.timeoutMs);
      cli.kill();
    };

    const watchdog: Watchdog = {
      arm: (): void => {
        if (armed) return;
        armed = true;
        handle = this.scheduler.setTimer(fire, options.timeoutMs);
        // A child that exits on its own must not leave a stray deadline behind.
        void cli.exitCode().then(() => watchdog.disarm());
      },
      disarm: (): void => {
        if (!armed) return;
        armed = false;
        if (handle !== undefined) this.scheduler.clearTimer(handle);
        handle = undefined;
      },
    };
    return watchdog;
  }

  private async *iterateKnownOutputEvents(cli: SpawnedCli): AsyncIterable<string> {
    for await (const line of cli.stdoutLines()) {
      if (line.trim().length === 0) continue;
      const event = readOutputEventName(line);
      if (!AGY_KNOWN_OUTPUT_EVENTS.has(event)) continue;
      yield line;
    }
  }
}

function requireAgyConversation(session: TurnRequest["session"]): string {
  if (session === undefined) {
    throw bridgeError("transport", "CB_TRANSPORT_PROTOCOL", "cli-providers: no session handle to resume");
  }
  if (session.provider !== AGY_PROVIDER_ID) {
    throw bridgeError(
      "transport",
      "CB_TRANSPORT_PROTOCOL",
      `cli-providers: agy transport cannot resume a "${session.provider}" session handle`,
    );
  }
  if (typeof session.conversationRef !== "string" || session.conversationRef.length === 0) {
    throw bridgeError(
      "transport",
      "CB_TRANSPORT_PROTOCOL",
      "cli-providers: agy session handle has an empty conversationRef",
    );
  }
  return session.conversationRef;
}

function readOutputEventName(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw bridgeError(
      "transport",
      "CB_TRANSPORT_PROTOCOL",
      `cli-providers: agy stdout frame is not valid JSON: ${preview(line)}`,
      { cause },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw bridgeError(
      "transport",
      "CB_TRANSPORT_PROTOCOL",
      `cli-providers: agy stdout frame is not a JSON object: ${preview(line)}`,
    );
  }
  const event = (parsed as { event?: unknown }).event;
  if (typeof event !== "string" || event.length === 0) {
    throw bridgeError(
      "transport",
      "CB_TRANSPORT_PROTOCOL",
      `cli-providers: agy stdout frame is missing its "event" discriminator: ${preview(line)}`,
    );
  }
  return event;
}

/** Render a millisecond budget as a Go duration (`0`, `1500ms`, `300s`, …). */
export function formatAgyDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

// ---------------------------------------------------------------------------
// Default SpawnedCli over a structural child process.
// ---------------------------------------------------------------------------

class AgySpawnedCli implements SpawnedCli {
  readonly pid: number | undefined;
  private readonly child: AgyChildProcessLike;
  private readonly exit: Promise<number>;
  private readonly capturedStderr: Promise<string>;
  private terminalError: Error | undefined;

  constructor(child: AgyChildProcessLike) {
    this.child = child;
    this.pid = child.pid;
    this.exit = new Promise<number>((resolve) => {
      child.once("exit", (code) => resolve(normalizeExitCode(code)));
      child.once("error", (error) => {
        this.terminalError = error;
        resolve(1);
      });
    });
    this.capturedStderr = readAllText(child.stderr);
  }

  async writeLine(line: string): Promise<void> {
    const stdin = this.child.stdin;
    if (stdin === null) {
      throw bridgeError("transport", "CB_TRANSPORT_PROTOCOL", "cli-providers: agy child has no stdin pipe");
    }
    try {
      stdin.write(line.endsWith("\n") ? line : `${line}\n`);
    } catch (cause) {
      throw classifyTransportError(cause);
    }
  }

  async endInput(): Promise<void> {
    const stdin = this.child.stdin;
    if (stdin === null) return;
    try {
      stdin.end();
    } catch (cause) {
      throw classifyTransportError(cause);
    }
  }

  stdoutLines(): AsyncIterable<string> {
    return splitLines(this.child.stdout ?? EMPTY_READABLE);
  }

  async stderrText(): Promise<string> {
    const captured = await this.capturedStderr;
    if (this.terminalError !== undefined && !captured.includes(this.terminalError.message)) {
      return captured.length > 0 ? `${captured}\n${this.terminalError.message}` : this.terminalError.message;
    }
    return captured;
  }

  exitCode(): Promise<number> {
    return this.exit;
  }

  kill(signal?: NodeJS.Signals): void {
    try {
      this.child.kill(signal);
    } catch {
      // A child that already exited rejects kill; nothing left to terminate.
    }
  }
}

const EMPTY_READABLE: AgyReadableLike = {
  async *[Symbol.asyncIterator]() {
    // No stdout pipe: an empty stream, never a hang.
  },
};

async function* splitLines(source: AsyncIterable<string | Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of source) {
    buffered += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      yield stripCarriageReturn(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
  }
  buffered += decoder.decode();
  if (buffered.length > 0) yield stripCarriageReturn(buffered);
}

async function readAllText(source: AsyncIterable<string | Uint8Array> | null): Promise<string> {
  if (source === null) return "";
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of source) {
    text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function normalizeExitCode(code: number | null): number {
  // Signal-terminated children report a null code; surface a nonzero failure.
  return typeof code === "number" ? code : 128;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name;
  return typeof error === "string" && error.length > 0 ? error : "unknown error";
}

function preview(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_FRAME_PREVIEW ? `${trimmed.slice(0, MAX_FRAME_PREVIEW)}…` : trimmed;
}

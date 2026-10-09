/**
 * Deterministic oracle for the agy CliTransport (REQ-CB-AGY-001, design D11/D12).
 *
 * Proves the transport against the documented agy headless stream-json protocol
 * without a real child process:
 *  1. argv requests `--input-format stream-json --output-format stream-json`,
 *     pins the model, resumes an exact `--conversation <uuid>`, and always emits an
 *     explicit `--print-timeout` (agy's own default drifts between versions).
 *  2. The stdin writer is a hard filter: `control_request`/`control_response`
 *     frames, in-stream slash commands, and malformed user frames throw a
 *     `CB_TRANSPORT_FATAL_FRAME` classification *before* any byte is written,
 *     while well-formed `user` events are serialized as one NDJSON line each.
 *  3. The line reader JSON-parses each stdout line, forwards only the three
 *     documented events, drops unrecognized ones (agy's output forward-compat
 *     rule), flushes a trailing line without a newline, and fails loud on a
 *     framing violation.
 *  4. stderr is captured whole and exit codes resolve (signal termination -> 128).
 *  5. `mapExitCode(2)` maps to the fatal-frame class.
 *  6. The watchdog is deadline-driven and deterministic: an injected scheduler
 *     fires it, it kills the child, disarms cleanly, and auto-disarms on exit.
 *
 * The real-CLI tier only runs with `AGY_BRIDGE_INTEGRATION=1` and a discoverable
 * `agy`; otherwise it skips clean, naming the operator action.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { BridgeError } from "../../src/errors/taxonomy.ts";
import type { AgyChildProcessLike, AgyReadableLike, AgyTimerScheduler, AgyTransportOptions } from "../../src/agy/transport.ts";
import {
  AGY_DEFAULT_PRINT_TIMEOUT_MS,
  AGY_TRANSPORT_DEFAULT_COMMAND,
  AgyTransport,
  assertWritableAgyFrame,
  formatAgyDuration,
} from "../../src/agy/transport.ts";
import type { CliTransport } from "../../src/provider/seams.ts";

// ---------------------------------------------------------------------------
// Fake child process: the unit tier's only child, never a real one.
// ---------------------------------------------------------------------------

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;

class FakeWritable {
  readonly writes: string[] = [];
  ended = false;

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }

  end(chunk?: string): unknown {
    if (typeof chunk === "string") this.writes.push(chunk);
    this.ended = true;
    return this;
  }
}

function readableFrom(chunks: readonly (string | Uint8Array)[]): AgyReadableLike {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

class FakeChild implements AgyChildProcessLike {
  readonly pid = 4242;
  readonly stdin = new FakeWritable();
  readonly stdout: AgyReadableLike | null;
  readonly stderr: AgyReadableLike | null;
  killed = false;
  readonly killSignals: (NodeJS.Signals | undefined)[] = [];

  private readonly exitListeners: ExitListener[] = [];
  private readonly errorListeners: ErrorListener[] = [];

  constructor(options: { stdout?: readonly (string | Uint8Array)[]; stderr?: readonly (string | Uint8Array)[] } = {}) {
    this.stdout = options.stdout === undefined ? null : readableFrom(options.stdout);
    this.stderr = options.stderr === undefined ? null : readableFrom(options.stderr);
  }

  once(event: "exit", listener: ExitListener): unknown;
  once(event: "error", listener: ErrorListener): unknown;
  once(event: "exit" | "error", listener: ExitListener | ErrorListener): unknown {
    if (event === "exit") this.exitListeners.push(listener as ExitListener);
    else this.errorListeners.push(listener as ErrorListener);
    return this;
  }

  emitExit(code: number | null): void {
    for (const listener of [...this.exitListeners]) listener(code, null);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.killSignals.push(signal);
    return true;
  }
}

interface FakeScheduler {
  readonly api: AgyTimerScheduler;
  fireAll(): void;
  active(): number;
}

function createFakeScheduler(): FakeScheduler {
  const timers: { id: number; callback: () => void; cleared: boolean }[] = [];
  let nextId = 1;
  return {
    api: {
      setTimer(callback) {
        const id = nextId++;
        timers.push({ id, callback, cleared: false });
        return id;
      },
      clearTimer(handle) {
        const timer = timers.find((candidate) => candidate.id === handle);
        if (timer !== undefined) timer.cleared = true;
      },
    },
    fireAll() {
      for (const timer of [...timers]) {
        if (timer.cleared) continue;
        timer.cleared = true;
        timer.callback();
      }
    },
    active() {
      return timers.filter((timer) => !timer.cleared).length;
    },
  };
}

function transportWith(child: AgyChildProcessLike, options: AgyTransportOptions = {}): AgyTransport {
  return new AgyTransport({ spawn: () => child, ...options });
}

async function collectLines(iterable: AsyncIterable<string>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of iterable) lines.push(line);
  return lines;
}

function isBridgeCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof BridgeError && error.code === code;
}

const INIT_LINE = JSON.stringify({ event: "init", conversation_id: "c1", init: { tools: ["read"] } });
const STEP_LINE = JSON.stringify({ event: "step_update", step_update: { state: "ACTIVE", text_delta: "hi" } });
const RESULT_LINE = JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "hi" } });
const UNKNOWN_LINE = JSON.stringify({ event: "future_thing", future: true });

// ---------------------------------------------------------------------------
// 1. Seam conformance + argv builder.
// ---------------------------------------------------------------------------

describe("REQ-CB-AGY-001 agy CliTransport argv", () => {
  it("TestREQ_CB_AGY_001_transport_implements_cli_transport_seam", () => {
    const transport: CliTransport = new AgyTransport();
    assert.equal(typeof transport.buildArgv, "function");
    assert.equal(typeof transport.spawn, "function");
    assert.equal(typeof transport.writeFrame, "function");
    assert.equal(typeof transport.readLines, "function");
    assert.equal(typeof transport.captureStderr, "function");
    assert.equal(typeof transport.mapExitCode, "function");
    assert.equal(typeof transport.watchdog, "function");
    assert.equal(AGY_TRANSPORT_DEFAULT_COMMAND, "agy");
    assert.equal(AGY_DEFAULT_PRINT_TIMEOUT_MS, 300_000);
  });

  it("TestREQ_CB_AGY_001_build_argv_requests_stream_json_and_print_timeout", () => {
    assert.deepEqual(new AgyTransport().buildArgv({ model: "" }), [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "300s",
    ]);
  });

  it("TestREQ_CB_AGY_001_build_argv_pins_model_when_set", () => {
    assert.deepEqual(new AgyTransport().buildArgv({ model: "gemini-3.8-flash-medium" }), [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--model",
      "gemini-3.8-flash-medium",
      "--print-timeout",
      "300s",
    ]);
  });

  it("TestREQ_CB_AGY_001_build_argv_resumes_exact_conversation_by_id", () => {
    assert.deepEqual(
      new AgyTransport().buildArgv({ model: "m", session: { provider: "agy", conversationRef: "conv-abc" } }),
      [
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--model",
        "m",
        "--conversation",
        "conv-abc",
        "--print-timeout",
        "300s",
      ],
    );
  });

  it("TestREQ_CB_AGY_001_build_argv_rejects_foreign_session_handle", () => {
    assert.throws(
      () => new AgyTransport().buildArgv({ model: "m", session: { provider: "claude", conversationRef: "x" } }),
      isBridgeCode("CB_TRANSPORT_PROTOCOL"),
    );
  });

  it("TestREQ_CB_AGY_001_build_argv_renders_configured_print_timeout", () => {
    const argv = new AgyTransport({ printTimeoutMs: 1500 }).buildArgv({ model: "m" });
    assert.equal(argv[argv.length - 2], "--print-timeout");
    assert.equal(argv[argv.length - 1], "1500ms");
  });

  it("TestREQ_CB_AGY_001_format_duration_renders_go_durations", () => {
    assert.equal(formatAgyDuration(0), "0s");
    assert.equal(formatAgyDuration(-5), "0s");
    assert.equal(formatAgyDuration(300_000), "300s");
    assert.equal(formatAgyDuration(1500), "1500ms");
  });
});

// ---------------------------------------------------------------------------
// 2. The stdin hard filter.
// ---------------------------------------------------------------------------

describe("REQ-CB-AGY-001 agy CliTransport stdin hard filter", () => {
  it("TestREQ_CB_AGY_001_write_frame_rejects_control_request_without_writing", async () => {
    const child = new FakeChild();
    const transport = transportWith(child);
    const cli = await transport.spawn({ command: "agy", args: [] });

    // A benign-looking payload isolates the rejection to the event kind itself,
    // so removing the user-only check would let this frame through and fail.
    await assert.rejects(
      transport.writeFrame(cli, { event: "control_request", message: { content: "hello" } }),
      isBridgeCode("CB_TRANSPORT_FATAL_FRAME"),
    );
    assert.deepEqual(child.stdin.writes, [], "a blocked frame must never reach the child");
  });

  it("TestREQ_CB_AGY_001_write_frame_rejects_control_response", async () => {
    const child = new FakeChild();
    const transport = transportWith(child);
    const cli = await transport.spawn({ command: "agy", args: [] });

    await assert.rejects(
      transport.writeFrame(cli, { event: "control_response", message: { content: "hello" } }),
      isBridgeCode("CB_TRANSPORT_FATAL_FRAME"),
    );
    assert.deepEqual(child.stdin.writes, []);
  });

  it("TestREQ_CB_AGY_001_write_frame_rejects_in_stream_slash_command", async () => {
    const child = new FakeChild();
    const transport = transportWith(child);
    const cli = await transport.spawn({ command: "agy", args: [] });

    await assert.rejects(
      transport.writeFrame(cli, { event: "user", message: { content: "/model" } }),
      isBridgeCode("CB_TRANSPORT_FATAL_FRAME"),
    );
    await assert.rejects(
      transport.writeFrame(cli, { event: "user", message: { content: [{ type: "text", text: "/usage" }] } }),
      isBridgeCode("CB_TRANSPORT_FATAL_FRAME"),
    );
    assert.deepEqual(child.stdin.writes, []);
  });

  it("TestREQ_CB_AGY_001_write_frame_rejects_malformed_user_frames", () => {
    const malformed = [
      null,
      "{}",
      { event: "user" },
      { event: "user", message: {} },
      { event: "user", message: { content: "" } },
      { event: "user", message: { content: [] } },
      { event: "user", message: { content: [{ type: "image", text: "x" }] } },
      { event: "user", message: { content: [{ type: "text" }] } },
      { event: "user", message: { content: 42 } },
      { event: "", message: { content: "hi" } },
      { message: { content: "hi" } },
    ];
    for (const frame of malformed) {
      assert.throws(() => assertWritableAgyFrame(frame), isBridgeCode("CB_TRANSPORT_FATAL_FRAME"), `frame ${JSON.stringify(frame)}`);
    }
  });

  it("TestREQ_CB_AGY_001_write_frame_writes_user_events_as_ndjson", async () => {
    const child = new FakeChild();
    const transport = transportWith(child);
    const cli = await transport.spawn({ command: "agy", args: [] });

    await transport.writeFrame(cli, { event: "user", message: { content: "hello" } });
    await transport.writeFrame(cli, {
      event: "user",
      message: {
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    });

    assert.deepEqual(child.stdin.writes, [
      '{"event":"user","message":{"content":"hello"}}\n',
      '{"event":"user","message":{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}}\n',
    ]);
  });

  it("TestREQ_CB_AGY_001_assert_writable_frame_narrows_valid_events", () => {
    const frame = assertWritableAgyFrame({ event: "user", message: { content: [{ type: "text", text: "ok" }] } });
    assert.equal(frame.event, "user");
  });
});

// ---------------------------------------------------------------------------
// 3. The stdout line reader.
// ---------------------------------------------------------------------------

describe("REQ-CB-AGY-001 agy CliTransport stdout reader", () => {
  it("TestREQ_CB_AGY_001_read_lines_forwards_known_events_and_skips_unknown", async () => {
    const child = new FakeChild({ stdout: [`${INIT_LINE}\n${UNKNOWN_LINE}\n${STEP_LINE}\n${RESULT_LINE}\n`] });
    const transport = transportWith(child);
    const cli = await transport.spawn({ command: "agy", args: [] });

    assert.deepEqual(await collectLines(transport.readLines(cli)), [INIT_LINE, STEP_LINE, RESULT_LINE]);
  });

  it("TestREQ_CB_AGY_001_read_lines_flushes_trailing_line_without_newline", async () => {
    const child = new FakeChild({ stdout: [`${INIT_LINE}\n`, RESULT_LINE] });
    const transport = transportWith(child);
    const cli = await transport.spawn({ command: "agy", args: [] });

    assert.deepEqual(await collectLines(transport.readLines(cli)), [INIT_LINE, RESULT_LINE]);
  });

  it("TestREQ_CB_AGY_001_read_lines_strips_carriage_returns_and_blank_lines", async () => {
    const child = new FakeChild({ stdout: [`\r\n${INIT_LINE}\r\n\r\n${RESULT_LINE}\r\n`] });
    const transport = transportWith(child);
    const cli = await transport.spawn({ command: "agy", args: [] });

    assert.deepEqual(await collectLines(transport.readLines(cli)), [INIT_LINE, RESULT_LINE]);
  });

  it("TestREQ_CB_AGY_001_read_lines_fails_loud_on_malformed_frame", async () => {
    const child = new FakeChild({ stdout: ["not json\n"] });
    const transport = transportWith(child);
    const cli = await transport.spawn({ command: "agy", args: [] });

    await assert.rejects(collectLines(transport.readLines(cli)), isBridgeCode("CB_TRANSPORT_PROTOCOL"));
  });

  it("TestREQ_CB_AGY_001_read_lines_fails_loud_on_missing_event_discriminator", async () => {
    const child = new FakeChild({ stdout: ['{"payload":1}\n'] });
    const transport = transportWith(child);
    const cli = await transport.spawn({ command: "agy", args: [] });

    await assert.rejects(collectLines(transport.readLines(cli)), isBridgeCode("CB_TRANSPORT_PROTOCOL"));
  });
});

// ---------------------------------------------------------------------------
// 4. stderr capture and exit codes.
// ---------------------------------------------------------------------------

describe("REQ-CB-AGY-001 agy CliTransport stderr and exit", () => {
  it("TestREQ_CB_AGY_001_capture_stderr_returns_all_chunks", async () => {
    const child = new FakeChild({ stderr: ["warn one\n", "warn two\n"] });
    const transport = transportWith(child);
    const cli = await transport.spawn({ command: "agy", args: [] });

    assert.equal(await transport.captureStderr(cli), "warn one\nwarn two\n");
  });

  it("TestREQ_CB_AGY_001_exit_code_resolves_and_maps_signal_to_128", async () => {
    const child = new FakeChild();
    const cli = await transportWith(child).spawn({ command: "agy", args: [] });
    child.emitExit(2);
    assert.equal(await cli.exitCode(), 2);

    const signalled = new FakeChild();
    const signalledCli = await transportWith(signalled).spawn({ command: "agy", args: [] });
    signalled.emitExit(null);
    assert.equal(await signalledCli.exitCode(), 128);
  });

  it("TestREQ_CB_AGY_001_spawn_failure_is_classified", async () => {
    const transport = new AgyTransport({
      spawn: () => {
        throw new Error("spawn agy ENOENT");
      },
    });
    await assert.rejects(transport.spawn({ command: "agy", args: [] }), isBridgeCode("CB_TRANSPORT_SPAWN_FAILED"));
  });
});

// ---------------------------------------------------------------------------
// 5. Exit-code mapping.
// ---------------------------------------------------------------------------

describe("REQ-CB-AGY-001 agy CliTransport exit-code map", () => {
  it("TestREQ_CB_AGY_001_map_exit_code_zero_is_clean", () => {
    assert.deepEqual(new AgyTransport().mapExitCode(0, ""), {
      code: 0,
      kind: "ok",
      fatal: false,
      message: "agy exited 0",
    });
  });

  it("TestREQ_CB_AGY_001_map_exit_code_two_is_fatal_frame", () => {
    const mapping = new AgyTransport().mapExitCode(2, "control_request is not supported");
    assert.equal(mapping.code, 2);
    assert.equal(mapping.kind, "CB_TRANSPORT_FATAL_FRAME");
    assert.equal(mapping.fatal, true);
    assert.match(mapping.message, /control_request/);
  });

  it("TestREQ_CB_AGY_001_map_exit_code_two_without_stderr_names_the_protocol_violation", () => {
    const mapping = new AgyTransport().mapExitCode(2, "   ");
    assert.match(mapping.message, /protocol violation/i);
  });

  it("TestREQ_CB_AGY_001_map_exit_code_one_is_protocol", () => {
    const mapping = new AgyTransport().mapExitCode(1, "");
    assert.equal(mapping.kind, "CB_TRANSPORT_PROTOCOL");
    assert.equal(mapping.fatal, true);
  });
});

// ---------------------------------------------------------------------------
// 6. Watchdog: injected deadline, deterministic.
// ---------------------------------------------------------------------------

describe("REQ-CB-AGY-001 agy CliTransport watchdog", () => {
  it("TestREQ_CB_AGY_001_watchdog_fires_on_stall_and_kills_child", async () => {
    const scheduler = createFakeScheduler();
    const child = new FakeChild();
    const transport = new AgyTransport({ spawn: () => child, scheduler: scheduler.api });
    const cli = await transport.spawn({ command: "agy", args: [] });

    const observed: number[] = [];
    const watchdog = transport.watchdog(cli, {
      timeoutMs: 1000,
      onTimeout: (ms) => observed.push(ms),
    });

    watchdog.arm();
    assert.equal(scheduler.active(), 1, "arming must schedule exactly one deadline");
    watchdog.arm();
    assert.equal(scheduler.active(), 1, "re-arming must be idempotent");

    scheduler.fireAll();
    assert.deepEqual(observed, [1000]);
    assert.equal(child.killed, true);
    assert.equal(scheduler.active(), 0);
  });

  it("TestREQ_CB_AGY_001_watchdog_disarm_prevents_fire", async () => {
    const scheduler = createFakeScheduler();
    const child = new FakeChild();
    const transport = new AgyTransport({ spawn: () => child, scheduler: scheduler.api });
    const cli = await transport.spawn({ command: "agy", args: [] });

    const observed: number[] = [];
    const watchdog = transport.watchdog(cli, { timeoutMs: 250, onTimeout: (ms) => observed.push(ms) });
    watchdog.arm();
    watchdog.disarm();
    assert.equal(scheduler.active(), 0);

    scheduler.fireAll();
    assert.deepEqual(observed, []);
    assert.equal(child.killed, false);
  });

  it("TestREQ_CB_AGY_001_watchdog_auto_disarms_when_child_exits", async () => {
    const scheduler = createFakeScheduler();
    const child = new FakeChild();
    const transport = new AgyTransport({ spawn: () => child, scheduler: scheduler.api });
    const cli = await transport.spawn({ command: "agy", args: [] });

    const observed: number[] = [];
    const watchdog = transport.watchdog(cli, { timeoutMs: 1000, onTimeout: (ms) => observed.push(ms) });
    watchdog.arm();

    child.emitExit(0);
    await cli.exitCode();
    assert.equal(scheduler.active(), 0, "a completed child must cancel its deadline");

    scheduler.fireAll();
    assert.deepEqual(observed, []);
    assert.equal(child.killed, false);
  });
});

// ---------------------------------------------------------------------------
// 7. Real-CLI smoke: gated, skip-clean, read-only.
// ---------------------------------------------------------------------------

function commandPath(command: string): string | null {
  const probe = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout.trim().length > 0 ? probe.stdout.trim() : null;
}

async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`oracle deadline exceeded (${ms}ms): ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const AGY_PATH = commandPath("agy");
const LIVE_ENABLED = process.env.AGY_BRIDGE_INTEGRATION === "1" && AGY_PATH !== null;
const SKIP_LIVE = LIVE_ENABLED
  ? false
  : `agy live smoke skipped (AGY_BRIDGE_INTEGRATION=${process.env.AGY_BRIDGE_INTEGRATION ?? "unset"}, ` +
    `agy=${AGY_PATH ?? "absent"}) — operator action: install agy and re-run with AGY_BRIDGE_INTEGRATION=1`;

describe("REQ-CB-AGY-001 agy CliTransport live smoke", () => {
  it("TestREQ_CB_AGY_001_transport_real_cli_help_exits_zero", { skip: SKIP_LIVE }, async () => {
    const transport = new AgyTransport();
    const cli = await transport.spawn({ command: AGY_PATH ?? "agy", args: ["--help"] });

    for await (const _line of cli.stdoutLines()) {
      // Drain the usage text; `--help` is not an event stream.
    }
    const stderr = await transport.captureStderr(cli);
    const code = await withDeadline(cli.exitCode(), 20_000, "agy --help exit");

    assert.equal(code, 0, `agy --help must exit 0 (stderr: ${stderr})`);
  });
});

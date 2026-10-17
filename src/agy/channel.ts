/**
 * agy (Google Antigravity CLI) ToolChannel, PermissionPolicy and SteeringPolicy
 * (REQ-CB-AGY-001, design D11/D12).
 *
 * agy has no in-process tool rendezvous: unlike the Claude Agent SDK it cannot
 * call back into a parked host handler. Host tools therefore reach it through a
 * stdio MCP server that agy spawns from its own config, and each result returns
 * inside the `call_mcp_tool` response. This module builds that server from the
 * cb-06 `createToolServer` (so tool schemas reach the wire verbatim), produces
 * the registration manifest, and derives the two capability-honest policy seams:
 *
 * - PermissionPolicy: `supportsInteractiveApproval = false`. There is no
 *   canUseTool callback, so approval cannot be interactive. Enforcement is
 *   declarative (settings.json allow rules) plus an explicit
 *   `--dangerously-skip-permissions` consent flag. Without consent the bypass
 *   flag is never emitted, and a tool absent from the allow rules is denied at
 *   the MCP boundary rather than silently executed.
 * - SteeringPolicy: `supportsMidTurnSteer = false`. A mid-turn steer is queued
 *   and injected as the next `user` frame at the turn boundary; it is never
 *   silently dropped.
 *
 * Registration scoping, probed read-only against agy v1.3.2: `agy mcp add`
 * writes a single user-level file (`~/.gemini/config/mcp_config.json`) and has no
 * per-project flag — a project-local `.gemini/config/mcp_config.json` is ignored.
 * Because that mutation is machine-global, registration defaults to a dry-run
 * manifest and only runs when `allowUserLevelRegistration` is explicitly set.
 */

import { spawn as nodeSpawn } from "node:child_process";

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { bridgeError } from "../errors/taxonomy.js";
import { createToolServer } from "../mcp/server.js";
import type { HostToolServer, McpToolDef } from "../mcp/server.js";
import type { ToolResult, ToolTextContent } from "../mcp/rendezvous.js";
import type { HostTool, PermissionPolicy, SteeringPolicy, ToolChannel } from "../provider/seams.js";

// ---------------------------------------------------------------------------
// Namespacing and config paths
// ---------------------------------------------------------------------------

/**
 * Defensive default namespace. agy's MCP config is user-level and shared with
 * any other server the operator registered (`fs`, `github`, …), so a bare name
 * could collide; `opencode-host` names the owner explicitly.
 */
export const AGY_MCP_SERVER_DEFAULT_NAME = "opencode-host";

export const AGY_MCP_CONFIG_PATH_HINT = "~/.gemini/config/mcp_config.json";
export const AGY_SETTINGS_PATH_HINT = "~/.gemini/antigravity-cli/settings.json";

/** argv the transport appends only under explicit operator consent. */
export const AGY_PERMISSION_BYPASS_FLAG = "--dangerously-skip-permissions";

/** Server-qualified tool id, matching agy's `mcp__<server>__<name>` convention. */
export function qualifiedToolName(serverName: string, toolName: string): string {
  return `${serverName}__${toolName}`;
}

// ---------------------------------------------------------------------------
// Registration manifest and registrar
// ---------------------------------------------------------------------------

export interface AgyToolEntry {
  readonly name: string;
  readonly qualifiedName: string;
  readonly description: string;
  /** The host's schema, forwarded verbatim; never rewritten. */
  readonly inputSchema: unknown;
}

export interface AgyMcpRegistration {
  readonly scope: "user";
  readonly mechanism: "agy-mcp-add";
  readonly configPathHint: string;
  readonly runnerCommand: readonly string[];
  /** Full `agy mcp add …` argv; empty when no runner command is configured. */
  readonly argv: readonly string[];
  readonly applied: boolean;
  readonly reason: string;
}

export interface AgyToolManifest {
  readonly serverName: string;
  readonly transport: "stdio";
  readonly tools: readonly AgyToolEntry[];
  readonly registration: AgyMcpRegistration;
}

export interface AgyMcpRegistrationRequest {
  readonly serverName: string;
  readonly runnerCommand: readonly string[];
}

export interface AgyMcpRegistrar {
  register(request: AgyMcpRegistrationRequest): Promise<void>;
}

export function buildAgyMcpAddArgv(request: AgyMcpRegistrationRequest): string[] {
  return ["mcp", "add", "--type", "stdio", request.serverName, ...request.runnerCommand];
}

/** Default registrar: drives the real `agy` binary (never used unless opted in). */
export function createAgyMcpRegistrar(command = "agy"): AgyMcpRegistrar {
  return {
    register: (request) => runAgyMcpAdd(command, request),
  };
}

async function runAgyMcpAdd(command: string, request: AgyMcpRegistrationRequest): Promise<void> {
  const argv = buildAgyMcpAddArgv(request);
  await new Promise<void>((resolve, reject) => {
    const child = nodeSpawn(command, argv, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: unknown) => {
      stderr += String(chunk);
    });
    child.once("error", (cause: Error) => {
      reject(
        bridgeError(
          "transport",
          "CB_TRANSPORT_SPAWN_FAILED",
          `cli-providers: agy mcp add failed to spawn: ${cause.message}`,
          { cause },
        ),
      );
    });
    child.once("exit", (code: number | null) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim();
      reject(
        bridgeError(
          "transport",
          "CB_TRANSPORT_PROTOCOL",
          `cli-providers: agy mcp add exited ${code}${detail.length > 0 ? `: ${detail}` : ""}`,
        ),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// PermissionPolicy
// ---------------------------------------------------------------------------

export interface AgyPermissionPolicyOptions {
  /** `providers.agy.dangerouslySkipPermissionsConsent` from the resolved config. */
  readonly dangerouslySkipPermissionsConsent?: boolean;
  /** Declarative allow list, the agy analogue of Claude's `toolsAllow`. */
  readonly allowToolNames?: readonly string[];
  readonly settingsPathHint?: string;
}

export interface AgyPermissionEnforcement {
  readonly supportsInteractiveApproval: false;
  readonly strategy: "declarative-allow-rules";
  readonly settingsPathHint: string;
  readonly allowToolNames: readonly string[];
  readonly bypassConsent: boolean;
  /** Flags the transport must pass; the bypass flag appears only under consent. */
  readonly argvFlags: readonly string[];
}

export class AgyPermissionPolicy implements PermissionPolicy {
  readonly supportsInteractiveApproval = false;

  private readonly consent: boolean;
  private readonly allow: ReadonlySet<string>;
  private readonly settingsPathHint: string;

  constructor(options: AgyPermissionPolicyOptions = {}) {
    this.consent = options.dangerouslySkipPermissionsConsent === true;
    this.allow = new Set(options.allowToolNames ?? []);
    this.settingsPathHint = options.settingsPathHint ?? AGY_SETTINGS_PATH_HINT;
  }

  /**
   * Fail-closed declarative gate. Consent is the only path that widens execution
   * beyond the configured allow list; the default policy allows nothing.
   */
  toolAllowed(name: string): boolean {
    return this.consent || this.allow.has(name);
  }

  deriveEnforcement(): AgyPermissionEnforcement {
    return {
      supportsInteractiveApproval: false,
      strategy: "declarative-allow-rules",
      settingsPathHint: this.settingsPathHint,
      allowToolNames: [...this.allow],
      bypassConsent: this.consent,
      argvFlags: this.consent ? [AGY_PERMISSION_BYPASS_FLAG] : [],
    };
  }
}

// ---------------------------------------------------------------------------
// SteeringPolicy
// ---------------------------------------------------------------------------

/** A steer rendered as the only frame agy accepts on stdin: a text `user` event. */
export interface AgySteerFrame {
  readonly event: "user";
  readonly message: { readonly content: string };
}

export class AgySteeringPolicy implements SteeringPolicy {
  readonly supportsMidTurnSteer = false;

  private readonly queue: string[] = [];
  private turnActive = false;

  beginTurn(): void {
    this.turnActive = true;
  }

  endTurn(): void {
    this.turnActive = false;
  }

  get isTurnActive(): boolean {
    return this.turnActive;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  /**
   * Queue a steer. agy cannot consume one mid-turn, so it is always buffered —
   * never dropped and never written into a live turn.
   */
  steer(text: string): void {
    if (text.trim().length === 0) {
      throw bridgeError(
        "stream",
        "CB_STREAM_UNSENDABLE_PROMPT",
        "cli-providers: agy steer must not be empty",
      );
    }
    this.queue.push(text);
  }

  /**
   * Turn boundary: drain queued steers in FIFO order as the frames to inject
   * before the next turn. Draining is the caller's boundary signal; an empty
   * result is the normal no-steer case.
   */
  drainAtBoundary(): readonly AgySteerFrame[] {
    const frames = this.queue.map((text): AgySteerFrame => ({
      event: "user",
      message: { content: text },
    }));
    this.queue.length = 0;
    return frames;
  }
}

// ---------------------------------------------------------------------------
// ToolChannel
// ---------------------------------------------------------------------------

export interface AgyToolChannelOptions {
  readonly serverName?: string;
  readonly permission?: AgyPermissionPolicy;
  /** Command agy should spawn to serve the MCP server over stdio. */
  readonly runnerCommand?: readonly string[];
  /** Explicit opt-in to mutate user-level agy config; default false (dry-run). */
  readonly allowUserLevelRegistration?: boolean;
  readonly registrar?: AgyMcpRegistrar;
  readonly configPathHint?: string;
}

export class AgyToolChannel implements ToolChannel {
  readonly serverName: string;

  private readonly permission: AgyPermissionPolicy;
  private readonly runnerCommand: readonly string[];
  private readonly allowUserLevelRegistration: boolean;
  private readonly registrar: AgyMcpRegistrar;
  private readonly configPathHint: string;

  private server: HostToolServer | null = null;
  private manifestValue: AgyToolManifest | null = null;

  constructor(options: AgyToolChannelOptions = {}) {
    this.serverName = requireNonEmpty(options.serverName ?? AGY_MCP_SERVER_DEFAULT_NAME, "agy MCP server name");
    this.permission = options.permission ?? new AgyPermissionPolicy();
    this.runnerCommand = [...(options.runnerCommand ?? [])];
    this.allowUserLevelRegistration = options.allowUserLevelRegistration === true;
    this.registrar = options.registrar ?? createAgyMcpRegistrar();
    this.configPathHint = options.configPathHint ?? AGY_MCP_CONFIG_PATH_HINT;
  }

  get manifest(): AgyToolManifest {
    if (this.manifestValue === null) {
      throw bridgeError(
        "tool",
        "CB_TOOL_UNKNOWN",
        "cli-providers: agy tool channel has no manifest; call registerHostTools first",
      );
    }
    return this.manifestValue;
  }

  async registerHostTools(tools: readonly HostTool[]): Promise<void> {
    const byName = new Map(tools.map((tool) => [tool.descriptor.name, tool]));

    const defs: McpToolDef[] = tools.map((tool) => ({
      name: tool.descriptor.name,
      description: tool.descriptor.description,
      inputSchema: tool.descriptor.inputSchema,
      handler: async () => {
        // Unreachable after the CallTool override below. Kept as a fail-loud pin:
        // if the override is ever removed, agy calls strand here loudly instead of
        // parking forever in the Claude-only rendezvous this channel does not use.
        throw bridgeError(
          "tool",
          "CB_TOOL_UNKNOWN",
          `cli-providers: agy executes "${tool.descriptor.name}" inline from tools/call arguments; the Claude tool_use rendezvous is not used`,
        );
      },
    }));

    const server = createToolServer(this.serverName, defs);
    server.instance.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const tool = byName.get(name);
      if (tool === undefined) return toCallToolResult(errorResult(`cli-providers: agy called unknown tool "${name}"`));
      if (!this.permission.toolAllowed(name)) {
        return toCallToolResult(
          errorResult(
            `cli-providers: agy tool "${name}" denied — not in the declarative allow rules and no ${AGY_PERMISSION_BYPASS_FLAG} consent`,
          ),
        );
      }
      try {
        const result = await tool.call(request.params.arguments ?? {});
        return toCallToolResult(textResult(result.content, result.isError === true));
      } catch (cause) {
        return toCallToolResult(errorResult(cause instanceof Error ? cause.message : String(cause)));
      }
    });

    this.server = server;
    this.manifestValue = {
      serverName: this.serverName,
      transport: "stdio",
      tools: tools.map((tool) => ({
        name: tool.descriptor.name,
        qualifiedName: qualifiedToolName(this.serverName, tool.descriptor.name),
        description: tool.descriptor.description,
        inputSchema: tool.descriptor.inputSchema,
      })),
      registration: await this.buildRegistration(),
    };
  }

  /** Connect the built server to a transport (e.g. agy's stdio endpoint). */
  connect(transport: Transport): Promise<void> {
    if (this.server === null) {
      throw bridgeError(
        "tool",
        "CB_TOOL_UNKNOWN",
        "cli-providers: agy tool channel has no server; call registerHostTools first",
      );
    }
    return this.server.instance.connect(transport);
  }

  private async buildRegistration(): Promise<AgyMcpRegistration> {
    if (this.allowUserLevelRegistration) {
      if (this.runnerCommand.length === 0) {
        throw bridgeError(
          "config",
          "CB_CONFIG_INVALID_OPTIONS",
          "cli-providers: allowUserLevelRegistration requires a runnerCommand so agy can spawn the MCP server",
        );
      }
      await this.registrar.register({
        serverName: this.serverName,
        runnerCommand: this.runnerCommand,
      });
      return {
        scope: "user",
        mechanism: "agy-mcp-add",
        configPathHint: this.configPathHint,
        runnerCommand: [...this.runnerCommand],
        argv: ["agy", ...buildAgyMcpAddArgv({ serverName: this.serverName, runnerCommand: this.runnerCommand })],
        applied: true,
        reason: "user-level registration performed with explicit opt-in",
      };
    }

    return {
      scope: "user",
      mechanism: "agy-mcp-add",
      configPathHint: this.configPathHint,
      runnerCommand: [...this.runnerCommand],
      argv:
        this.runnerCommand.length === 0
          ? []
          : ["agy", ...buildAgyMcpAddArgv({ serverName: this.serverName, runnerCommand: this.runnerCommand })],
      applied: false,
      reason:
        this.runnerCommand.length === 0
          ? "dry-run: no runner command configured and user-level agy config is not mutated without explicit opt-in"
          : "dry-run: user-level agy config is not mutated without explicit opt-in",
    };
  }
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function textResult(text: string, isError: boolean): ToolResult {
  const block: ToolTextContent = { type: "text", text };
  return isError ? { content: [block], isError: true } : { content: [block] };
}

function errorResult(message: string): ToolResult {
  return textResult(message, true);
}

/** MCP expects a mutable content array; the seam's result is readonly. */
function toCallToolResult(result: ToolResult): { content: ToolTextContent[]; isError?: boolean } {
  return { content: [...result.content], isError: result.isError };
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw bridgeError("config", "CB_CONFIG_INVALID_OPTIONS", `cli-providers: ${label} must be non-empty`);
  }
  return trimmed;
}

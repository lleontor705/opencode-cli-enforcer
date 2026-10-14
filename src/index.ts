/**
 * OpenCode v2 plugin entry: Wave A wiring hub with the agy (Wave B) provider
 * registration (REQ-CB-CFG-001, REQ-CB-PROV-001/002, REQ-CB-CMPR-001,
 * REQ-CB-ERR-001, REQ-CB-AGY-001; design D1/D8/D9/D11).
 *
 * This module owns the plugin-lifetime objects shared across sessions — the
 * per-session rendezvous scopes (cb-06/cb-28), the mirror registry (cb-09) and
 * the live-query ledger (cb-14) — and installs each building block into its host
 * seam exactly once.
 * It holds no provider logic: generation is the LanguageModelV3 adapter (cb-12),
 * the agy transport/mapper/store/channel aggregate is registered from its Wave B
 * modules, compaction is the isolated summarizer lane (cb-13) and teardown is cb-14.
 *
 * Fail-closed ordering is load-bearing: `resolveConfig` runs before any seam is
 * touched, so an invalid option set throws with nothing registered (REQ-CB-CFG-001).
 *
 * Hot-reload safety has two halves. The provider transform is independently
 * idempotent (cb-05 guards `editor.add` with `editor.get`), and the returned
 * cleanup disposes every registration so a reload that runs cleanup before
 * re-entering `setup` never stacks hooks; a single latch makes cleanup
 * re-entrant.
 */

import { fileURLToPath } from "node:url";

import { Plugin } from "@opencode/plugin";

import { AgyPermissionPolicy, AgyToolChannel } from "./agy/channel.js";
import { AgyEventMapper } from "./agy/event-mapper.js";
import { createAgyLanguageModelFactory } from "./agy/language-model.js";
import { AgyUsageBaselineLedger, registerAgyProvider } from "./agy/probe.js";
import { startAgyHostBridge } from "./agy/runner.js";
import type { AgyHostBridge } from "./agy/runner.js";
import { AgySessionStore } from "./agy/session-store.js";
import { AGY_TRANSPORT_DEFAULT_COMMAND, AgyTransport } from "./agy/transport.js";
import { resolveConfig } from "./config/schema.js";
import type { ResolvedAgyConfig } from "./config/schema.js";
import { createProviderRegistry } from "./provider/registry.js";
import { bindLanguageModel, bindProviderEditor, registerClaudeBridge } from "./provider/registration.js";
import type { Disposable } from "./provider/registration.js";
import {
  createClaudeBridgeLanguageModelFactory,
  RendezvousScopes,
  SESSION_ID_HEADER,
} from "./provider/language-model.js";
import type { ClaudeBridgeSpawn } from "./provider/language-model.js";
import { CLAUDE_BRIDGE_PROVIDER_ID } from "./provider/models.js";
import { MCP_SERVER_NAME } from "./provider/query-lifecycle.js";
import type { QueryContext } from "./provider/query-state.js";
import type { HostTool, HostToolResult } from "./provider/seams.js";
import { MirrorRegistry } from "./session/mirror.js";
import { registerCompactionHook } from "./session/compaction.js";
import type { CompactionFailureReporter } from "./session/compaction.js";
import { LiveQueries, reportLeaks, teardownQuery } from "./errors/teardown.js";
import type { NotifyFn } from "./stream/mapping.js";

/**
 * Claude Code exposes every in-process MCP tool as `mcp__<server>__<name>`, but
 * the host knows it by its bare name. Unknown names keep their own identity so a
 * non-MCP frame is never renamed onto a tool the model was not served.
 */
const HOST_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

function resolveHostToolName(name: string): string | undefined {
  return name.startsWith(HOST_TOOL_PREFIX) ? name.slice(HOST_TOOL_PREFIX.length) : name;
}

/**
 * Report lane/mapper warnings through a host notification sink when the surface
 * exposes one; otherwise degrade to `console.warn`. The type only promises
 * `event.subscribe`, so this stays an optional structural probe rather than a
 * compile-time dependency.
 */
function createHostNotifier(ctx: Plugin.Context): NotifyFn {
  const sink = ctx.event as unknown as {
    notify?: (message: string, level: "warning" | "info") => void;
  };
  if (typeof sink.notify === "function") {
    const notify = sink.notify.bind(sink);
    return (message, level) => notify(message, level);
  }
  return (message, level) => {
    console.warn(`claude-bridge: [${level}] ${message}`);
  };
}

// ---------------------------------------------------------------------------
// agy host-tool runner wiring (REQ-CB-TOOL-001, REQ-CB-AGY-001; design D13)
// ---------------------------------------------------------------------------

/** The runner entrypoint agy spawns; resolved next to this plugin module. */
const AGY_RUNNER_ENTRY = fileURLToPath(new URL("./agy/runner.ts", import.meta.url));

type RegisteredHostTool = Awaited<ReturnType<Plugin.Context["tool"]["list"]>>[number];
type RegisteredHostToolContext = Parameters<RegisteredHostTool["execute"]>[1];

interface AgyHostWiring {
  readonly bridge: AgyHostBridge;
  readonly channel: AgyToolChannel;
  readonly runnerCommand: readonly string[];
  dispose(): Promise<void>;
}

/**
 * Wire the agy host-tool path for an enabled provider: project OpenCode's
 * registered tools into the cb-02 `HostTool` seam, build the cb-24 channel with
 * the real runner command, and start the loopback bridge that serves it. When
 * agy is disabled this is never called, so channel behavior stays the unchanged
 * dry-run manifest.
 *
 * `allowUserLevelRegistration` remains false (cb-24 fail-closed): the manifest
 * carries the real runner command, but the user-level agy config is only
 * mutated under an explicit operator opt-in.
 */
async function startAgyHostWiring(
  ctx: Plugin.Context,
  agy: ResolvedAgyConfig,
): Promise<AgyHostWiring> {
  const bridge = await startAgyHostBridge();
  const runnerCommand = [
    process.execPath,
    "--import",
    "tsx",
    AGY_RUNNER_ENTRY,
    bridge.url,
    bridge.token,
  ];

  const channel = new AgyToolChannel({
    permission: new AgyPermissionPolicy({
      dangerouslySkipPermissionsConsent: agy.dangerouslySkipPermissionsConsent,
    }),
    allowUserLevelRegistration: false,
    runnerCommand,
  });

  const hostTools = (await ctx.tool.list()).map(toHostTool);
  await channel.registerHostTools(hostTools);
  await bridge.attach(channel);

  return {
    bridge,
    channel,
    runnerCommand,
    async dispose() {
      await bridge.close();
    },
  };
}

/**
 * Register the agy provider with the real Wave B bindings: cb-21 transport,
 * cb-22 mapper, cb-23 session store, cb-24 channel and cb-25 usage ledger, plus
 * the LanguageModelV3 factory that drives them. Catalog and `language` hook go
 * through the same guarded cb-05 bindings claude-bridge uses (idempotent
 * `editor.get` transform + providerID-scoped hook), so a hot-reload never stacks
 * a second agy registration and the disposables join the cleanup latch.
 */
async function registerAgyBridge(
  ctx: Plugin.Context,
  wiring: AgyHostWiring,
): Promise<readonly Disposable[]> {
  const transport = new AgyTransport();
  const eventMapper = new AgyEventMapper();
  const sessions = new AgySessionStore();
  const baselines = new AgyUsageBaselineLedger();
  const languageModelFactory = createAgyLanguageModelFactory({
    transport,
    sessions,
    usageBaselines: baselines,
    command: AGY_TRANSPORT_DEFAULT_COMMAND,
    cwd: ctx.location.directory,
  });

  const { catalog } = registerAgyProvider(createProviderRegistry(), {
    transport,
    eventMapper,
    sessions,
    tools: wiring.channel,
    baselines,
    languageModelFactory,
  });

  return [await bindProviderEditor(ctx, catalog), await bindLanguageModel(ctx, catalog)];
}

function toHostTool(tool: RegisteredHostTool): HostTool {
  return {
    descriptor: {
      name: tool.name,
      description: tool.description,
      inputSchema: toObjectInputSchema(tool.input),
    },
    call: (input) => callRegisteredHostTool(tool, input),
  };
}

/**
 * MCP requires an object-typed schema. OpenCode tools declared with a plain
 * JSON Schema pass through verbatim; effect/StandardSchema inputs cannot be
 * projected to JSON Schema without the provider schema library, so they degrade
 * to an open object rather than fabricating property names.
 */
function toObjectInputSchema(input: unknown): Record<string, unknown> {
  if (
    typeof input === "object" &&
    input !== null &&
    (input as { type?: unknown }).type === "object"
  ) {
    return input as Record<string, unknown>;
  }
  return { type: "object", additionalProperties: true };
}

async function callRegisteredHostTool(
  tool: RegisteredHostTool,
  input: unknown,
): Promise<HostToolResult> {
  try {
    const result = await tool.execute(input, hostToolContext());
    return renderHostToolResult(result);
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true };
  }
}

/**
 * agy's tool calls arrive outside any OpenCode turn, so the execution context is
 * synthesized: the bridge identity stands in for the session/agent/message ids
 * the host tool records for telemetry. No OpenCode turn state is claimed.
 */
function hostToolContext(): RegisteredHostToolContext {
  return {
    sessionID: "agy-host-bridge" as RegisteredHostToolContext["sessionID"],
    agent: "agy" as RegisteredHostToolContext["agent"],
    messageID: "agy-host-bridge" as RegisteredHostToolContext["messageID"],
    id: "agy-host-bridge" as RegisteredHostToolContext["id"],
    signal: new AbortController().signal,
    progress: async () => {},
  };
}

function renderHostToolResult(result: { content?: unknown; output?: unknown }): HostToolResult {
  const content = result.content;
  if (typeof content === "string") return { content };
  if (Array.isArray(content)) {
    return { content: content.map(renderToolContentBlock).join("\n") };
  }
  return { content: result.output === undefined ? "" : JSON.stringify(result.output) };
}

function renderToolContentBlock(block: unknown): string {
  if (typeof block === "object" && block !== null) {
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === "text") return String(typed.text ?? "");
  }
  return JSON.stringify(block);
}

export default Plugin.define({
  id: "claude-bridge",
  async setup(ctx) {
    const config = resolveConfig(ctx.options);

    const rendezvousScopes = new RendezvousScopes();
    const spawns = new Map<QueryContext, ClaudeBridgeSpawn>();
    const mirrors = new MirrorRegistry();
    const liveQueries = new LiveQueries();
    const notify = createHostNotifier(ctx);
    const reportFailure: CompactionFailureReporter = (error) =>
      notify(`${error.code}: ${error.message}`, "warning");

    const languageModelFactory = createClaudeBridgeLanguageModelFactory({
      rendezvousScopes,
      notify,
      resolveToolName: resolveHostToolName,
      childEnv: config.childEnv,
      cwd: ctx.location.directory,
      onSpawn: (spawn) => {
        liveQueries.track(spawn.context);
        spawns.set(spawn.context, spawn);
      },
    });

    const { registrations } = await registerClaudeBridge(ctx, {
      registry: createProviderRegistry(),
      languageModelFactory,
    });

    const compactionRegistration = await registerCompactionHook(ctx, {
      childEnv: config.childEnv,
      cwd: ctx.location.directory,
      reportFailure,
    });

    // Pin the session id onto the request headers so the adapter can bound its
    // rendezvous to one session. `LanguageModelV3CallOptions` carries no typed
    // session field; this header is the host's correlation channel.
    const sessionHeaderRegistration = await ctx.session.hook(
      "model.request",
      (event) => {
        event.headers[SESSION_ID_HEADER] = String(event.sessionID);
      },
      { providerID: CLAUDE_BRIDGE_PROVIDER_ID },
    );

    // agy is out-of-process: its host tools reach it through the loopback runner
    // bridge. Disabled agy means no bridge, no runner command and no channel, so
    // the dry-run manifest path is untouched.
    const agyWiring = config.providers.agy.enabled
      ? await startAgyHostWiring(ctx, config.providers.agy)
      : null;

    // Enabled agy also registers its provider catalog + LanguageModelV3 factory
    // (transport/mapper/store/channel/probe bindings) through the same
    // provider.transform and providerID-scoped `language` hook claude-bridge uses.
    const agyRegistrations: readonly Disposable[] =
      agyWiring === null ? [] : await registerAgyBridge(ctx, agyWiring);

    const disposables: readonly Disposable[] = [
      ...registrations,
      ...agyRegistrations,
      compactionRegistration,
      sessionHeaderRegistration,
    ];
    let cleanup: Promise<void> | null = null;

    return () => {
      cleanup ??= (async () => {
        await agyWiring?.dispose();
        // The cb-14 contract: every live query tears down to zero leaks. Each
        // context carries the session scope it parked under, so teardown
        // releases only that session's handlers.
        for (const context of liveQueries.snapshot()) {
          const spawn = spawns.get(context) ?? null;
          const rendezvous = spawn?.rendezvous ?? null;
          teardownQuery({ context, rendezvous, mirror: mirrors, liveQueries });
          spawns.delete(context);
          reportLeaks("plugin cleanup", { context, rendezvous, liveQueries });
        }
        if (liveQueries.size !== 0) {
          throw new Error(
            `claude-bridge: plugin cleanup left ${liveQueries.size} live query context(s)`,
          );
        }
        for (const disposable of [...disposables].reverse()) {
          await disposable.dispose();
        }
      })();
      return cleanup;
    };
  },
});

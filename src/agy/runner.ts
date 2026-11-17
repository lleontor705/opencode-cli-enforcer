/**
 * agy (Google Antigravity CLI) host-tool runner and loopback bridge
 * (REQ-CB-TOOL-001, REQ-CB-AGY-001; design D13).
 *
 * agy is out-of-process and can only consume an MCP server it spawns as a real
 * stdio subprocess (viability evidence #576), so the plugin's in-process host
 * handlers cannot be reached from agy's turn. This module owns both ends of the
 * forwarding hop:
 *
 * - {@link main} is the standalone runner agy spawns. It speaks MCP over stdio
 *   (the SDK `StdioServerTransport`) and forwards `tools/list` and `tools/call`
 *   over HTTP to the plugin's loopback bridge.
 * - {@link startAgyHostBridge} is the plugin-side endpoint. It runs an HTTP
 *   server bound to `127.0.0.1` only and authenticated with a per-process bearer
 *   token. It answers list/call by driving a real MCP `Client` against the agy
 *   `ToolChannel` server, so the tool schemas and the fail-closed permission
 *   checks are exactly the cb-24 `createToolServer` semantics — the hop adds no
 *   second tool surface and leaks nothing beyond agy's registered server.
 *
 * D13 — forwarding hop: loopback owned by the plugin process.
 * Evidence from the installed @opencode/plugin@2.0.26 types: the plugin does
 * expose a first-class typed RPC seam (`ctx.rpc.register` with `Rpc.define`
 * definitions and `RpcHandlers`), and `@opencode/client` exposes a typed RPC
 * client. That path was rejected for this hop because:
 *   (a) the runner-side client (`@opencode/client` `Service.discover()` /
 *       `Service.headers()`) is an *undeclared transitive* dependency of this
 *       package; `package.json` is outside this task's allowed_files, and a
 *       shipped stdio entry must not import a package it does not declare;
 *   (b) the OpenCode RPC route is served from the OpenCode server origin, and
 *       no plugin seam hands the plugin its own server URL (`ctx.app` carries
 *       only name/version/channel; `Location.Info` carries no URL), so the
 *       plugin cannot tell agy where to reach it without re-discovering the
 *       service;
 *   (c) the loopback hop is self-contained (`node:http` + the declared MCP SDK),
 *       binds explicitly to `127.0.0.1`, and exposes only list/call for agy's
 *       single registered server.
 *
 * The bearer token is generated per process and passed to the runner on argv
 * (or {@link AGY_HOST_BRIDGE_URL_ENV}/{@link AGY_HOST_BRIDGE_TOKEN_ENV}); it is
 * ephemeral and is never persisted to the repository or to Cortex.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  AGY_HOST_BRIDGE_DEFAULT_NAME,
  BEARER_PREFIX,
  TOOLS_CALL_ROUTE,
  TOOLS_LIST_ROUTE,
} from "./runner-cli.mjs";

export {
  AGY_HOST_BRIDGE_DEFAULT_NAME,
  AGY_HOST_BRIDGE_TOKEN_ENV,
  AGY_HOST_BRIDGE_URL_ENV,
  createRunnerServer,
  isLoopbackHostname,
  main,
  resolveRunnerEndpoint,
  type AgyRunnerEndpoint,
  type RunnerEndpoint,
} from "./runner-cli.mjs";

export const AGY_HOST_BRIDGE_LOOPBACK_HOST = "127.0.0.1";

const DEFAULT_REQUEST_LIMIT_BYTES = 8 * 1024 * 1024;

/** The plugin-side server surface the bridge attaches to (structurally `ToolChannel` + `connect`). */
export interface McpServerConnector {
  connect(transport: Transport): Promise<void>;
}

export interface AgyHostBridge {
  /** `http://127.0.0.1:<ephemeral-port>` — never a routable interface. */
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  /** Connect the host-tool server; must be called before the runner forwards. */
  attach(connector: McpServerConnector): Promise<void>;
  close(): Promise<void>;
}

export interface AgyHostBridgeOptions {
  readonly serverName?: string;
  readonly requestLimitBytes?: number;
}

/**
 * Start the plugin-side loopback bridge. The HTTP server is bound to
 * `127.0.0.1` on an ephemeral port; every request must carry the per-process
 * bearer token. The MCP client to the tool channel is created by {@link
 * AgyHostBridge.attach} so the bridge can be started before the channel exists
 * (the runner command needs the bridge url and the channel needs the command).
 */
export async function startAgyHostBridge(options: AgyHostBridgeOptions = {}): Promise<AgyHostBridge> {
  const serverName = options.serverName ?? AGY_HOST_BRIDGE_DEFAULT_NAME;
  const requestLimitBytes = options.requestLimitBytes ?? DEFAULT_REQUEST_LIMIT_BYTES;
  const token = randomBytes(32).toString("hex");

  let client: Client | null = null;
  let attachPromise: Promise<void> | null = null;

  const http = createServer((req, res) => {
    void handleBridgeRequest(req, res, {
      token,
      requestLimitBytes,
      getClient: async () => {
        if (client === null) throw new Error("agy host bridge has no attached tool channel");
        return client;
      },
    }).catch((error: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    });
  });

  await listenLoopback(http);
  const address = http.address();
  if (address === null || typeof address === "string") {
    await closeHttp(http);
    throw new Error("cli-providers: agy host bridge failed to bind a loopback port");
  }

  let closed = false;
  return {
    url: `http://${address.address}:${address.port}`,
    host: address.address,
    port: address.port,
    token,
    attach(connector) {
      attachPromise ??= (async () => {
        const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
        const attached = new Client({ name: serverName, version: "1.0.0" });
        await Promise.all([connector.connect(serverTransport), attached.connect(clientTransport)]);
        client = attached;
      })();
      return attachPromise;
    },
    async close() {
      if (closed) return;
      closed = true;
      await closeHttp(http);
      await client?.close().catch(() => {});
    },
  };
}

interface BridgeRequestContext {
  readonly token: string;
  readonly requestLimitBytes: number;
  readonly getClient: () => Promise<Client>;
}

async function handleBridgeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: BridgeRequestContext,
): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }
  if (!isAuthorized(req, context.token)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  const route = (req.url ?? "").split("?")[0];
  if (route !== TOOLS_LIST_ROUTE && route !== TOOLS_CALL_ROUTE) {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  const client = await context.getClient();
  if (route === TOOLS_LIST_ROUTE) {
    const listed = await client.listTools();
    sendJson(res, 200, { tools: listed.tools });
    return;
  }

  const body = await readJsonBody(req, context.requestLimitBytes);
  const name = body.name;
  if (typeof name !== "string" || name.length === 0) {
    sendJson(res, 400, { error: "missing tool name" });
    return;
  }
  const args = isRecord(body.arguments) ? body.arguments : {};
  const result = await client.callTool({ name, arguments: args });
  sendJson(res, 200, { content: result.content, isError: result.isError === true });
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith(BEARER_PREFIX)) return false;
  const provided = Buffer.from(header.slice(BEARER_PREFIX.length));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function readJsonBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("agy host bridge: request body exceeds the size limit"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim().length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function listenLoopback(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, AGY_HOST_BRIDGE_LOOPBACK_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeHttp(server: HttpServer): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

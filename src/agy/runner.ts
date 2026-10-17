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
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

export const AGY_HOST_BRIDGE_DEFAULT_NAME = "opencode-host-bridge";
export const AGY_HOST_BRIDGE_LOOPBACK_HOST = "127.0.0.1";
export const AGY_HOST_BRIDGE_URL_ENV = "OPENCODE_AGY_BRIDGE_URL";
export const AGY_HOST_BRIDGE_TOKEN_ENV = "OPENCODE_AGY_BRIDGE_TOKEN";

const TOOLS_LIST_ROUTE = "/tools/list";
const TOOLS_CALL_ROUTE = "/tools/call";
const BEARER_PREFIX = "Bearer ";
const DEFAULT_REQUEST_LIMIT_BYTES = 8 * 1024 * 1024;
const BRIDGE_TIMEOUT_MS = 30_000;

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

/** The endpoint the standalone runner forwards to. */
export interface AgyRunnerEndpoint {
  readonly url: string;
  readonly token: string;
}

/**
 * True for hostnames that can only ever name the local machine. `localhost` is
 * included for operator ergonomics; the plugin always binds `127.0.0.1`.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0:0:0:0:0:0:0:1";
}

/**
 * Resolve and validate the bridge endpoint from positional argv (`<url> <token>`)
 * with an environment fallback. A non-loopback host or missing token fails loud:
 * the runner must never forward host-tool calls to a remote endpoint.
 */
export function resolveRunnerEndpoint(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): AgyRunnerEndpoint {
  const urlValue = argv[0] ?? env[AGY_HOST_BRIDGE_URL_ENV];
  const token = argv[1] ?? env[AGY_HOST_BRIDGE_TOKEN_ENV];

  if (urlValue === undefined || urlValue.trim().length === 0) {
    throw new Error("cli-providers: agy host runner requires a bridge url or OPENCODE_AGY_BRIDGE_URL");
  }
  if (token === undefined || token.trim().length === 0) {
    throw new Error("cli-providers: agy host runner requires a bridge token or OPENCODE_AGY_BRIDGE_TOKEN");
  }

  let parsed: URL;
  try {
    parsed = new URL(urlValue);
  } catch (cause) {
    throw new Error(`cli-providers: agy host runner received an invalid bridge url "${urlValue}"`, { cause });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`cli-providers: agy host runner requires an http(s) bridge url, got "${parsed.protocol}"`);
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      `cli-providers: agy host runner refuses non-loopback bridge host "${parsed.hostname}"; host tools stay on the local machine`,
    );
  }
  return { url: urlValue, token };
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
// Runner (agy-spawned stdio endpoint)
// ---------------------------------------------------------------------------

/** Build the stdio MCP server that forwards list/call to the bridge. */
export function createRunnerServer(endpoint: AgyRunnerEndpoint): Server {
  const server = new Server(
    { name: AGY_HOST_BRIDGE_DEFAULT_NAME, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => {
    const tools = await forwardListTools(endpoint);
    return { tools: tools as ListToolsResult["tools"] };
  });

  server.setRequestHandler(CallToolRequestSchema, (request): Promise<CallToolResult> =>
    forwardCallTool(endpoint, request.params),
  );

  return server;
}

/**
 * Standalone entry: resolve the loopback endpoint, then serve MCP over stdio.
 * Never returns until the transport closes.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const endpoint = resolveRunnerEndpoint(argv, env);
  await createRunnerServer(endpoint).connect(new StdioServerTransport());
}

async function forwardListTools(endpoint: AgyRunnerEndpoint): Promise<unknown[]> {
  const response = await postJson(endpoint, TOOLS_LIST_ROUTE, {});
  const body = (await response.json()) as { tools?: unknown; error?: unknown };
  if (!response.ok) throw new Error(readBridgeError(body, response.status));
  return Array.isArray(body.tools) ? body.tools : [];
}

/**
 * A failed or unreachable bridge returns an `isError` MCP result instead of
 * throwing: agy's `tools/call` is already in flight and an error response it
 * understands keeps the turn alive (no hang).
 */
async function forwardCallTool(
  endpoint: AgyRunnerEndpoint,
  params: { readonly name: string; readonly arguments?: Record<string, unknown> },
): Promise<CallToolResult> {
  try {
    const response = await postJson(endpoint, TOOLS_CALL_ROUTE, {
      name: params.name,
      arguments: params.arguments ?? {},
    });
    const body = (await response.json()) as { content?: unknown; isError?: unknown; error?: unknown };
    if (!response.ok) return errorResult(readBridgeError(body, response.status));
    return {
      content: (Array.isArray(body.content) ? body.content : []) as CallToolResult["content"],
      isError: body.isError === true,
    };
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function readBridgeError(body: { error?: unknown }, status: number): string {
  return typeof body.error === "string" ? body.error : `agy host bridge returned HTTP ${status}`;
}

async function postJson(endpoint: AgyRunnerEndpoint, route: string, body: unknown): Promise<Response> {
  return fetch(`${endpoint.url}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `${BEARER_PREFIX}${endpoint.token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
  });
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

// ---------------------------------------------------------------------------
// Direct entry
// ---------------------------------------------------------------------------

/**
 * True when this module is the process entrypoint (agy spawns `runner.ts`
 * directly). Importing it from the plugin or a test must never serve stdio, so
 * the check compares the real argv[1] against this module's own resolved path.
 */
function isRunnerEntrypoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  const resolved = path.resolve(entry);
  return resolved === self || resolved === self.replace(/\.ts$/, ".js");
}

if (isRunnerEntrypoint()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`cli-providers: agy host runner failed: ${message}\n`);
    process.exitCode = 1;
  });
}

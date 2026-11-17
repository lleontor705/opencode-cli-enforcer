/**
 * Standalone plain-ESM MCP stdio runner for `agy` host tools (REQ-CB-TOOL-001, D13).
 * Runs under bare Node (>=20, no `tsx`) or OpenCode v2's Bun binary (`BUN_BE_BUN=1`).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export const AGY_HOST_BRIDGE_DEFAULT_NAME = "opencode-host-bridge";
export const AGY_HOST_BRIDGE_URL_ENV = "OPENCODE_AGY_BRIDGE_URL";
export const AGY_HOST_BRIDGE_TOKEN_ENV = "OPENCODE_AGY_BRIDGE_TOKEN";

export const TOOLS_LIST_ROUTE = "/tools/list";
export const TOOLS_CALL_ROUTE = "/tools/call";
export const BEARER_PREFIX = "Bearer ";
const BRIDGE_TIMEOUT_MS = 30_000;

export function isLoopbackHostname(hostname) {
  const host = hostname.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0:0:0:0:0:0:0:1";
}

export function resolveRunnerEndpoint(argv, env = process.env) {
  const urlValue = argv[0] ?? env[AGY_HOST_BRIDGE_URL_ENV];
  const token = argv[1] ?? env[AGY_HOST_BRIDGE_TOKEN_ENV];
  if (urlValue === undefined || urlValue.trim().length === 0) {
    throw new Error("cli-providers: agy host runner requires a bridge url or OPENCODE_AGY_BRIDGE_URL");
  }
  if (token === undefined || token.trim().length === 0) {
    throw new Error("cli-providers: agy host runner requires a bridge token or OPENCODE_AGY_BRIDGE_TOKEN");
  }
  let parsed;
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

export function createRunnerServer(endpoint) {
  const server = new Server(
    { name: AGY_HOST_BRIDGE_DEFAULT_NAME, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await forwardListTools(endpoint),
  }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    forwardCallTool(endpoint, request.params),
  );
  return server;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const endpoint = resolveRunnerEndpoint(argv, env);
  await createRunnerServer(endpoint).connect(new StdioServerTransport());
}

async function forwardListTools(endpoint) {
  const response = await postJson(endpoint, TOOLS_LIST_ROUTE, {});
  const body = await readJsonBody(response);
  if (!response.ok) throw new Error(readBridgeError(body, response.status));
  return body !== null && Array.isArray(body.tools) ? body.tools : [];
}

async function forwardCallTool(endpoint, params) {
  try {
    const response = await postJson(endpoint, TOOLS_CALL_ROUTE, {
      name: params.name,
      arguments: params.arguments ?? {},
    });
    const body = await readJsonBody(response);
    if (!response.ok) return errorResult(readBridgeError(body, response.status));
    if (body === null) return errorResult("agy host bridge returned a non-JSON response");
    return {
      content: Array.isArray(body.content) ? body.content : [],
      isError: body.isError === true,
    };
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Error bodies from proxies or crashed bridges may not be JSON; the status must
// still surface instead of an opaque SyntaxError.
async function readJsonBody(response) {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function readBridgeError(body, status) {
  return body !== null && typeof body === "object" && typeof body.error === "string"
    ? body.error
    : `agy host bridge returned HTTP ${status}`;
}

async function postJson(endpoint, route, body) {
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

function isRunnerEntrypoint() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  const dir = path.dirname(self);
  const resolved = path.resolve(entry);
  return (
    resolved === self ||
    resolved === path.join(dir, "runner-cli.js") ||
    resolved === path.join(dir, "runner.ts") ||
    resolved === path.join(dir, "runner.js")
  );
}

if (isRunnerEntrypoint()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`cli-providers: agy host runner failed: ${message}\n`);
    process.exitCode = 1;
  });
}

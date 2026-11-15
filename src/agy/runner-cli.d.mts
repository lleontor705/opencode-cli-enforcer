import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export declare const AGY_HOST_BRIDGE_DEFAULT_NAME = "opencode-host-bridge";
export declare const AGY_HOST_BRIDGE_URL_ENV = "OPENCODE_AGY_BRIDGE_URL";
export declare const AGY_HOST_BRIDGE_TOKEN_ENV = "OPENCODE_AGY_BRIDGE_TOKEN";

export interface AgyRunnerEndpoint {
  readonly url: string;
  readonly token: string;
}
export type RunnerEndpoint = AgyRunnerEndpoint;

export declare function isLoopbackHostname(hostname: string): boolean;
export declare function resolveRunnerEndpoint(
  argv: readonly string[],
  env?: Readonly<Record<string, string | undefined>>,
): AgyRunnerEndpoint;
export declare function createRunnerServer(endpoint: AgyRunnerEndpoint): Server;
export declare function main(
  argv?: readonly string[],
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void>;

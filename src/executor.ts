/**
 * Core Execution Engine — runs a CLI binary via execa with structured output.
 * Returns structured results (never throws) to support global time budget.
 */

import { execa } from "execa"
import path from "node:path"
import os from "node:os"
import type { CliDef } from "./cli-defs"
import { buildTimeoutArgs } from "./cli-defs"
import { getSafeEnv } from "./safe-env"
import { redactSecrets } from "./redact"
import { IS_WINDOWS } from "./platform"

/** Prompts longer than this (chars) are delivered via stdin to avoid OS arg-length limits. */
export const STDIN_THRESHOLD = 30_000
const MAX_BUFFER = 10 * 1024 * 1024 // 10MB

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  timedOut: boolean
}

/**
 * On Windows, CLIs installed via npm/scoop/cargo may be .cmd/.bat shims.
 * Wrap with `cmd /c` so execa can execute them without a shell.
 */
function resolveCommand(binary: string): { file: string; prefix: string[] } {
  if (!IS_WINDOWS) return { file: binary, prefix: [] }

  const ext = path.extname(binary).toLowerCase()
  if (ext === ".cmd" || ext === ".bat") {
    return { file: "cmd", prefix: ["/c", binary] }
  }

  const pathext = (process.env.PATHEXT || "").toLowerCase()
  if (pathext.includes(".cmd") || pathext.includes(".bat")) {
    return { file: "cmd", prefix: ["/c", binary] }
  }

  return { file: binary, prefix: [] }
}

/** Enhance PATH on Windows with common CLI install locations */
function getEnhancedPath(): string | undefined {
  if (!IS_WINDOWS) return undefined

  const home = os.homedir()
  const extraPaths = [
    path.join(home, "AppData", "Roaming", "npm"),
    path.join(home, "scoop", "shims"),
    path.join(home, ".cargo", "bin"),
    path.join(home, "AppData", "Local", "pnpm"),
  ]

  const currentPath = process.env.PATH || ""
  return [...extraPaths, currentPath].join(path.delimiter)
}

export async function executeCliOnce(
  def: CliDef,
  prompt: string,
  mode: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<ExecResult> {
  const useStdin = def.buildStdinArgs != null && prompt.length > STDIN_THRESHOLD
  const baseArgs = useStdin ? def.buildStdinArgs!(mode) : def.buildArgs(prompt, mode)
  const timeoutHints = buildTimeoutArgs(def.name, timeoutSeconds)
  const args = [...baseArgs, ...timeoutHints]

  const { file, prefix } = resolveCommand(def.binary)
  const finalArgs = [...prefix, ...args]

  const env = getSafeEnv()
  const enhancedPath = getEnhancedPath()
  if (enhancedPath) {
    env.PATH = enhancedPath
  }

  const start = Date.now()

  try {
    const result = await execa(file, finalArgs, {
      timeout: timeoutSeconds * 1000,
      maxBuffer: MAX_BUFFER,
      reject: false,
      windowsHide: true,
      env,
      ...(useStdin ? { input: prompt } : {}),
      ...(signal ? { cancelSignal: signal } : {}),
    })

    return {
      stdout: result.stdout || "",
      stderr: redactSecrets(result.stderr || ""),
      exitCode: result.exitCode ?? 1,
      durationMs: Date.now() - start,
      timedOut: result.timedOut ?? false,
    }
  } catch (error: any) {
    return {
      stdout: "",
      stderr: redactSecrets(error.message || "Execution failed"),
      exitCode: 1,
      durationMs: Date.now() - start,
      timedOut: !!error.timedOut,
    }
  }
}

export function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + `\n...[truncated at ${max} chars]` : str
}

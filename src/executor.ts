/**
 * Core Execution Engine — runs a CLI binary via execa with structured output.
 */

import { execa } from "execa"
import type { CliDef } from "./cli-defs"

/** Prompts longer than this (chars) are delivered via stdin to avoid OS arg-length limits. */
export const STDIN_THRESHOLD = 30_000

export interface ExecResult {
  stdout: string
  stderr: string
  durationMs: number
}

export async function executeCliOnce(
  def: CliDef,
  prompt: string,
  mode: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ExecResult> {
  const useStdin = def.buildStdinArgs != null && prompt.length > STDIN_THRESHOLD
  const args = useStdin ? def.buildStdinArgs!(mode) : def.buildArgs(prompt, mode)
  const start = Date.now()

  const result = await execa(def.binary, args, {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    reject: false,
    windowsHide: true,
    ...(useStdin ? { input: prompt } : {}),
    ...(signal ? { cancelSignal: signal } : {}),
  })

  const durationMs = Date.now() - start

  if (result.isCanceled) {
    throw Object.assign(new Error(`CLI '${def.name}' was canceled`), { canceled: true })
  }

  if (result.timedOut) {
    throw Object.assign(new Error(`CLI '${def.name}' timed out after ${timeoutMs}ms`), {
      timedOut: true,
    })
  }

  if (result.failed && result.exitCode !== 0) {
    const msg = result.stderr?.trim() || result.message || `Exit code ${result.exitCode}`
    throw new Error(`CLI '${def.name}' failed: ${msg}`)
  }

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs,
  }
}

export function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + `\n...[truncated at ${max} chars]` : str
}

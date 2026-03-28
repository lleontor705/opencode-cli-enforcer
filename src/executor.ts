/**
 * Core Execution Engine — runs a CLI binary via execa with structured output.
 */

import { execaCommand } from "execa"
import type { CliDef } from "./cli-defs"

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
): Promise<ExecResult> {
  const args = def.buildArgs(prompt, mode)
  const start = Date.now()

  const result = await execaCommand(
    [def.binary, ...args.map((a) => (a.includes(" ") ? `"${a}"` : a))].join(" "),
    {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      reject: false,
      windowsHide: true,
    },
  )

  const durationMs = Date.now() - start

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

/**
 * CLI Auto-Detection — probes the system for installed CLI binaries.
 */

import { execaCommand } from "execa"
import { IS_WINDOWS } from "./platform"
import { CLI_DEFS, ALL_CLI_NAMES, type CliName } from "./cli-defs"

export interface CliAvailability {
  installed: boolean
  path: string | null
  version: string | null
  checkedAt: number
}

export async function detectCli(name: CliName): Promise<CliAvailability> {
  const def = CLI_DEFS[name]
  const whichCmd = IS_WINDOWS ? `where ${def.binary}` : `which ${def.binary}`

  try {
    const { stdout } = await execaCommand(whichCmd, { timeout: 5_000 })
    const path = stdout.trim().split("\n")[0] ?? null

    let version: string | null = null
    try {
      const vResult = await execaCommand(`${def.binary} --version`, { timeout: 5_000 })
      version = vResult.stdout.trim().split("\n")[0] ?? null
    } catch {
      // version check is best-effort
    }

    return { installed: true, path, version, checkedAt: Date.now() }
  } catch {
    return { installed: false, path: null, version: null, checkedAt: Date.now() }
  }
}

export async function detectAllClis(): Promise<Map<CliName, CliAvailability>> {
  const results = new Map<CliName, CliAvailability>()
  const checks = await Promise.allSettled(
    ALL_CLI_NAMES.map(async (name) => ({ name, result: await detectCli(name) })),
  )
  for (const check of checks) {
    if (check.status === "fulfilled") {
      results.set(check.value.name, check.value.result)
    }
  }
  return results
}

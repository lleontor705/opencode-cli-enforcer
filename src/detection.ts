/**
 * CLI Auto-Detection — probes the system for installed CLI binaries.
 * Caches results for 5 minutes to avoid repeated filesystem lookups.
 */

import { execa } from "execa"
import { IS_WINDOWS } from "./platform"
import { CLI_DEFS, ALL_CLI_NAMES, type CliName } from "./cli-defs"

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

export interface CliAvailability {
  installed: boolean
  path: string | null
  version: string | null
  checkedAt: number
}

interface CacheEntry {
  result: CliAvailability
  timestamp: number
}

const cache = new Map<CliName, CacheEntry>()

function isCacheValid(entry: CacheEntry): boolean {
  return Date.now() - entry.timestamp < CACHE_TTL_MS
}

export async function detectCli(name: CliName): Promise<CliAvailability> {
  const cached = cache.get(name)
  if (cached && isCacheValid(cached)) return cached.result

  const def = CLI_DEFS[name]
  const whichBin = IS_WINDOWS ? "where" : "which"

  try {
    const { stdout } = await execa(whichBin, [def.binary], { timeout: 5_000, windowsHide: true })
    const path = stdout.trim().split(/\r?\n/)[0] ?? null

    let version: string | null = null
    try {
      const vResult = await execa(def.binary, ["--version"], { timeout: 5_000, windowsHide: true })
      version = vResult.stdout.trim().split(/\r?\n/)[0] ?? null
    } catch {
      // version check is best-effort
    }

    const result: CliAvailability = { installed: true, path, version, checkedAt: Date.now() }
    cache.set(name, { result, timestamp: Date.now() })
    return result
  } catch {
    const result: CliAvailability = { installed: false, path: null, version: null, checkedAt: Date.now() }
    cache.set(name, { result, timestamp: Date.now() })
    return result
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

export function getDetectionCache(): Map<CliName, CliAvailability> {
  return new Map([...cache].map(([k, v]) => [k, v.result]))
}

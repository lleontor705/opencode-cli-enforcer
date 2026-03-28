/**
 * Resilience Engine — orchestrates retry + circuit breaker + fallback
 * into a single execution pipeline.
 */

import type { CliName } from "./cli-defs"
import { CLI_DEFS, ALL_CLI_NAMES } from "./cli-defs"
import type { CircuitBreaker, BreakerConfig } from "./circuit-breaker"
import {
  DEFAULT_BREAKER_CONFIG,
  isBreakerAvailable,
  recordSuccess,
  recordFailure,
} from "./circuit-breaker"
import type { RetryConfig } from "./retry"
import { DEFAULT_RETRY_CONFIG, calculateDelay, sleep, isRetryableError } from "./retry"
import { executeCliOnce } from "./executor"
import type { CliAvailability } from "./detection"
import type { Platform } from "./platform"
import type { CircuitState } from "./circuit-breaker"

// ─── Structured Response (MCP pattern) ─────────────────────────────────────

export interface CliResponse {
  success: boolean
  cli: CliName
  platform: Platform
  stdout: string
  stderr: string
  duration_ms: number
  timed_out: boolean
  used_fallback: boolean
  fallback_chain: string[]
  error: string | null
  circuit_state: CircuitState
  attempt: number
  max_attempts: number
}

// ─── Usage Stats ───────────────────────────────────────────────────────────

export interface UsageStats {
  calls: number
  failures: number
  totalMs: number
}

// ─── Engine ────────────────────────────────────────────────────────────────

export interface ResilienceContext {
  breakers: Map<CliName, CircuitBreaker>
  availability: Map<CliName, CliAvailability>
  usageStats: Map<CliName, UsageStats>
  platform: Platform
  retryConfig: RetryConfig
  breakerConfig: BreakerConfig
}

export async function executeWithResilience(
  ctx: ResilienceContext,
  targetCli: CliName,
  prompt: string,
  mode: string,
  timeoutSeconds: number,
  allowFallback: boolean,
  signal?: AbortSignal,
): Promise<CliResponse> {
  const timeoutMs = timeoutSeconds * 1000
  const def = CLI_DEFS[targetCli]
  const fallbackChain: string[] = [targetCli]

  // Build execution order: target first, then fallbacks
  const executionOrder: CliName[] = [targetCli]
  if (allowFallback) {
    const available = ALL_CLI_NAMES.filter((n) => {
      const avail = ctx.availability.get(n)
      return avail?.installed !== false
    })
    for (const fb of def.fallbackOrder) {
      if (available.includes(fb)) executionOrder.push(fb)
    }
  }

  for (const cliName of executionOrder) {
    const currentDef = CLI_DEFS[cliName]
    const breaker = ctx.breakers.get(cliName)!
    const stats = ctx.usageStats.get(cliName)!

    // Check circuit breaker
    if (!isBreakerAvailable(breaker, ctx.breakerConfig)) {
      if (cliName !== targetCli) fallbackChain.push(`${cliName}(circuit-open)`)
      continue
    }

    // Check availability
    const avail = ctx.availability.get(cliName)
    if (avail?.installed === false) {
      if (cliName !== targetCli) fallbackChain.push(`${cliName}(not-installed)`)
      continue
    }

    if (cliName !== targetCli) fallbackChain.push(cliName)

    // Retry loop
    for (let attempt = 0; attempt <= ctx.retryConfig.maxRetries; attempt++) {
      if (signal?.aborted) break

      if (attempt > 0) {
        const delay = calculateDelay(attempt - 1, ctx.retryConfig)
        await sleep(delay)
      }

      try {
        stats.calls++
        const result = await executeCliOnce(currentDef, prompt, mode, timeoutMs, signal)

        recordSuccess(breaker, ctx.breakerConfig)
        stats.totalMs += result.durationMs

        return {
          success: true,
          cli: cliName,
          platform: ctx.platform,
          stdout: result.stdout,
          stderr: result.stderr,
          duration_ms: result.durationMs,
          timed_out: false,
          used_fallback: cliName !== targetCli,
          fallback_chain: fallbackChain,
          error: null,
          circuit_state: breaker.state,
          attempt: attempt + 1,
          max_attempts: ctx.retryConfig.maxRetries + 1,
        }
      } catch (err: unknown) {
        stats.failures++

        const retryable = isRetryableError(err)
        const isLastAttempt = attempt === ctx.retryConfig.maxRetries

        if (!retryable || isLastAttempt) {
          recordFailure(breaker, ctx.breakerConfig)
          break // try next CLI in fallback chain
        }
        // retryable — loop continues
      }
    }
  }

  // All CLIs exhausted
  return {
    success: false,
    cli: targetCli,
    platform: ctx.platform,
    stdout: "",
    stderr: "",
    duration_ms: 0,
    timed_out: false,
    used_fallback: fallbackChain.length > 1,
    fallback_chain: fallbackChain,
    error: `All CLI providers exhausted. Tried: ${fallbackChain.join(" → ")}. Check cli_status for details.`,
    circuit_state: ctx.breakers.get(targetCli)!.state,
    attempt: ctx.retryConfig.maxRetries + 1,
    max_attempts: ctx.retryConfig.maxRetries + 1,
  }
}

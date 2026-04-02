/**
 * Resilience Engine — orchestrates retry + circuit breaker + fallback
 * into a single execution pipeline with a global time budget.
 *
 * The global budget is shared across ALL retries and fallback attempts,
 * preventing timeout multiplication (3 providers × 3 attempts × timeout).
 */

import type { CliName } from "./cli-defs"
import { CLI_DEFS, ALL_CLI_NAMES } from "./cli-defs"
import type { CircuitBreaker, BreakerConfig } from "./circuit-breaker"
import {
  DEFAULT_BREAKER_CONFIG,
  isBreakerAvailable,
  recordSuccess,
  recordFailure,
  recordTimeout,
} from "./circuit-breaker"
import type { RetryConfig } from "./retry"
import { DEFAULT_RETRY_CONFIG, calculateDelay, sleep } from "./retry"
import { executeCliOnce } from "./executor"
import type { CliAvailability } from "./detection"
import type { Platform } from "./platform"
import type { CircuitState } from "./circuit-breaker"
import { classifyError, type ErrorClass } from "./error-classifier"
import { redactSecrets } from "./redact"

// ─── Structured Response ──────────────────────────────────────────────────

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
  error_class: ErrorClass | null
  circuit_state: CircuitState
  attempt: number
  max_attempts: number
}

// ─── Usage Stats ──────────────────────────────────────────────────────────

export interface UsageStats {
  calls: number
  failures: number
  totalMs: number
}

// ─── Engine ───────────────────────────────────────────────────────────────

export interface ResilienceContext {
  breakers: Map<CliName, CircuitBreaker>
  availability: Map<CliName, CliAvailability>
  usageStats: Map<CliName, UsageStats>
  platform: Platform
  retryConfig: RetryConfig
  breakerConfig: BreakerConfig
}

/** Merge caller signal with budget signal (compatible with all runtimes) */
function mergeAbortSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) return b
  if (!b) return a
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  a.addEventListener("abort", onAbort, { once: true })
  b.addEventListener("abort", onAbort, { once: true })
  return controller.signal
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
  const def = CLI_DEFS[targetCli]
  const fallbackChain: string[] = [targetCli]
  const errors: string[] = []

  // Build execution order: target first, then fallbacks
  const executionOrder: CliName[] = [targetCli]
  if (allowFallback) {
    for (const fb of def.fallbackOrder) {
      const avail = ctx.availability.get(fb)
      if (avail?.installed !== false) executionOrder.push(fb)
    }
  }

  // Global time budget: entire chain (retries + fallbacks) must fit within timeoutSeconds
  const globalDeadline = Date.now() + timeoutSeconds * 1000
  const budgetController = new AbortController()
  const budgetTimeout = setTimeout(() => budgetController.abort(), timeoutSeconds * 1000)
  const mergedSignal = mergeAbortSignals(signal, budgetController.signal)

  try {
    for (const cliName of executionOrder) {
      const remaining = globalDeadline - Date.now()
      if (remaining <= 0) {
        errors.push(`${cliName}: global budget exhausted`)
        break
      }

      const currentDef = CLI_DEFS[cliName]
      const breaker = ctx.breakers.get(cliName)!
      const stats = ctx.usageStats.get(cliName)!

      // Check circuit breaker
      if (!isBreakerAvailable(breaker, ctx.breakerConfig)) {
        if (cliName !== targetCli) fallbackChain.push(`${cliName}(circuit-open)`)
        errors.push(`${cliName}: circuit breaker open`)
        continue
      }

      // Check availability
      const avail = ctx.availability.get(cliName)
      if (avail?.installed === false) {
        if (cliName !== targetCli) fallbackChain.push(`${cliName}(not-installed)`)
        errors.push(`${cliName}: not installed`)
        continue
      }

      if (cliName !== targetCli) fallbackChain.push(cliName)

      // Retry loop
      for (let attempt = 0; attempt <= ctx.retryConfig.maxRetries; attempt++) {
        if (mergedSignal?.aborted) {
          errors.push(`${cliName}: aborted`)
          break
        }

        const remainingSeconds = Math.max(1, Math.floor((globalDeadline - Date.now()) / 1000))
        if (remainingSeconds <= 1) {
          errors.push(`${cliName}: global budget exhausted`)
          break
        }

        if (attempt > 0) {
          const delay = calculateDelay(attempt - 1, ctx.retryConfig)
          try {
            await sleep(delay, mergedSignal)
          } catch {
            errors.push(`${cliName}: aborted during retry backoff`)
            break
          }
        }

        stats.calls++
        const result = await executeCliOnce(currentDef, prompt, mode, remainingSeconds, mergedSignal)

        if (result.exitCode === 0 && result.stdout) {
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
            error_class: null,
            circuit_state: breaker.state,
            attempt: attempt + 1,
            max_attempts: ctx.retryConfig.maxRetries + 1,
          }
        }

        // Process timeout: skip retries, move to next provider immediately
        if (result.timedOut) {
          const err = redactSecrets(`${cliName}: process timeout (${result.durationMs}ms) — skipping retries`)
          errors.push(err)
          stats.failures++
          recordTimeout(breaker, ctx.breakerConfig)
          break
        }

        // Classify error for retry decision
        const errorClass = classifyError({ message: result.stderr, exitCode: result.exitCode })

        // Permanent and crash errors: skip retries, fallback immediately
        if (errorClass === "permanent" || errorClass === "crash") {
          const err = redactSecrets(`${cliName}: ${result.stderr || "non-retryable failure"}`)
          errors.push(err)
          stats.failures++
          recordFailure(breaker, ctx.breakerConfig)
          break
        }

        // Rate limit: wait longer before retrying
        if (errorClass === "rate_limit" && attempt < ctx.retryConfig.maxRetries) {
          const rateLimitDelay = calculateDelay(attempt + 1, {
            ...ctx.retryConfig,
            baseDelayMs: ctx.retryConfig.baseDelayMs * 3,
          })
          try {
            await sleep(rateLimitDelay, mergedSignal)
          } catch {
            errors.push(`${cliName}: aborted during rate-limit backoff`)
            break
          }
        }

        const isLastAttempt = attempt === ctx.retryConfig.maxRetries
        if (isLastAttempt) {
          const err = redactSecrets(`${cliName}: exhausted retries — ${result.stderr}`)
          errors.push(err)
          stats.failures++
          recordFailure(breaker, ctx.breakerConfig)
        }
      }

      if (mergedSignal?.aborted) break
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
      error: redactSecrets(`All providers failed: ${errors.join("; ")}`),
      error_class: "transient",
      circuit_state: ctx.breakers.get(targetCli)!.state,
      attempt: ctx.retryConfig.maxRetries + 1,
      max_attempts: ctx.retryConfig.maxRetries + 1,
    }
  } finally {
    clearTimeout(budgetTimeout)
  }
}

/**
 * Circuit Breaker — per-CLI failure isolation.
 *
 * States:
 *   closed    → normal operation, requests pass through
 *   open      → too many failures OR too many timeouts, requests are blocked
 *   half-open → cooldown elapsed, one probe request allowed
 *
 * Transitions:
 *   closed  →(N failures OR M timeouts)→  open
 *   open    →(cooldown)→                  half-open
 *   half-open →(success)→                 closed
 *   half-open →(failure/timeout)→         open
 */

export type CircuitState = "closed" | "open" | "half-open"

export interface CircuitBreaker {
  state: CircuitState
  failures: number
  timeouts: number
  successes: number
  lastFailure: number | null
  lastSuccess: number | null
  openedAt: number | null
  totalExecutions: number
  totalFailures: number
  totalTimeouts: number
}

export interface BreakerConfig {
  /** Consecutive failures before opening the circuit */
  failureThreshold: number
  /** Consecutive timeouts before opening (higher than failures: slow ≠ broken) */
  timeoutThreshold: number
  /** Ms to wait before transitioning from open → half-open */
  cooldownMs: number
  /** Successes in half-open needed to close the circuit */
  halfOpenSuccessThreshold: number
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  failureThreshold: 3,
  timeoutThreshold: 5,
  cooldownMs: 60_000,
  halfOpenSuccessThreshold: 1,
}

export function createBreaker(): CircuitBreaker {
  return {
    state: "closed",
    failures: 0,
    timeouts: 0,
    successes: 0,
    lastFailure: null,
    lastSuccess: null,
    openedAt: null,
    totalExecutions: 0,
    totalFailures: 0,
    totalTimeouts: 0,
  }
}

export function isBreakerAvailable(
  breaker: CircuitBreaker,
  config: BreakerConfig = DEFAULT_BREAKER_CONFIG,
  now: number = Date.now(),
): boolean {
  if (breaker.state === "closed") return true

  if (breaker.state === "open") {
    if (breaker.openedAt && now - breaker.openedAt >= config.cooldownMs) {
      breaker.state = "half-open"
      breaker.successes = 0
      return true
    }
    return false
  }

  // half-open: allow one probe attempt
  return true
}

export function recordSuccess(
  breaker: CircuitBreaker,
  config: BreakerConfig = DEFAULT_BREAKER_CONFIG,
  now: number = Date.now(),
): void {
  breaker.totalExecutions++
  breaker.lastSuccess = now
  breaker.failures = 0
  breaker.timeouts = 0

  if (breaker.state === "half-open") {
    breaker.successes++
    if (breaker.successes >= config.halfOpenSuccessThreshold) {
      breaker.state = "closed"
      breaker.openedAt = null
      breaker.successes = 0
    }
  }
}

export function recordFailure(
  breaker: CircuitBreaker,
  config: BreakerConfig = DEFAULT_BREAKER_CONFIG,
  now: number = Date.now(),
): void {
  breaker.totalExecutions++
  breaker.totalFailures++
  breaker.failures++
  breaker.lastFailure = now

  if (breaker.state === "half-open") {
    breaker.state = "open"
    breaker.openedAt = now
    return
  }

  if (breaker.failures >= config.failureThreshold) {
    breaker.state = "open"
    breaker.openedAt = now
  }
}

export function recordTimeout(
  breaker: CircuitBreaker,
  config: BreakerConfig = DEFAULT_BREAKER_CONFIG,
  now: number = Date.now(),
): void {
  breaker.totalExecutions++
  breaker.totalTimeouts++
  breaker.timeouts++
  breaker.lastFailure = now

  if (breaker.state === "half-open") {
    breaker.state = "open"
    breaker.openedAt = now
    return
  }

  if (breaker.timeouts >= config.timeoutThreshold) {
    breaker.state = "open"
    breaker.openedAt = now
  }
}

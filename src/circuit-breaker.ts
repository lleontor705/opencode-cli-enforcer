/**
 * Circuit Breaker — per-CLI failure isolation.
 *
 * States:
 *   closed    → normal operation, requests pass through
 *   open      → too many failures, requests are blocked
 *   half-open → cooldown elapsed, one probe request allowed
 *
 * Transitions:
 *   closed  →(N failures)→  open
 *   open    →(cooldown)→    half-open
 *   half-open →(success)→   closed
 *   half-open →(failure)→   open
 */

export type CircuitState = "closed" | "open" | "half-open"

export interface CircuitBreaker {
  state: CircuitState
  failures: number
  successes: number
  lastFailure: number | null
  lastSuccess: number | null
  openedAt: number | null
}

export interface BreakerConfig {
  /** Consecutive failures before opening the circuit */
  failureThreshold: number
  /** Ms to wait before transitioning from open → half-open */
  cooldownMs: number
  /** Successes in half-open needed to close the circuit */
  halfOpenSuccessThreshold: number
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  failureThreshold: 3,
  cooldownMs: 60_000,
  halfOpenSuccessThreshold: 1,
}

export function createBreaker(): CircuitBreaker {
  return {
    state: "closed",
    failures: 0,
    successes: 0,
    lastFailure: null,
    lastSuccess: null,
    openedAt: null,
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
  breaker.lastSuccess = now
  breaker.failures = 0

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

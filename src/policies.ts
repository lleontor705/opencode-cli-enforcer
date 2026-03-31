/**
 * Cockatiel Resilience Policies — composable retry, circuit breaker,
 * bulkhead, and timeout policies using cockatiel.
 *
 * Composition order (outermost → innermost):
 *   timeout → retry → circuit breaker → bulkhead
 */

import {
  CircuitBreakerPolicy,
  ConsecutiveBreaker,
  retry,
  handleAll,
  wrap,
  bulkhead,
  timeout,
  ExponentialBackoff,
  type IPolicy,
} from "cockatiel"

/** Per-CLI bulkhead: max 2 concurrent, queue up to 3 */
export const cliBulkhead = bulkhead(2, 3)

/** Circuit breaker: open after 3 consecutive failures, half-open after 30s */
export const circuitBreaker = new CircuitBreakerPolicy(handleAll, {
  halfOpenAfter: 30_000,
  breaker: new ConsecutiveBreaker(3),
})

/** Retry with decorrelated jitter (AWS best practice) */
export const retryPolicy = retry(handleAll, {
  maxAttempts: 3,
  backoff: new ExponentialBackoff({ initialDelay: 1000, maxDelay: 30000 }),
})

/** Default timeout: 30 seconds */
export const timeoutPolicy = timeout(30_000)

/**
 * Composed resilient policy: timeout → retry → circuit breaker → bulkhead.
 * Wrap calls with `resilientPolicy.execute(fn)`.
 */
export const resilientPolicy: IPolicy = wrap(
  timeoutPolicy,
  retryPolicy,
  circuitBreaker,
  cliBulkhead,
)

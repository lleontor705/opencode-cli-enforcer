/**
 * Retry with Exponential Backoff + Jitter
 *
 * Prevents thundering-herd by randomising wait times.
 * Only retries transient errors (timeout, rate-limit, network).
 */

export interface RetryConfig {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  /** 0–1, fraction of delay used as random jitter */
  jitterFactor: number
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 2,
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
  jitterFactor: 0.3,
}

export function calculateDelay(
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  random: number = Math.random(),
): number {
  const exponential = config.baseDelayMs * Math.pow(2, attempt)
  const capped = Math.min(exponential, config.maxDelayMs)
  const jitter = capped * config.jitterFactor * (random * 2 - 1)
  return Math.max(0, Math.round(capped + jitter))
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const err = error as Record<string, unknown>

  // Canceled errors should never be retried
  if (err.canceled === true) return false

  if (err.timedOut === true) return true

  const msg = String(err.message ?? "").toLowerCase()
  return (
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("epipe") ||
    msg.includes("socket hang up")
  )
}

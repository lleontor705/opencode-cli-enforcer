import { describe, it, expect } from "bun:test"
import {
  calculateDelay,
  isRetryableError,
  DEFAULT_RETRY_CONFIG,
  type RetryConfig,
} from "../src/retry"

describe("calculateDelay", () => {
  const config: RetryConfig = {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 10_000,
    jitterFactor: 0.3,
  }

  it("increases exponentially with attempt number", () => {
    // random=0.5 → jitter = 0 (midpoint)
    const d0 = calculateDelay(0, config, 0.5)
    const d1 = calculateDelay(1, config, 0.5)
    const d2 = calculateDelay(2, config, 0.5)
    expect(d0).toBe(1000)
    expect(d1).toBe(2000)
    expect(d2).toBe(4000)
  })

  it("caps at maxDelayMs", () => {
    const d = calculateDelay(10, config, 0.5) // 2^10 * 1000 = 1024000, capped to 10000
    expect(d).toBe(10_000)
  })

  it("applies jitter within expected bounds", () => {
    // random=0 → jitter = -30% of base
    const dMin = calculateDelay(0, config, 0)
    expect(dMin).toBe(700)

    // random=1 → jitter = +30% of base
    const dMax = calculateDelay(0, config, 1)
    expect(dMax).toBe(1300)
  })

  it("never returns negative delay", () => {
    const highJitter: RetryConfig = { ...config, jitterFactor: 1.0 }
    const d = calculateDelay(0, highJitter, 0) // 1000 + 1000 * 1.0 * (0-1) = 0
    expect(d).toBeGreaterThanOrEqual(0)
  })
})

describe("isRetryableError", () => {
  it("returns true for timeout errors", () => {
    expect(isRetryableError({ timedOut: true, message: "" })).toBe(true)
  })

  it("returns true for rate limit errors", () => {
    expect(isRetryableError({ message: "Rate limit exceeded" })).toBe(true)
    expect(isRetryableError({ message: "too many requests" })).toBe(true)
  })

  it("returns true for network errors", () => {
    expect(isRetryableError({ message: "ECONNRESET" })).toBe(true)
    expect(isRetryableError({ message: "ECONNREFUSED" })).toBe(true)
    expect(isRetryableError({ message: "ETIMEDOUT" })).toBe(true)
    expect(isRetryableError({ message: "EPIPE" })).toBe(true)
    expect(isRetryableError({ message: "socket hang up" })).toBe(true)
  })

  it("returns false for non-retryable errors", () => {
    expect(isRetryableError({ message: "Command not found" })).toBe(false)
    expect(isRetryableError({ message: "Permission denied" })).toBe(false)
    expect(isRetryableError({ message: "Invalid argument" })).toBe(false)
  })

  it("returns false for null/undefined/non-objects", () => {
    expect(isRetryableError(null)).toBe(false)
    expect(isRetryableError(undefined)).toBe(false)
    expect(isRetryableError("string")).toBe(false)
    expect(isRetryableError(42)).toBe(false)
  })
})

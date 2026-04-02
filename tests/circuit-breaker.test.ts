import { describe, it, expect } from "bun:test"
import {
  createBreaker,
  isBreakerAvailable,
  recordSuccess,
  recordFailure,
  recordTimeout,
  DEFAULT_BREAKER_CONFIG,
  type BreakerConfig,
} from "../src/circuit-breaker"

const config: BreakerConfig = {
  failureThreshold: 3,
  timeoutThreshold: 5,
  cooldownMs: 5_000,
  halfOpenSuccessThreshold: 1,
}

describe("Circuit Breaker", () => {
  it("starts in closed state", () => {
    const b = createBreaker()
    expect(b.state).toBe("closed")
    expect(b.failures).toBe(0)
    expect(b.timeouts).toBe(0)
    expect(b.totalExecutions).toBe(0)
  })

  it("remains closed after fewer failures than threshold", () => {
    const b = createBreaker()
    recordFailure(b, config)
    recordFailure(b, config)
    expect(b.state).toBe("closed")
    expect(b.failures).toBe(2)
  })

  it("opens after reaching failure threshold", () => {
    const b = createBreaker()
    for (let i = 0; i < 3; i++) recordFailure(b, config)
    expect(b.state).toBe("open")
    expect(b.openedAt).not.toBeNull()
  })

  it("blocks requests when open", () => {
    const b = createBreaker()
    for (let i = 0; i < 3; i++) recordFailure(b, config)
    expect(isBreakerAvailable(b, config, Date.now())).toBe(false)
  })

  it("transitions to half-open after cooldown", () => {
    const b = createBreaker()
    const now = 1000
    for (let i = 0; i < 3; i++) recordFailure(b, config, now)

    // Before cooldown
    expect(isBreakerAvailable(b, config, now + 4_999)).toBe(false)
    // After cooldown
    expect(isBreakerAvailable(b, config, now + 5_000)).toBe(true)
    expect(b.state).toBe("half-open")
  })

  it("closes after success in half-open state", () => {
    const b = createBreaker()
    const now = 1000
    for (let i = 0; i < 3; i++) recordFailure(b, config, now)
    isBreakerAvailable(b, config, now + 5_000) // trigger half-open

    recordSuccess(b, config, now + 5_001)
    expect(b.state).toBe("closed")
    expect(b.failures).toBe(0)
    expect(b.openedAt).toBeNull()
  })

  it("re-opens immediately on failure in half-open state", () => {
    const b = createBreaker()
    const now = 1000
    for (let i = 0; i < 3; i++) recordFailure(b, config, now)
    isBreakerAvailable(b, config, now + 5_000) // trigger half-open

    recordFailure(b, config, now + 5_001)
    expect(b.state).toBe("open")
    expect(b.openedAt).toBe(now + 5_001)
  })

  it("resets failure counter on success in closed state", () => {
    const b = createBreaker()
    recordFailure(b, config)
    recordFailure(b, config)
    expect(b.failures).toBe(2)

    recordSuccess(b, config)
    expect(b.failures).toBe(0)
    expect(b.state).toBe("closed")
  })

  it("allows requests in closed state", () => {
    const b = createBreaker()
    expect(isBreakerAvailable(b, config)).toBe(true)
  })

  it("tracks total executions across success and failure", () => {
    const b = createBreaker()
    recordSuccess(b, config)
    recordFailure(b, config)
    recordSuccess(b, config)
    expect(b.totalExecutions).toBe(3)
    expect(b.totalFailures).toBe(1)
  })
})

describe("Circuit Breaker — Timeout Tracking", () => {
  it("remains closed after fewer timeouts than threshold", () => {
    const b = createBreaker()
    for (let i = 0; i < 4; i++) recordTimeout(b, config)
    expect(b.state).toBe("closed")
    expect(b.timeouts).toBe(4)
  })

  it("opens after reaching timeout threshold (5)", () => {
    const b = createBreaker()
    for (let i = 0; i < 5; i++) recordTimeout(b, config)
    expect(b.state).toBe("open")
    expect(b.totalTimeouts).toBe(5)
  })

  it("resets timeout counter on success", () => {
    const b = createBreaker()
    recordTimeout(b, config)
    recordTimeout(b, config)
    recordSuccess(b, config)
    expect(b.timeouts).toBe(0)
  })

  it("re-opens immediately on timeout in half-open state", () => {
    const b = createBreaker()
    const now = 1000
    for (let i = 0; i < 5; i++) recordTimeout(b, config, now)
    isBreakerAvailable(b, config, now + 5_000) // trigger half-open

    recordTimeout(b, config, now + 5_001)
    expect(b.state).toBe("open")
  })

  it("timeout threshold is higher than failure threshold (slow ≠ broken)", () => {
    expect(DEFAULT_BREAKER_CONFIG.timeoutThreshold).toBeGreaterThan(
      DEFAULT_BREAKER_CONFIG.failureThreshold,
    )
  })
})

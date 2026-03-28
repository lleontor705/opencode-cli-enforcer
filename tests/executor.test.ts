import { describe, it, expect } from "bun:test"
import { truncate } from "../src/executor"

describe("truncate", () => {
  it("returns string unchanged when under limit", () => {
    expect(truncate("hello", 10)).toBe("hello")
  })

  it("returns string unchanged when exactly at limit", () => {
    expect(truncate("12345", 5)).toBe("12345")
  })

  it("truncates and adds marker when over limit", () => {
    const result = truncate("hello world", 5)
    expect(result).toStartWith("hello")
    expect(result).toContain("[truncated at 5 chars]")
  })

  it("handles empty string", () => {
    expect(truncate("", 10)).toBe("")
  })
})

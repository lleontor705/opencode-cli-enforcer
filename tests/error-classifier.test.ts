import { describe, it, expect } from "bun:test"
import { classifyError, type ErrorClass } from "../src/error-classifier"

describe("classifyError", () => {
  it("classifies SIGKILL as crash", () => {
    expect(classifyError({ message: "SIGKILL received" })).toBe("crash")
  })

  it("classifies exitCode 137 as crash", () => {
    expect(classifyError({ exitCode: 137 })).toBe("crash")
  })

  it("classifies ENOENT as crash", () => {
    expect(classifyError({ message: "ENOENT: no such file" })).toBe("crash")
  })

  it("classifies 429 as rate_limit", () => {
    expect(classifyError({ message: "HTTP 429 too many requests" })).toBe("rate_limit")
  })

  it("classifies rate limit text as rate_limit", () => {
    expect(classifyError({ message: "rate limit exceeded" })).toBe("rate_limit")
  })

  it("classifies quota as rate_limit", () => {
    expect(classifyError({ message: "quota exceeded for today" })).toBe("rate_limit")
  })

  it("classifies auth errors as permanent", () => {
    expect(classifyError({ message: "auth token expired" })).toBe("permanent")
  })

  it("classifies 401 as permanent", () => {
    expect(classifyError({ message: "HTTP 401 Unauthorized" })).toBe("permanent")
  })

  it("classifies 403 as permanent", () => {
    expect(classifyError({ message: "HTTP 403 Forbidden" })).toBe("permanent")
  })

  it("classifies not found as permanent", () => {
    expect(classifyError({ message: "command not found" })).toBe("permanent")
  })

  it("classifies unknown errors as transient", () => {
    expect(classifyError({ message: "connection reset" })).toBe("transient")
  })

  it("classifies empty errors as transient", () => {
    expect(classifyError({})).toBe("transient")
  })

  it("handles stderr field", () => {
    expect(classifyError({ stderr: "rate limit hit" })).toBe("rate_limit")
  })
})

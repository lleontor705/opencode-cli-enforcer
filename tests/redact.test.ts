import { describe, it, expect } from "bun:test"
import { redactSecrets } from "../src/redact"

describe("redactSecrets", () => {
  it("redacts sk- prefixed keys", () => {
    const text = "Error: sk-abcdefghijklmnopqrstuvwxyz1234 is invalid"
    expect(redactSecrets(text)).toBe("Error: [REDACTED] is invalid")
  })

  it("redacts ant-api prefixed keys", () => {
    const text = "Key: ant-api01234567890123456789ab"
    expect(redactSecrets(text)).toBe("Key: [REDACTED]")
  })

  it("redacts AIza prefixed keys", () => {
    const text = "google key AIzaSyB1234567890abcdefghij"
    expect(redactSecrets(text)).toBe("google key [REDACTED]")
  })

  it("redacts key- prefixed tokens", () => {
    const text = "key-abcdefghijklmnopqrstuvwx"
    expect(redactSecrets(text)).toBe("[REDACTED]")
  })

  it("redacts Bearer tokens", () => {
    const text = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig"
    expect(redactSecrets(text)).toBe("Authorization: Bearer [REDACTED]")
  })

  it("leaves clean text unchanged", () => {
    const text = "CLI 'claude' failed: timeout after 30000ms"
    expect(redactSecrets(text)).toBe(text)
  })

  it("handles empty string", () => {
    expect(redactSecrets("")).toBe("")
  })

  it("redacts multiple keys in one string", () => {
    const text = "keys: sk-aaaabbbbccccddddeeeeffffgggg and AIzaSyBaaaabbbbccccddddeeee"
    const result = redactSecrets(text)
    expect(result).not.toContain("sk-")
    expect(result).not.toContain("AIza")
    expect(result).toContain("[REDACTED]")
  })
})

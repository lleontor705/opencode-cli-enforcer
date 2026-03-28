import { describe, it, expect } from "bun:test"
import { detectPlatform, type Platform } from "../src/platform"

describe("detectPlatform", () => {
  it("returns a valid platform", () => {
    const p = detectPlatform()
    expect(["windows", "macos", "linux"]).toContain(p)
  })

  it("matches process.platform for current OS", () => {
    const p = detectPlatform()
    if (process.platform === "win32") {
      expect(p).toBe("windows")
    } else if (process.platform === "darwin") {
      expect(p).toBe("macos")
    } else {
      expect(p).toBe("linux")
    }
  })
})

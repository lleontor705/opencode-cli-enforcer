import { describe, it, expect } from "bun:test"
import { getSafeEnv, SAFE_ENV_VARS } from "../src/safe-env"

describe("SAFE_ENV_VARS", () => {
  it("includes PATH", () => {
    expect(SAFE_ENV_VARS).toContain("PATH")
  })

  it("does NOT include API key vars (CLIs handle their own auth)", () => {
    expect(SAFE_ENV_VARS).not.toContain("ANTHROPIC_API_KEY")
    expect(SAFE_ENV_VARS).not.toContain("GOOGLE_API_KEY")
    expect(SAFE_ENV_VARS).not.toContain("OPENAI_API_KEY")
  })

  it("includes Windows system vars", () => {
    expect(SAFE_ENV_VARS).toContain("USERPROFILE")
    expect(SAFE_ENV_VARS).toContain("SYSTEMROOT")
    expect(SAFE_ENV_VARS).toContain("APPDATA")
    expect(SAFE_ENV_VARS).toContain("PATHEXT")
  })

  it("includes proxy vars with both casings", () => {
    expect(SAFE_ENV_VARS).toContain("HTTP_PROXY")
    expect(SAFE_ENV_VARS).toContain("HTTPS_PROXY")
    expect(SAFE_ENV_VARS).toContain("NO_PROXY")
    expect(SAFE_ENV_VARS).toContain("http_proxy")
    expect(SAFE_ENV_VARS).toContain("https_proxy")
    expect(SAFE_ENV_VARS).toContain("no_proxy")
  })
})

describe("getSafeEnv", () => {
  it("returns an object with only safe vars", () => {
    const env = getSafeEnv()
    for (const key of Object.keys(env)) {
      expect(SAFE_ENV_VARS).toContain(key)
    }
  })

  it("includes PATH if present in process.env", () => {
    if (process.env.PATH) {
      const env = getSafeEnv()
      expect(env.PATH).toBe(process.env.PATH)
    }
  })

  it("does not include arbitrary vars", () => {
    const env = getSafeEnv()
    expect(env).not.toHaveProperty("MY_SECRET_TOKEN")
    expect(env).not.toHaveProperty("DATABASE_URL")
  })
})

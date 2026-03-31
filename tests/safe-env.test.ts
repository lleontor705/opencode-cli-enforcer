import { describe, it, expect } from "bun:test"
import { getSafeEnv, SAFE_ENV_VARS } from "../src/safe-env"

describe("SAFE_ENV_VARS", () => {
  it("includes PATH", () => {
    expect(SAFE_ENV_VARS).toContain("PATH")
  })

  it("includes API key vars", () => {
    expect(SAFE_ENV_VARS).toContain("ANTHROPIC_API_KEY")
    expect(SAFE_ENV_VARS).toContain("GOOGLE_API_KEY")
    expect(SAFE_ENV_VARS).toContain("OPENAI_API_KEY")
  })

  it("includes proxy vars", () => {
    expect(SAFE_ENV_VARS).toContain("HTTP_PROXY")
    expect(SAFE_ENV_VARS).toContain("HTTPS_PROXY")
    expect(SAFE_ENV_VARS).toContain("NO_PROXY")
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

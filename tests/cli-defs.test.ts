import { describe, it, expect } from "bun:test"
import { CLI_DEFS, ALL_CLI_NAMES, type CliName } from "../src/cli-defs"

describe("CLI Definitions", () => {
  it("defines all three CLIs", () => {
    expect(ALL_CLI_NAMES).toEqual(["claude", "gemini", "codex"])
  })

  it("each CLI has required fields", () => {
    for (const name of ALL_CLI_NAMES) {
      const def = CLI_DEFS[name]
      expect(def.name).toBe(name)
      expect(def.binary).toBeTypeOf("string")
      expect(def.description).toBeTypeOf("string")
      expect(def.strengths.length).toBeGreaterThan(0)
      expect(def.fallbackOrder.length).toBeGreaterThan(0)
      expect(def.buildArgs).toBeTypeOf("function")
    }
  })

  it("fallback order never includes self", () => {
    for (const name of ALL_CLI_NAMES) {
      const def = CLI_DEFS[name]
      expect(def.fallbackOrder).not.toContain(name)
    }
  })

  it("fallback order only references valid CLI names", () => {
    for (const name of ALL_CLI_NAMES) {
      for (const fb of CLI_DEFS[name].fallbackOrder) {
        expect(ALL_CLI_NAMES).toContain(fb)
      }
    }
  })

  it("each CLI has buildStdinArgs", () => {
    for (const name of ALL_CLI_NAMES) {
      const def = CLI_DEFS[name]
      expect(def.buildStdinArgs).toBeTypeOf("function")
    }
  })

  describe("buildStdinArgs", () => {
    it("claude stdin generate mode uses '-' placeholder for prompt", () => {
      const args = CLI_DEFS.claude.buildStdinArgs!("generate")
      expect(args).toContain("-p")
      expect(args).toContain("-")
      expect(args).toContain("--allowedTools")
      expect(args).not.toContain("test prompt")
    })

    it("claude stdin analyze mode uses '-' placeholder for prompt", () => {
      const args = CLI_DEFS.claude.buildStdinArgs!("analyze")
      expect(args).toContain("-p")
      expect(args).toContain("-")
      expect(args).toContain("--max-turns")
    })

    it("gemini stdin mode does not include prompt", () => {
      const args = CLI_DEFS.gemini.buildStdinArgs!("generate")
      expect(args).toContain("-e")
      expect(args).toContain("none")
      expect(args).not.toContain("-p")
    })

    it("codex stdin mode uses '-' placeholder for prompt", () => {
      const args = CLI_DEFS.codex.buildStdinArgs!("generate")
      expect(args).toContain("exec")
      expect(args).toContain("-")
      expect(args).toContain("--full-auto")
    })
  })

  describe("buildArgs", () => {
    it("claude generate mode includes --allowedTools", () => {
      const args = CLI_DEFS.claude.buildArgs("test prompt", "generate")
      expect(args).toContain("--allowedTools")
      expect(args).toContain("-p")
      expect(args).toContain("test prompt")
    })

    it("claude analyze mode includes --max-turns", () => {
      const args = CLI_DEFS.claude.buildArgs("test prompt", "analyze")
      expect(args).toContain("--max-turns")
      expect(args).toContain("10")
    })

    it("gemini builds correct args", () => {
      const args = CLI_DEFS.gemini.buildArgs("test prompt", "generate")
      expect(args).toContain("-e")
      expect(args).toContain("none")
      expect(args).toContain("-p")
    })

    it("codex builds correct args", () => {
      const args = CLI_DEFS.codex.buildArgs("test prompt", "generate")
      expect(args).toContain("exec")
      expect(args).toContain("--full-auto")
    })
  })
})

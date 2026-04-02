import { describe, it, expect } from "bun:test"
import { CLI_DEFS, ALL_CLI_NAMES, AGENT_ROLES, ROLE_ROUTING, buildTimeoutArgs, type CliName } from "../src/cli-defs"

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

    it("claude analyze mode uses -p flag", () => {
      const args = CLI_DEFS.claude.buildArgs("test prompt", "analyze")
      expect(args).toContain("-p")
      expect(args).toContain("test prompt")
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

describe("buildTimeoutArgs", () => {
  it("claude gets --max-turns based on remaining seconds", () => {
    const args = buildTimeoutArgs("claude", 300)
    expect(args).toContain("--max-turns")
    expect(args).toContain("10") // 300/30 = 10
  })

  it("claude max-turns clamps at minimum 2", () => {
    const args = buildTimeoutArgs("claude", 15)
    expect(args).toContain("2")
  })

  it("claude max-turns clamps at maximum 25", () => {
    const args = buildTimeoutArgs("claude", 1800)
    expect(args).toContain("25")
  })

  it("gemini returns empty array", () => {
    expect(buildTimeoutArgs("gemini", 300)).toEqual([])
  })

  it("codex returns empty array", () => {
    expect(buildTimeoutArgs("codex", 300)).toEqual([])
  })
})

describe("Role Routing", () => {
  it("defines all 6 agent roles", () => {
    expect(AGENT_ROLES).toHaveLength(6)
    expect(AGENT_ROLES).toContain("manager")
    expect(AGENT_ROLES).toContain("developer")
    expect(AGENT_ROLES).toContain("architect")
  })

  it("each role maps to a valid primary provider", () => {
    for (const role of AGENT_ROLES) {
      expect(ALL_CLI_NAMES).toContain(ROLE_ROUTING[role].primary)
    }
  })

  it("each role has valid fallbacks", () => {
    for (const role of AGENT_ROLES) {
      const routing = ROLE_ROUTING[role]
      for (const fb of routing.fallbacks) {
        expect(ALL_CLI_NAMES).toContain(fb)
      }
      expect(routing.fallbacks).not.toContain(routing.primary)
    }
  })

  it("developer routes to codex", () => {
    expect(ROLE_ROUTING.developer.primary).toBe("codex")
  })

  it("researcher routes to gemini", () => {
    expect(ROLE_ROUTING.researcher.primary).toBe("gemini")
  })

  it("architect routes to claude", () => {
    expect(ROLE_ROUTING.architect.primary).toBe("claude")
  })
})

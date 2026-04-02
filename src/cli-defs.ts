/**
 * CLI provider definitions — each LLM CLI binary, its arguments, strengths,
 * and preferred fallback order.
 */

export type CliName = "claude" | "gemini" | "codex"

export interface CliDef {
  name: CliName
  description: string
  strengths: string[]
  binary: string
  buildArgs: (prompt: string, mode: string) => string[]
  /** Build args when prompt is delivered via stdin (for large prompts). */
  buildStdinArgs?: (mode: string) => string[]
  fallbackOrder: CliName[]
}

export const CLI_DEFS: Record<CliName, CliDef> = {
  claude: {
    name: "claude",
    description: "Anthropic Claude — strong reasoning, code analysis, complex logic",
    strengths: ["reasoning", "code-analysis", "debugging", "architecture", "planning"],
    binary: "claude",
    buildArgs: (prompt, mode) =>
      mode === "analyze"
        ? ["-p", prompt]
        : ["-p", prompt, "--allowedTools", ""],
    buildStdinArgs: (mode) =>
      mode === "analyze"
        ? ["-p", "-"]
        : ["-p", "-", "--allowedTools", ""],
    fallbackOrder: ["gemini", "codex"],
  },
  gemini: {
    name: "gemini",
    description: "Google Gemini — research, trends, broad knowledge, large context",
    strengths: ["research", "trends", "knowledge", "large-context", "web-search"],
    binary: "gemini",
    buildArgs: (prompt, _mode) => ["-e", "none", "-p", prompt],
    buildStdinArgs: (_mode) => ["-e", "none"],
    fallbackOrder: ["claude", "codex"],
  },
  codex: {
    name: "codex",
    description: "OpenAI Codex — code generation, edits, refactoring",
    strengths: ["code-generation", "edits", "refactoring", "full-auto"],
    binary: "codex",
    buildArgs: (prompt, _mode) => ["exec", prompt, "--full-auto"],
    buildStdinArgs: (_mode) => ["exec", "-", "--full-auto"],
    fallbackOrder: ["claude", "gemini"],
  },
}

export const ALL_CLI_NAMES: CliName[] = ["claude", "gemini", "codex"]

/**
 * Generate CLI-specific args that hint at timeout constraints.
 * Claude: --max-turns scales with available time (~1 turn per 30s).
 * Gemini/Codex: no known timeout flags.
 */
export function buildTimeoutArgs(
  provider: CliName,
  remainingSeconds: number,
): string[] {
  switch (provider) {
    case "claude": {
      const maxTurns = Math.max(2, Math.min(25, Math.floor(remainingSeconds / 30)))
      return ["--max-turns", String(maxTurns)]
    }
    case "gemini":
      return []
    case "codex":
      return []
  }
}

// ── Role-based routing ──────────────────────────────────────────────────────

export const AGENT_ROLES = ["manager", "coordinator", "developer", "researcher", "reviewer", "architect"] as const
export type AgentRole = (typeof AGENT_ROLES)[number]

export const ROLE_ROUTING: Record<AgentRole, { primary: CliName; fallbacks: CliName[] }> = {
  manager: { primary: "gemini", fallbacks: ["claude", "codex"] },
  coordinator: { primary: "claude", fallbacks: ["gemini", "codex"] },
  developer: { primary: "codex", fallbacks: ["claude", "gemini"] },
  researcher: { primary: "gemini", fallbacks: ["claude", "codex"] },
  reviewer: { primary: "claude", fallbacks: ["gemini", "codex"] },
  architect: { primary: "claude", fallbacks: ["gemini", "codex"] },
}

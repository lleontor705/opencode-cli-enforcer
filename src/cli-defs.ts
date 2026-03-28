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
  fallbackOrder: CliName[]
}

export const CLI_DEFS: Record<CliName, CliDef> = {
  claude: {
    name: "claude",
    description: "Anthropic Claude — strong reasoning, code analysis, complex logic",
    strengths: ["reasoning", "code-analysis", "debugging", "architecture"],
    binary: "claude",
    buildArgs: (prompt, mode) =>
      mode === "analyze"
        ? ["-p", prompt, "--max-turns", "10"]
        : ["-p", prompt, "--allowedTools", ""],
    fallbackOrder: ["gemini", "codex"],
  },
  gemini: {
    name: "gemini",
    description: "Google Gemini — research, trends, broad knowledge, large context",
    strengths: ["research", "trends", "knowledge", "large-context"],
    binary: "gemini",
    buildArgs: (prompt, _mode) => ["-e", "none", "-p", prompt],
    fallbackOrder: ["claude", "codex"],
  },
  codex: {
    name: "codex",
    description: "OpenAI Codex — code generation, edits, refactoring",
    strengths: ["code-generation", "edits", "refactoring"],
    binary: "codex",
    buildArgs: (prompt, _mode) => ["exec", prompt, "--full-auto"],
    fallbackOrder: ["claude", "gemini"],
  },
}

export const ALL_CLI_NAMES: CliName[] = ["claude", "gemini", "codex"]

/**
 * Environment Variable Filtering — only passes safe variables to
 * spawned CLI processes, preventing accidental secret leakage.
 */

export const SAFE_ENV_VARS = [
  "PATH",
  "HOME",
  "USER",
  "TERM",
  "SHELL",
  "LANG",
  "LC_ALL",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "CODEX_API_KEY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
]

export function getSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of SAFE_ENV_VARS) {
    if (process.env[key]) env[key] = process.env[key]!
  }
  return env
}

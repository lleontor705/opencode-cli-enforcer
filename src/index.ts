/**
 * opencode-cli-enforcer — OpenCode plugin
 *
 * Resilient multi-LLM CLI orchestration with cross-platform support,
 * circuit breaker, retry with backoff, and automatic fallback.
 *
 * Tools exposed:
 *   cli_exec   — Execute a CLI with full resilience pipeline
 *   cli_status — Health check and observability dashboard
 *
 * Hook:
 *   experimental.chat.system.transform — injects CLI availability into agent prompts
 *   tool.execute.after — tracks legacy bash CLI usage
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"

import { PLATFORM } from "./platform"
import { CLI_DEFS, ALL_CLI_NAMES, type CliName } from "./cli-defs"
import { createBreaker, DEFAULT_BREAKER_CONFIG } from "./circuit-breaker"
import { DEFAULT_RETRY_CONFIG } from "./retry"
import { detectAllClis, type CliAvailability } from "./detection"
import { truncate } from "./executor"
import { executeWithResilience, type ResilienceContext, type UsageStats } from "./resilience"

// Agents that should NOT receive CLI injection
const NO_CLI_AGENTS = new Set(["orchestrator", "task_decomposer"])

export default ((ctx) => {
  // ── State ──────────────────────────────────────────────────────────────

  const breakers = new Map<CliName, ReturnType<typeof createBreaker>>()
  for (const name of ALL_CLI_NAMES) breakers.set(name, createBreaker())

  const cliAvailability = new Map<CliName, CliAvailability>()
  const usageStats = new Map<CliName, UsageStats>()
  for (const name of ALL_CLI_NAMES) usageStats.set(name, { calls: 0, failures: 0, totalMs: 0 })

  // Non-blocking CLI detection at startup
  let detectionDone = false
  const detectionPromise = detectAllClis().then((results) => {
    for (const [name, avail] of results) cliAvailability.set(name, avail)
    detectionDone = true
  })

  // ── Resilience Context ─────────────────────────────────────────────────

  const resCtx: ResilienceContext = {
    breakers,
    availability: cliAvailability,
    usageStats,
    platform: PLATFORM,
    retryConfig: DEFAULT_RETRY_CONFIG,
    breakerConfig: DEFAULT_BREAKER_CONFIG,
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  function getAvailableClis(): CliName[] {
    return ALL_CLI_NAMES.filter((n) => {
      const avail = cliAvailability.get(n)
      return avail?.installed !== false
    })
  }

  function buildCliReminder(): string {
    const available = getAvailableClis()
    const unavailable = ALL_CLI_NAMES.filter((n) => !available.includes(n))

    const rows = available
      .map((name) => {
        const def = CLI_DEFS[name]
        const breaker = breakers.get(name)!
        const health =
          breaker.state === "closed" ? "OK" : breaker.state === "half-open" ? "RECOVERING" : "DOWN"
        return `| ${name} | ${def.description} | ${def.strengths.join(", ")} | ${health} |`
      })
      .join("\n")

    const unavailableNote =
      unavailable.length > 0
        ? `\n> **Not installed:** ${unavailable.join(", ")} — install them to enable more providers.\n`
        : ""

    return `
## External CLI Tools (${PLATFORM})
Use \`cli_exec\` to call external LLMs — it handles OS differences, timeout, retry, and automatic fallback.
Use \`cli_status\` to check health and availability of all CLI providers.

| CLI | Description | Strengths | Health |
|-----|-------------|-----------|--------|
${rows}
${unavailableNote}
Features: auto-retry (${DEFAULT_RETRY_CONFIG.maxRetries}x with backoff), circuit breaker per CLI, fallback to next available provider.
Rules: One concern per call. Split large requests. Include "CLI Consultations" in output.
`
  }

  // ── Tools ──────────────────────────────────────────────────────────────

  return {
    tools: [
      tool({
        name: "cli_exec",
        description:
          "Execute an external CLI (claude, gemini, codex) with automatic OS detection, timeout, " +
          "retry with exponential backoff, circuit breaker protection, and fallback to alternative providers.",
        parameters: z.object({
          cli: z.enum(["claude", "gemini", "codex"]).describe("Primary CLI to invoke"),
          prompt: z.string().min(1).max(100_000).describe("The prompt to send to the CLI"),
          mode: z
            .enum(["generate", "analyze"])
            .default("generate")
            .describe("'generate' = self-contained prompt; 'analyze' = allow file reads (Claude only)"),
          timeout_seconds: z
            .number()
            .int()
            .min(10)
            .max(1800)
            .default(720)
            .describe("Max seconds before killing the process"),
          allow_fallback: z
            .boolean()
            .default(true)
            .describe("If true, automatically try alternative CLIs when the primary fails"),
        }),
        execute: async (params) => {
          await detectionPromise

          const response = await executeWithResilience(
            resCtx,
            params.cli,
            params.prompt,
            params.mode,
            params.timeout_seconds,
            params.allow_fallback,
          )

          return {
            ...response,
            stdout: truncate(response.stdout, 50_000),
            stderr: truncate(response.stderr, 5_000),
          }
        },
      }),

      tool({
        name: "cli_status",
        description:
          "Check the health and availability of all external CLI providers. " +
          "Shows installation status, circuit breaker state, and usage statistics.",
        parameters: z.object({}),
        execute: async () => {
          await detectionPromise

          const providers = ALL_CLI_NAMES.map((name) => {
            const def = CLI_DEFS[name]
            const avail = cliAvailability.get(name)
            const breaker = breakers.get(name)!
            const stats = usageStats.get(name)!
            const avgMs = stats.calls > 0 ? Math.round(stats.totalMs / stats.calls) : 0

            return {
              name,
              description: def.description,
              strengths: def.strengths,
              installed: avail?.installed ?? "unknown",
              path: avail?.path ?? null,
              version: avail?.version ?? null,
              circuit_breaker: {
                state: breaker.state,
                consecutive_failures: breaker.failures,
                failure_threshold: DEFAULT_BREAKER_CONFIG.failureThreshold,
                cooldown_seconds: DEFAULT_BREAKER_CONFIG.cooldownMs / 1000,
                opened_at: breaker.openedAt ? new Date(breaker.openedAt).toISOString() : null,
                last_failure: breaker.lastFailure
                  ? new Date(breaker.lastFailure).toISOString()
                  : null,
                last_success: breaker.lastSuccess
                  ? new Date(breaker.lastSuccess).toISOString()
                  : null,
              },
              usage: {
                total_calls: stats.calls,
                total_failures: stats.failures,
                success_rate:
                  stats.calls > 0
                    ? `${Math.round(((stats.calls - stats.failures) / stats.calls) * 100)}%`
                    : "N/A",
                avg_duration_ms: avgMs,
              },
              fallback_order: def.fallbackOrder,
            }
          })

          return {
            platform: PLATFORM,
            detection_complete: detectionDone,
            retry_config: {
              max_retries: DEFAULT_RETRY_CONFIG.maxRetries,
              base_delay_ms: DEFAULT_RETRY_CONFIG.baseDelayMs,
              max_delay_ms: DEFAULT_RETRY_CONFIG.maxDelayMs,
            },
            breaker_config: {
              failure_threshold: DEFAULT_BREAKER_CONFIG.failureThreshold,
              cooldown_seconds: DEFAULT_BREAKER_CONFIG.cooldownMs / 1000,
            },
            providers,
          }
        },
      }),
    ],

    hooks: {
      "experimental.chat.system.transform": (input: any) => {
        const agent = input.agent ?? "unknown"
        if (NO_CLI_AGENTS.has(agent)) return input
        return {
          ...input,
          content: (input.content ?? "") + buildCliReminder(),
        }
      },

      "tool.execute.after": (input: any) => {
        if (input.tool !== "bash") return input
        const cmd = String(input.args?.command ?? "")

        for (const name of ALL_CLI_NAMES) {
          const def = CLI_DEFS[name]
          if (cmd.includes(`${def.binary} `)) {
            const stats = usageStats.get(name)!
            stats.calls++
          }
        }

        return input
      },
    },
  }
}) satisfies Plugin

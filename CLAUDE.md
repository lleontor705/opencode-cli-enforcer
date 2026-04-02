# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

OpenCode CLI Enforcer — an OpenCode plugin that orchestrates Claude, Gemini, and Codex CLIs with resilience (circuit breakers, retry with backoff, automatic fallback). Published to npm as `opencode-cli-enforcer`.

## Commands

```bash
bun install              # Install dependencies
bun test                 # Run all tests
bun test --watch         # Run tests in watch mode
bun test tests/retry.test.ts  # Run a single test file
bun run typecheck        # Type-check without emitting
bun run build            # Build (no bundle)
```

Runtime is **Bun** (>=1.3.5), not Node. Tests use Bun's built-in test runner (`bun:test`). There is no linter or formatter configured.

## Architecture

The plugin exports four tools (`cli_exec`, `cli_status`, `cli_list`, `cli_route`) via the OpenCode plugin interface.

**Request flow through `cli_exec`:**

```
index.ts (plugin entry, tool definitions, hooks)
  → resilience.ts (global time budget, retry + circuit breaker + fallback)
    → circuit-breaker.ts (per-CLI isolation: 3 failures OR 5 timeouts → open)
    → retry.ts (exponential backoff with jitter, abort-aware sleep)
    → executor.ts (execa wrapper: structured results, Windows .cmd handling, PATH augmentation)
      → cli-defs.ts (arg builders + dynamic --max-turns for Claude)
      → detection.ts (CLI availability via which/where, 5-min cache)
      → safe-env.ts (allowlisted env vars only, no API keys)
      → redact.ts (strips API keys from output)
      → error-classifier.ts (transient/rate_limit/permanent/crash)
```

**Key state in `index.ts`:** three `Map`s — `breakers` (circuit breaker per CLI), `cliAvailability` (detection results), `usageStats` (call counts/timing). CLI detection runs non-blocking at startup via `Promise.allSettled`.

**Global time budget** (`resilience.ts`): a single timeout budget shared across all retries AND fallbacks, preventing timeout multiplication. Process timeouts skip retries and go straight to fallback.

**Circuit breaker** has separate thresholds: opens after 3 failures OR 5 timeouts (slow ≠ broken), cooldown 60s. **Retry**: max 2 retries, 1s base delay, 10s max, 0.3 jitter factor.

**Role-based routing** (`cli-defs.ts`): 6 agent roles (manager, coordinator, developer, researcher, reviewer, architect) map to optimal CLI providers via `cli_route`.

## Cross-Platform

- `platform.ts` exports `PLATFORM` and `IS_WINDOWS`
- Binary detection uses `which` (Unix) / `where` (Windows) with 5-minute cache
- Windows: `.cmd/.bat` shim handling via `cmd /c`, PATH augmentation (npm, scoop, cargo, pnpm)
- Large prompts (>30KB) delivered via stdin to avoid OS arg-length limits
- CI runs on ubuntu, windows, and macos

## Release

The release workflow (`.github/workflows/release.yml`) requires a production environment approval gate, publishes to npm with provenance attestation using Node 22, and creates a GitHub release with a git tag.

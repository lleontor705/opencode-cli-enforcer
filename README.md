# opencode-cli-enforcer

Resilient multi-LLM CLI orchestration plugin for [OpenCode](https://opencode.ai). Execute Claude, Gemini, and Codex CLIs with automatic OS detection, circuit breaker, retry with backoff, and provider fallback.

## Features

- **Cross-platform** — auto-detects Windows/macOS/Linux, uses [execa](https://github.com/sindresorhus/execa) for native process handling
- **Auto-detection** — probes installed CLIs at startup (`which`/`where`), reports version and path
- **Circuit breaker** — per-CLI failure isolation (closed → open → half-open) prevents cascading failures
- **Retry with backoff** — exponential backoff + jitter for transient errors (rate limits, timeouts, network)
- **Automatic fallback** — if the primary CLI fails, tries alternatives in defined order
- **Structured responses** — MCP-style JSON output with `success`, `error`, `duration_ms`, `fallback_chain`
- **Observability** — `cli_status` tool shows health, stats, and circuit state of all providers

## Installation

### From GitHub (recommended)

In your `opencode.json`:

```json
{
  "plugin": [
    "opencode-cli-enforcer@git+https://github.com/lleontor705/opencode-cli-enforcer.git"
  ]
}
```

### From npm

```bash
bun add opencode-cli-enforcer
# or
npm install opencode-cli-enforcer
```

Then in `opencode.json`:

```json
{
  "plugin": ["opencode-cli-enforcer"]
}
```

### Local (development)

```json
{
  "plugin": ["./path/to/opencode-cli-enforcer/src/index.ts"]
}
```

## Tools

### `cli_exec`

Execute an external CLI with full resilience pipeline.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `cli` | `"claude" \| "gemini" \| "codex"` | required | Primary CLI to invoke |
| `prompt` | `string` | required | The prompt to send |
| `mode` | `"generate" \| "analyze"` | `"generate"` | `analyze` enables file reads (Claude only) |
| `timeout_seconds` | `number` | `720` | Max seconds before kill (10–1800) |
| `allow_fallback` | `boolean` | `true` | Try alternative CLIs on failure |

**Response:**

```json
{
  "success": true,
  "cli": "claude",
  "platform": "windows",
  "stdout": "...",
  "stderr": "",
  "duration_ms": 4523,
  "timed_out": false,
  "used_fallback": false,
  "fallback_chain": ["claude"],
  "error": null,
  "circuit_state": "closed",
  "attempt": 1,
  "max_attempts": 3
}
```

### `cli_status`

Health check dashboard — no parameters.

```json
{
  "platform": "windows",
  "detection_complete": true,
  "retry_config": { "max_retries": 2, "base_delay_ms": 1000, "max_delay_ms": 10000 },
  "breaker_config": { "failure_threshold": 3, "cooldown_seconds": 60 },
  "providers": [
    {
      "name": "claude",
      "installed": true,
      "path": "C:\\Users\\...\\claude.exe",
      "version": "1.0.20",
      "circuit_breaker": { "state": "closed", "consecutive_failures": 0 },
      "usage": { "total_calls": 5, "success_rate": "100%", "avg_duration_ms": 3200 },
      "fallback_order": ["gemini", "codex"]
    }
  ]
}
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   cli_exec tool                  │
├─────────────────────────────────────────────────┤
│  ┌─────────┐   ┌─────────┐   ┌───────────────┐ │
│  │ Circuit  │──▶│  Retry  │──▶│   Executor    │ │
│  │ Breaker  │   │ Backoff │   │   (execa)     │ │
│  └─────────┘   └─────────┘   └───────────────┘ │
│       │              │               │           │
│       ▼              ▼               ▼           │
│  ┌─────────────────────────────────────────┐    │
│  │         Fallback Chain                   │    │
│  │   claude → gemini → codex               │    │
│  └─────────────────────────────────────────┘    │
├─────────────────────────────────────────────────┤
│  Auto-detection │ Platform │ Prompt injection    │
└─────────────────────────────────────────────────┘
```

### Resilience Pipeline

1. **Circuit breaker check** — if the CLI's circuit is open, skip to fallback
2. **Execute with retry** — up to 3 attempts with exponential backoff (1s → 2s → 4s) and ±30% jitter
3. **Record outcome** — success resets failures; failure increments counter
4. **Fallback** — if all retries exhausted, try next CLI in the fallback chain
5. **Structured response** — always returns JSON with full execution metadata

### Circuit Breaker States

| State | Behavior |
|-------|----------|
| **closed** | Normal — requests pass through |
| **open** | Blocked — 3+ consecutive failures, wait 60s cooldown |
| **half-open** | Probe — after cooldown, allow 1 request to test recovery |

## Supported CLIs

| CLI | Binary | Best For |
|-----|--------|----------|
| Claude | `claude` | Reasoning, code analysis, debugging, architecture |
| Gemini | `gemini` | Research, trends, broad knowledge, large context |
| Codex | `codex` | Code generation, edits, refactoring |

## Prerequisites

- [Bun](https://bun.sh) runtime
- At least one CLI installed: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Gemini CLI](https://github.com/google-gemini/gemini-cli), or [Codex CLI](https://github.com/openai/codex)

## Development

```bash
bun install
bun test
bun test --watch
```

## License

MIT

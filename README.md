<p align="center">
  <strong>opencode-cli-enforcer</strong><br>
  <em>Resilient multi-LLM CLI orchestration for OpenCode</em>
</p>

<p align="center">
  <a href="https://github.com/lleontor705/opencode-cli-enforcer/actions/workflows/ci.yml"><img src="https://github.com/lleontor705/opencode-cli-enforcer/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/opencode-cli-enforcer"><img src="https://img.shields.io/npm/v/opencode-cli-enforcer" alt="npm" /></a>
  <a href="https://github.com/lleontor705/opencode-cli-enforcer/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" /></a>
</p>

---

Execute Claude, Gemini, and Codex CLIs with automatic OS detection, circuit breaker pattern, retry with exponential backoff, and provider fallback. Cross-platform (Windows/macOS/Linux).

## Install

### OpenCode plugin (recommended)

```json
{
  "plugin": ["opencode-cli-enforcer@latest"]
}
```

### npm

```bash
bun add opencode-cli-enforcer
```

## Tools

### `cli_exec` — Execute a CLI with full resilience

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `cli` | `"claude" \| "gemini" \| "codex"` | required | Primary CLI |
| `prompt` | `string` | required | Prompt to send |
| `mode` | `"generate" \| "analyze"` | `"generate"` | `analyze` enables file reads (Claude) |
| `timeout_seconds` | `number` | `720` | Max seconds (10-1800) |
| `allow_fallback` | `boolean` | `true` | Try alternatives on failure |

### `cli_status` — Health check dashboard

Returns platform info, detection status, circuit breaker states, and usage stats for all providers.

## Resilience Pipeline

```
Request --> Circuit Breaker --> Retry (3x, exp backoff) --> Execute (execa)
               |                        |                        |
               v                        v                        v
          If open:                 If exhausted:            On failure:
          skip to                  try next CLI             record + retry
          fallback                 in chain
```

**Circuit Breaker States:**

| State | Behavior |
|-------|----------|
| closed | Normal — requests pass through |
| open | Blocked — 3+ failures, 60s cooldown |
| half-open | Probe — 1 request to test recovery |

**Fallback Order:** `claude --> gemini --> codex`

## Supported CLIs

| CLI | Best For |
|-----|----------|
| Claude | Reasoning, code analysis, debugging, architecture |
| Gemini | Research, broad knowledge, large context |
| Codex | Code generation, edits, refactoring |

## Prerequisites

- [Bun](https://bun.sh) runtime
- At least one CLI: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Gemini CLI](https://github.com/google-gemini/gemini-cli), or [Codex CLI](https://github.com/openai/codex)

## Development

```bash
bun install
bun test
```

## Contributing

1. Fork the repo
2. Create a feature branch from `develop`: `git checkout -b feat/my-feature develop`
3. Make your changes and add tests
4. Run `bun test`
5. Open a PR to `develop`

## License

MIT

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`opencode-cli-enforcer` is an **OpenCode v2 plugin** that registers CLI-backed model providers so users
can generate text with existing subscriptions instead of API keys. It ships two providers:

- **`claude-bridge`** — Claude Code via `@anthropic-ai/claude-agent-sdk`.
- **`agy`** — Google Antigravity CLI, driven headless over its stream-json protocol.

The core principle is separation of duties: OpenCode remains the sole tool executor and the owner of
session history, permissions, and compaction. A backend CLI only *requests* tools; every request is
routed back to the OpenCode host. Published to npm as `opencode-cli-enforcer`. MIT licensed.

`README.md` is the normative source for install, quick start, operator actions, and capability
matrices. `docs/config.md` is the normative source for the configuration reference and the
per-provider acknowledgment gate. Keep both in sync with behavior.

## Commands

```bash
npm install                                   # Install dependencies
node --import tsx --test "tests/**/*.test.ts" # Run the unit test suite
npx tsc --noEmit                              # Type-check without emitting
```

Runtime is **Node.js >= 20** (ESM-only, `"type": "module"`); tests use the built-in `node:test`
runner over `tsx`. There is no linter or formatter configured — `tsc --noEmit` plus the test suites
are the quality gates. Integration suites are opt-in via environment gates
(`CLAUDE_BRIDGE_INTEGRATION`, `AGY_BRIDGE_INTEGRATION`) and self-skip when unset.

## Architecture

Everything provider-specific lives behind seven provider-agnostic seams (`src/provider/seams.ts`), so
the second provider is a configuration-level addition rather than a second code path.

| Path | Responsibility |
|---|---|
| `src/index.ts` | Plugin entry: `Plugin.define`, setup, provider registration. |
| `src/provider/` | Provider-agnostic seams, registry, registration, model catalog, language-model adapter, prompt stream, query lifecycle/state, host tool delivery. |
| `src/stream/` | Native-event → normalized `TurnResult` mapping and stream conversion. |
| `src/session/` | Conversation mirror (REUSE/REBUILD), isolated compaction lane, attachments, mirror I/O and post-write verification. |
| `src/mcp/` | In-process MCP server and order-tolerant `tool_use`/result rendezvous. |
| `src/errors/` | Closed error taxonomy, sendable-prompt assertion, single teardown path. |
| `src/config/` | Configuration schema and fail-closed validation. |
| `src/agy/` | Google Antigravity provider: transport, event mapper, probe, session store, host-tool loopback runner. |

Key behaviors (mirror transitions, parked query + in-process MCP handshake, compaction lane, error
taxonomy, teardown/leak assertions) are described in the README's architecture overview.

## Release

The release workflow (`.github/workflows/release.yml`) requires a production environment approval
gate, publishes to npm with provenance attestation, and creates a GitHub release with a git tag.

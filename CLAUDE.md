# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`opencode-cli-enforcer` is an **OpenCode v2 plugin** that registers CLI-backed model providers so users
can generate text with existing subscriptions instead of API keys. It ships two providers:

- **`claude`** — Claude Code via `@anthropic-ai/claude-agent-sdk`.
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

Releases are automated by release-please (`.github/workflows/release-please.yml`), using the
Release-PR pattern. Conventional Commits land on `main`; on every push the bot opens or updates a
`chore(main): release X.Y.Z` pull request that bumps `package.json`, `package-lock.json`, and
`CHANGELOG.md`. Merging that PR makes the bot create the `vX.Y.Z` tag and the GitHub release with
the changelog notes. **Never create tags or releases by hand — not from the GitHub UI, not from the
CLI**: the bot owns them so the version, changelog, tag, and release notes stay in lockstep.

The bot runs with `secrets.RELEASE_PLEASE_TOKEN` (fine-grained PAT, Contents + Pull requests
read/write). The PAT is required: tags created with the built-in `GITHUB_TOKEN` do not trigger
workflows, so the tag-driven pipeline below would never run. A preflight step fails loud when the
secret is missing.

The tag push then runs `.github/workflows/release.yml`, which declares a read-only top-level token
and a `concurrency` group (`release-${{ github.ref_name }}`) that never cancels a run in progress —
an interrupted publish could leave npm and the git tag disagreeing.

Three least-privilege stages run in order:

| Stage | Purpose |
|---|---|
| `verify` | Refuses a tag that does not match the `package.json` version or that `CHANGELOG.md` does not document; typechecks, runs the unit suite, generates a CycloneDX SBOM from the lockfile (development dependencies omitted), and uploads it with 90-day retention. |
| `publish` | Runs behind the `production` environment approval gate and publishes with `npm publish --provenance`. Trusted publishing is used when `vars.NPM_TRUSTED_PUBLISHING == '1'`; otherwise `secrets.NPM_TOKEN` is required and a missing token fails loud. |
| `github-release` | Attaches the SBOM to the release-please-created release without touching the bot's notes; extracts the tag's `CHANGELOG.md` section (refusing empty notes) and creates the release with the preinstalled `gh` CLI only as a fallback. |

Budgets are 20 / 15 / 10 `timeout-minutes`; only `publish` holds `id-token: write` and only
`github-release` holds `contents: write`.

## CI/CD

CI (`.github/workflows/ci.yml`) runs on pushes and pull requests to `main`; its `concurrency` group
cancels superseded runs on the same ref.

- `test` — `ubuntu-latest` + `macos-latest` matrix across Node `20`, `22`, and `24`; purges AppleDouble
  `._*`/`.DS_Store` sidecars, installs with `npm ci` (falling back to `npm install`), typechecks, and
  runs the unit suite. The `tests/**/*.test.ts` glob is left unquoted so the shell expands it on Node
  20, where `node --test` has no built-in glob support; the Lint step is a no-op that records that
  typecheck plus tests are the gates.
- `commitlint` — lints every commit in the push or pull-request range against Conventional Commits
  (`commitlint.config.mjs` extending `@commitlint/config-conventional`), the convention release-please
  parses to cut releases; merge commits are ignored by commitlint's defaults.
- `integration` — gated on `vars.CLAUDE_BRIDGE_INTEGRATION == '1'` so forks skip cleanly; runs
  `tests/int-bridge.mjs`, `tests/int-session-mirror.mjs`, and `tests/int-agy.mjs`.
- `dependency-review` — pull requests only; fails on high-or-worse advisories and comments only when
  the review fails.

Governance: `.github/workflows/scorecard.yml` (OpenSSF Scorecard on branch-protection changes, a weekly
cron, and pushes to `main`), `.github/workflows/codeql.yml` (`javascript-typescript` with the
`security-extended` query suite), and `.github/dependabot.yml` (weekly npm and GitHub Actions updates,
with minor and patch bumps grouped and major npm bumps left ungrouped for individual review). Every
`uses:` in every workflow pins a full 40-character commit SHA with the upstream tag in a trailing
comment. The README documents the full supply-chain posture.

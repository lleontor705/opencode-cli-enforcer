# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Renamed the plugin id to `cli-providers` and the Claude provider id to `claude`.** The plugin now
  registers via `Plugin.define({ id: "cli-providers" })`, and the Claude Code provider is published
  as `claude` (previously `claude-bridge`), so models are referenced as `claude/claude-sonnet-5`.
  This is a breaking change for saved `claude-bridge/<model>` references: update them to
  `claude/<model>`. Diagnostic messages now use the `cli-providers:` prefix and the stream
  provider-metadata key is `claude`; the `CLAUDE_BRIDGE_INTEGRATION` CI gate, the `AGY_BRIDGE_*`
  gates, and the internal `ClaudeBridge*` symbols are unchanged.

## [2.0.1] - 2026-10-16

### Changed

- **Redesigned the CI/CD and supply-chain posture** around the npm publish path.
  - Every `uses:` across all workflows is pinned to a full 40-character commit SHA with the upstream
    tag in a trailing comment; Dependabot's `github-actions` ecosystem keeps those pins moving.
  - Every workflow declares a read-only top-level permission grant and escalates per job. In the release
    pipeline only the `publish` job requests `id-token: write` (npm provenance / OIDC trusted publishing)
    and only the GitHub-release job requests `contents: write`; the Scorecard workflow separately
    requests `id-token: write` for its own OIDC results publication.
  - Every job carries an explicit `timeout-minutes`, and each workflow's `concurrency` group bounds
    runner consumption by cancelling superseded runs (the release group never cancels a publish).
  - Pull requests run `actions/dependency-review-action` and fail on high-or-worse severity advisories.
  - The release pipeline is now three least-privilege stages — `verify`, `publish`, `github-release` —
    behind a `production` environment approval gate, publishing with `npm publish --provenance`, with a
    CycloneDX SBOM generated in `verify` and attached to the GitHub release, and release notes
    extracted from this file that refuse to publish empty.

### Added

- **Dependency and vulnerability governance workflows**: OpenSSF Scorecard (branch-protection changes,
  a weekly cron, and pushes to `main`; SARIF findings uploaded and retained 14 days), CodeQL for
  `javascript-typescript` with the `security-extended` query suite, and weekly Dependabot updates for
  the `npm` and `github-actions` ecosystems with grouped minor/patch bumps and ungrouped major npm
  bumps.

### Fixed

- **Documentation drift**: `CLAUDE.md` described a release approval gate and a GitHub release that the
  workflow did not previously implement, and said nothing about the CI gates or the governance
  workflows. The release section now describes the pipeline that actually runs, the README documents
  the supply-chain posture, and this entry records the change.

## [2.0.0] - 2026-10-10

The plugin was rewritten from scratch as an **OpenCode v2 model-provider bridge**. This is a
**breaking change** relative to the legacy multi-CLI orchestration plugin and shares no runtime
surface with it.

### Breaking changes

- **Replaced multi-CLI orchestration with provider bridging.** The legacy plugin orchestrated the
  `claude`, `gemini`, and `codex` CLIs with circuit breakers, retry-with-backoff, fallback, and
  role-based routing, and exposed four tools (`cli_exec`, `cli_status`, `cli_list`, `cli_route`).
  The v2 plugin exposes **no tools of its own**; instead it registers model providers that OpenCode
  drives directly. The old `cli_*` tools and their role-based routing no longer exist.
- **Runtime moved from Bun to Node.js.** The plugin is ESM-only, declares `"type": "module"`, and
  targets Node.js >= 20. The Bun lockfile and Bun test runner were dropped; `package-lock.json` is
  the canonical lockfile and the tests run under the Node.js built-in test runner via `tsx`.
- **Configuration shape changed.** Options now live under a `providers` map plus `defaultProvider`
  (see [docs/config.md](docs/config.md)); the legacy per-CLI settings are gone.

### Added — Wave A: Claude Code provider (`claude-bridge`)

- Registers the Claude Code CLI as a first-class provider (id **`claude-bridge`**) through
  `@anthropic-ai/claude-agent-sdk`, with a static catalog across the `fable`, `opus`, `sonnet`, and
  `haiku` families, so a Claude subscription can be used **without an `ANTHROPIC_API_KEY`**.
- Seven provider-agnostic Layer-1 seams (`src/provider/seams.ts`) so a second provider is a
  configuration addition rather than a rewrite.
- A single parked Agent SDK `query()` per OpenCode session with an ack-carrying prompt stream, plus
  an in-process MCP server and a two-map, order-tolerant rendezvous so OpenCode remains the sole tool
  executor and approval authority.
- A REUSE/REBUILD session mirror into Claude Code's `~/.claude/projects` JSONL, gated by a
  fail-closed post-write integrity check, plus an isolated one-off compaction lane that keeps
  OpenCode the sole compactor.
- A closed error taxonomy (`config`, `transport`, `tool`, `stream`, `rate-limit`, `session-mirror`),
  a single teardown path, and fail-loud leak assertions.

### Added — Wave B: Google Antigravity adapter (`agy`)

- Adapts the Google Antigravity CLI (`agy`) behind the **same seven seams**, so it ships as
  configuration rather than a second code path.
- Host tools reach `agy` through a spawned stdio MCP runner that forwards to a loopback HTTP bridge
  bound to `127.0.0.1` with a per-process bearer token; the runner reuses the same fail-closed tool
  server the `claude` path uses.
- Honest capability downgrades documented in the README capability matrix: no reasoning text stream,
  no partial tool input, step-level streaming, no mid-turn steering, no interactive approval, and no
  REUSE/REBUILD mirror (resume is by opaque `conversationRef`, with a clean start on divergence).
- Cumulative-per-session usage is normalized to per-turn deltas through an out-of-band baseline
  ledger so a resumed session is never double-counted.
- Declarative `settings.json` allow-rules with MCP-side denial, and an opt-in
  `--dangerously-skip-permissions` consent flag.

### Added — acknowledgment gate

- Every provider carries a constraint register; enabling a provider whose register is not fully
  acknowledged fails closed with a config error naming every missing constraint id.
  - `claude` (acknowledged by default): `child-env-hygiene`, `session-mirror-rebuild-cost`.
  - `agy` (all four required): `tos-third-party-access-ambiguity`, `fatal-control-frames`,
    `no-mid-turn-steer`, `auto-allowed-workspace-writes`.
- The `agy` Terms-of-Service constraint is an explicit operator legal-risk decision. See
  [docs/agy-tos-acknowledgment.md](docs/agy-tos-acknowledgment.md).

### Operator actions

- **Install and authenticate the Claude Code CLI** (subscription login, no API key) on the same
  machine; the bridge spawns it but does not ship it.
- **Install and authenticate the `agy` CLI** (run it once to cache OAuth credentials) when using the
  `agy` provider; the bridge only checks that the token file exists and never reads it.
- **Migrate configuration** to the `providers.{claude,agy}` shape and complete the acknowledgment
  gate before enabling a provider (see [docs/config.md](docs/config.md)).
- **Restart the OpenCode service** after editing `opencode.jsonc` so the plugin reloads and
  registers its providers.
- **Never export `ANTHROPIC_*`** (especially `ANTHROPIC_API_KEY`) into the environment that launches
  OpenCode; it would hijack the child CLI's subscription auth.
- **Set `CLAUDE_CONFIG_DIR`** to relocate the session-mirror root; leave it unset to use `~/.claude`.
- **Integration/dev gates:** `CLAUDE_BRIDGE_INTEGRATION=1` (Wave A live-CLI oracle, also the CI
  integration-job gate), `AGY_BRIDGE_INTEGRATION=1` (Wave B live-CLI oracle), and
  `AGY_BRIDGE_RECORD=1` (quota-spending fixture recording). Each skips cleanly when unset.

### Changed — repo hygiene

- Removed the stale `bun.lock`; the repository is npm/Node-based and commits `package-lock.json`.
- Fixed the `test` script to the working Node form `node --import tsx --test tests/**/*.test.ts`
  (the old `node --test tests` fails on Node 24 with `ERR_UNSUPPORTED_DIR_IMPORT`).
- `.gitignore` now covers `/.cortex-ia/` and macOS AppleDouble `._*` sidecars alongside
  `node_modules/` and `dist/`.

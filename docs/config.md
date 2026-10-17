# Configuration reference

`opencode-cli-enforcer` reads all of its options from the `options` object of its `opencode.jsonc`
plugin entry. That object is handed to the plugin as `ctx.options` and validated by
`resolveConfig` in `src/config/schema.ts` **before any provider is registered**. Validation is
**fail-closed**: an invalid option set throws and the plugin stays inactive, with nothing partially
applied.

```jsonc
{
  "plugins": [
    {
      "package": "opencode-cli-enforcer",
      "options": {
        "providers": {
          "claude": { "enabled": true },
          "agy": { "enabled": false }
        },
        "defaultProvider": "claude"
      }
    }
  ]
}
```

## Top-level options

| Key | Type | Default | Description |
|---|---|---|---|
| `providers` | object | `{}` | Per-provider enablement and options map. Only known provider ids are accepted (`claude`, `agy`). |
| `defaultProvider` | `"claude"` \| `"agy"` | `"claude"` | Provider selected by default. The chosen provider must be enabled. |

Unknown top-level keys are rejected. `defaultProvider` naming a provider that is not enabled is
rejected. There is no implicit "first enabled provider" fallback.

## `providers.claude`

The Claude Code provider (provider id `claude`).

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Register the `claude` provider and its model catalog. |
| `modelOverride` | string \| null | `null` | Force a single model id for every request, instead of the model OpenCode selected from the catalog. |
| `debugLogs` | boolean | `false` | Enable verbose bridge logging for diagnostics. |
| `toolsAllow` | string[] \| null | `null` | Optional allowlist of host tool names the bridge will serve to Claude Code. `null` serves the full host tool set. |
| `acknowledgedConstraints` | string[] | all `claude` constraint ids | Explicit acknowledgment of the provider's constraint register. Defaults to fully acknowledged. |

## `providers.agy`

The Google Antigravity CLI provider (shipped in **Wave B**). Enabling it requires the full `agy`
constraint register to be acknowledged (see the [acknowledgment gate](#acknowledgment-gate)).

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Enable the `agy` provider and its model catalog. Requires the full `agy` constraint register to be acknowledged. |
| `acknowledgedConstraints` | string[] | `[]` | Explicit acknowledgment of the provider's constraint register. All four `agy` constraints are required to enable the provider. |
| `dangerouslySkipPermissionsConsent` | boolean | `false` | Operator consent for `agy`'s `--dangerously-skip-permissions` mode. `agy` auto-allows workspace writes by default, so this is an explicit opt-in to that behavior. |

Enabling `agy` also starts the host-tool path: the plugin runs a loopback HTTP bridge
(`127.0.0.1`, per-process bearer token) and builds a stdio MCP runner command that `agy` spawns to
reach OpenCode's tools. The runner is served by `src/agy/runner.ts`; the bridge is never routable
beyond loopback, and the hop reuses the same fail-closed tool server the `claude` path uses.

### agy MCP registration (opt-in)

Registering the runner with `agy mcp add` rewrites a single **user-level** file
(`~/.gemini/config/mcp_config.json`) shared with any other MCP server the operator registered;
`agy` v1.3.2 has no per-project scoping flag. Because that mutation is machine-global, registration
defaults to a **dry-run manifest** and is only performed when the operator explicitly opts in. The
manifest always carries the real runner command and the `agy mcp add …` argv, so the operator can
apply it deliberately.

### agy permissions (declarative)

`agy` has no interactive approval callback (`supportsInteractiveApproval = false`). Enforcement is a
declarative `settings.json` allow list applied at the MCP boundary plus the opt-in
`--dangerously-skip-permissions` flag described above. A tool absent from the allow list is denied at
the MCP boundary rather than silently executed; without `dangerouslySkipPermissionsConsent` the
bypass flag is never emitted.

### agy resume accounting

`agy` reports cumulative-per-session usage (`result.usage`, `num_turns`). The bridge keeps the last
cumulative total per conversation in an out-of-band ledger (`AgyUsageBaselineLedger`) and seeds the
mapper's baseline before a resumed turn (`--conversation <uuid>`), so a resumed turn reports only its
own delta and the session is never double-counted. The opaque session handle
(`{provider: "agy", conversationRef}`) is serialized separately; the ledger is in-memory only.

### agy prerequisites and environment gates

- **agy CLI with cached credentials.** The probe only checks that `agy` is on `PATH` and that the
  cached OAuth token file exists (`~/.gemini/antigravity-cli/antigravity-oauth-token`); the token is
  never opened or read. Run `agy` once to complete OAuth login.
- `AGY_BRIDGE_INTEGRATION=1` runs the live-CLI integration oracle (skips cleanly with an
  operator-action reason when unset).
- `AGY_BRIDGE_RECORD=1` enables the quota-spending fixture recorder.

Neither gate is set by the plugin at runtime.

## Child-environment hygiene

The bridge does not pass a raw `process.env` to the backend CLI. Instead, `buildChildEnv` applies a
fixed hygiene set and scrubs sensitive prefixes from the inherited environment:

| Variable | Value | Reason |
|---|---|---|
| `ENABLE_CLAUDEAI_MCP_SERVERS` | `"0"` | Keep the user's claude.ai cloud connectors out of the child; OpenCode owns the tool channel. |
| `DISABLE_AUTO_COMPACT` | `"1"` | Keep OpenCode the sole compactor; the bridge drives compaction through its own isolated lane. |
| `ANTHROPIC_*` (prefix scrub) | removed | An exported `ANTHROPIC_API_KEY` (or any `ANTHROPIC_*` value) must not hijack the child CLI's subscription auth. |

**Operator guidance:** never export `ANTHROPIC_*` variables (especially `ANTHROPIC_API_KEY`) into the
environment that launches the OpenCode server. The scrub is defense in depth, not a substitute for a
clean environment. The same hygiene set is applied to the isolated compaction summarizer lane.

## `CLAUDE_CONFIG_DIR` behavior

The session mirror writes Claude Code session JSONL under the Claude config root. The bridge resolves
that root in this order:

1. the explicit `claudeDir` option when a caller supplies one (used by tests),
2. the `CLAUDE_CONFIG_DIR` environment variable,
3. `~/.claude` as the fallback.

Within the resolved root, sessions land under `projects/` — the same location the `claude` CLI uses,
which is what lets a mirrored conversation be reopened from either side. Set `CLAUDE_CONFIG_DIR` to
relocate both at once; leave it unset to use the default `~/.claude`. The mirror never parses a
provider's own storage format through the core seams — `src/session/io.ts` owns reading and writing
that layout, and every write is gated by a fail-closed post-write integrity check.

## Fail-closed validation semantics

Validation runs once, at setup, before any registration. On any error it throws a `ConfigError`
with the stable code `config/invalid-options` and a message that names the offending path. Nothing is
registered when validation fails.

Error messages are path-anchored. Examples:

| Invalid input | Error message (pattern) |
|---|---|
| `{ "providers": { "claude": { "toolsAllow": "yes" } } }` | `providers.claude.toolsAllow: expected string[], received string` |
| `{ "providers": { "claude": { "enabled": "yes" } } }` | `providers.claude.enabled: expected boolean, received string` |
| `{ "providers": { "claude": { "unknownOption": true } } }` | `providers.claude.unknownOption: unknown option` |
| `{ "providers": { "gemini": { "enabled": true } } }` | `providers.gemini: unknown option` |
| `{ "defaultProvider": "gemini" }` | `defaultProvider: expected one of claude, agy, received "gemini"` |
| `{ "defaultProvider": "agy" }` | `defaultProvider: provider "agy" is not enabled` |

Numeric or malformed types are reported the same way, e.g. `providers.claude.modelOverride: expected
non-empty string, received number` or `providers.claude.toolsAllow[1]: expected non-empty string,
received number`.

## Acknowledgment gate

Each provider carries a **constraint register**. Enabling a provider whose register is not fully
acknowledged is rejected with a config error that names **every missing** constraint id; a partial
acknowledgment list is not accepted. Acknowledging an unknown constraint id is also rejected.

### `claude` constraint register

| Constraint id | Meaning |
|---|---|
| `child-env-hygiene` | The Claude Code child must receive a scrubbed environment (`ENABLE_CLAUDEAI_MCP_SERVERS=0`, `DISABLE_AUTO_COMPACT=1`, `ANTHROPIC_*` removed) so an exported `ANTHROPIC_API_KEY` cannot hijack subscription auth. |
| `session-mirror-rebuild-cost` | Host history rewrites (compaction or revert) force a full session-mirror rebuild, which re-sends the whole conversation and accepts a prompt-cache miss. |

The `claude` register is acknowledged by default, so `providers.claude.enabled = true` needs no
extra configuration. If you pass `acknowledgedConstraints` explicitly, it must include both ids.

### `agy` constraint register

All four ids below must be present in `providers.agy.acknowledgedConstraints` before
`providers.agy.enabled` may be `true`.

| Constraint id | Meaning |
|---|---|
| `tos-third-party-access-ambiguity` | Google Antigravity Additional Terms leave programmatic third-party access ambiguous (Google AI Developer Forum threads `185992`, `186954`, `185494`, `186952`, `187241`). Enabling `agy` is an explicit operator legal-risk decision. |
| `fatal-control-frames` | In-stream `control_request` / `control_response` frames and slash commands are fatal to the `agy` child (exit `2`); only `user` message events may be written to stdin. |
| `no-mid-turn-steer` | `agy` cannot be steered mid-turn; steering requests are queued and delivered at the next turn boundary. |
| `auto-allowed-workspace-writes` | `agy` auto-allows workspace writes by default; permission enforcement relies on declarative allow-rules and explicit `--dangerously-skip-permissions` consent. |

Example — enabling `agy` with the full acknowledgment:

```jsonc
{
  "providers": {
    "agy": {
      "enabled": true,
      "acknowledgedConstraints": [
        "tos-third-party-access-ambiguity",
        "fatal-control-frames",
        "no-mid-turn-steer",
        "auto-allowed-workspace-writes"
      ],
      "dangerouslySkipPermissionsConsent": true
    }
  },
  "defaultProvider": "agy"
}
```

Missing every acknowledgment (`{ "providers": { "agy": { "enabled": true } } }`) fails with:

```
providers.agy.acknowledgedConstraints: provider "agy" is enabled but its constraint register is not
fully acknowledged; missing: tos-third-party-access-ambiguity, fatal-control-frames,
no-mid-turn-steer, auto-allowed-workspace-writes
```

A partial list names only the constraint ids that are still missing; an unknown id such as
`made-up-constraint` is reported as `providers.agy.acknowledgedConstraints: unknown constraint
id(s): made-up-constraint`.

> The `agy` provider ships in **Wave B**. The gate is enforced by the schema so that enabling it
> cannot silently succeed without the operator's explicit acknowledgment. The operator-facing
> acknowledgment record and constraint summary live in
> [agy-tos-acknowledgment.md](agy-tos-acknowledgment.md).

## Defaults at a glance

Resolving `resolveConfig({})` yields:

```jsonc
{
  "providers": {
    "claude": {
      "enabled": true,
      "modelOverride": null,
      "debugLogs": false,
      "toolsAllow": null,
      "acknowledgedConstraints": ["child-env-hygiene", "session-mirror-rebuild-cost"]
    },
    "agy": {
      "enabled": false,
      "dangerouslySkipPermissionsConsent": false,
      "acknowledgedConstraints": []
    }
  },
  "defaultProvider": "claude",
  "childEnv": {
    "set": { "ENABLE_CLAUDEAI_MCP_SERVERS": "0", "DISABLE_AUTO_COMPACT": "1" },
    "scrubPrefixes": ["ANTHROPIC_"]
  }
}
```

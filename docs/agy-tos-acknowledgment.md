# agy (Google Antigravity CLI) — Pre-Implementation ToS Acknowledgment Gate

**Status**: blocking gate. This document is the hard prerequisite for every Wave B task
(`cb-21`..`cb-27`) on board `claude-bridge-v2`. No agy transport, mapping, persistence, channel,
or probe code may be written until the operator has completed the
[Acknowledgment Checklist](#4-operator-acknowledgment-checklist) below and recorded it in the
[Decision Record](#5-decision-record).

**Requirement**: `REQ-CB-AGY-001` (gate half), design decision `D12`.

**Evidence source**: Cortex project `opencode-cli-enforcer`, observation
`discovery/agy-cli-bridge-viability` (#576), plus design chunks `D11`/`D12` (#598) and the task DAG
(#600, #603).

---

## 1. Scope — what the Wave B agy adapter will do

The agy adapter is a second provider implementation of the seven provider-agnostic Layer-1 seams
defined in `src/provider/seams.ts` (`cb-02`). It ships **no new seam interfaces**: every
agy-specific behavior is confined behind the existing contracts, and the provider registry
(`src/provider/registry.ts`) is the only place that binds `agy` to these implementations.

| Seam | agy implementation (Wave B) |
|---|---|
| `CliTransport` | Spawns the `agy` binary and speaks the raw documented stream-json protocol over stdin/stdout: argv `--input-format stream-json --output-format stream-json`, session resume via `--conversation <id>`. The stdin NDJSON writer applies a **hard input filter** that emits only `user` message events and fails loud (taxonomy transport error) on anything else. Includes a per-turn watchdog/timeout. |
| `EventMapper<Raw, Normalized>` | Maps `init` / `step_update` / `result` NDJSON events to the normalized `TurnResult{status, text, usage, sessionId}`. Cumulative-per-session `usage`/`num_turns` are converted to turn-scoped deltas at the seam. Step-level event granularity is documented as a capability downgrade. |
| `SessionStore` | Captures the opaque handle `{provider: "agy", conversationRef: <uuid>}` from `init`/`result` events and resumes with `--conversation`. The client-side SQLite conversation store (`~/.gemini/antigravity-cli/conversations/*.db`) is **never** parsed by core or adapter. |
| `ToolChannel` | Registers host tools through a spawned **out-of-process stdio MCP server** (`agy mcp add`, default type `stdio`) instead of an in-process rendezvous. Server names are defensively namespaced to avoid collisions. |
| `PermissionPolicy` | Reports `supportsInteractiveApproval = false`. Enforcement relies on declarative `settings.json` allow-rules, MCP-side enforcement, and an explicit `--dangerously-skip-permissions` consent flag. |
| `SteeringPolicy` | Reports `supportsMidTurnSteer = false`. Steering requests are queued and delivered at the next turn boundary. |
| `ProviderProbe` | Version detection plus cached-credential health check; used by the registry so `agy` models become selectable only when the provider is enabled **and** the constraint register is fully acknowledged. |

**Note on this task**: `cb-20` intentionally ships **zero transport code**. It produces this
document and the deterministic gate test `tests/agy/gate.test.ts` only. Wave B implementation
(`cb-21`..`cb-27`) is blocked on it.

---

## 2. Risk register (D12 constraint register)

The register below is the full `D12` constraint set. The four rows marked **gate id** are the
constraint ids enforced by `AGY_CONSTRAINTS` in `src/config/schema.ts`; the acknowledgment gate
(`providers.agy.acknowledgedConstraints`) must cover all four before `providers.agy.enabled = true`
is accepted.

| Register id | Constraint | Consequence if unmitigated | Mitigation |
|---|---|---|---|
| `tos-third-party-access-ambiguity` **(gate id)** | Google Antigravity Additional Terms §6 leaves programmatic third-party access ambiguous (forum threads `185992`, `186954`, `185494`, `186952`, `187241`). | Operator may breach the subscription terms by orchestrating `agy` from another AI tool. | This document: explicit operator legal decision + config-level acknowledgment gate before enablement. |
| `fatal-control-frames` **(gate id)** | In-stream `control_request` / `control_response` frames and slash commands are **fatal** to the `agy` child (process exits `2`). Input is restricted to text blocks. | A single malformed frame kills the session with no tool rendezvous and no interactive approval. | `CliTransport` hard-filters stdin to `user` events only and raises a taxonomy transport error on any other frame instead of spawning a fatal exit-2 child. |
| `no-mid-turn-steer` **(gate id)** | The protocol provides no mid-turn steering or interactive permission rendezvous. | Users cannot interrupt or re-scope a turn in flight. | `SteeringPolicy` queues steering and delivers it at the next turn boundary; the downgrade is documented to users. |
| `auto-allowed-workspace-writes` **(gate id)** | `agy` auto-allows workspace writes by default. | File mutations occur without per-action host approval. | Declarative `settings.json` allow-rules, MCP-side enforcement, and explicit `--dangerously-skip-permissions` consent gated by a config flag. |
| no-ts-sdk-protocol-drift (informational) | The official SDK is **Python-only** (`pip google-antigravity`); there is **no TypeScript SDK**, so the adapter must drive the raw documented stream-json protocol. The protocol is not a versioned, stability-guaranteed contract. | Silent breakage on `agy` upgrades. | Fail-loud assertions, recorded fixtures per CLI version, and an integration smoke gate on dependency/CLI bumps. |
| cumulative-session-usage (informational) | `usage` / `num_turns` are cumulative per session, not per turn. | Double-counting in host token accounting. | Normalize cumulative values to turn-scoped deltas inside `EventMapper`, never in core. |
| headless-hang-318 (informational) | Known headless hang: `google-antigravity/antigravity-cli#318`. | A turn can hang indefinitely. | Enforce `--print-timeout` plus a process watchdog in `CliTransport`. |

---

## 3. Terms of Service position (Antigravity Additional Terms §6)

Google's **Antigravity Additional Terms §6** contains a third-party-access clause whose application
to headless orchestration from another AI tool is **not resolved by Google**. Multiple threads on the
Google AI Developer Forum raise this exact ambiguity:

- [discuss.ai.google.dev/t/185992](https://discuss.ai.google.dev/t/185992) — thread `185992`
- [discuss.ai.google.dev/t/186954](https://discuss.ai.google.dev/t/186954) — thread `186954`
- [discuss.ai.google.dev/t/185494](https://discuss.ai.google.dev/t/185494) — thread `185494`
- [discuss.ai.google.dev/t/186952](https://discuss.ai.google.dev/t/186952) — thread `186952`
- [discuss.ai.google.dev/t/187241](https://discuss.ai.google.dev/t/187241) — thread `187241`

**This is the operator's legal decision, not the plugin's.** The plugin only *enforces* an
acknowledgment gate; it does not interpret the terms, grant permission, or provide legal advice.
Enabling `providers.agy` is an explicit assumption of risk by the operator running the plugin. If
the operator is not comfortable with that risk, `providers.agy` must remain disabled, and Wave B
implementation must not proceed.

---

## 4. Operator acknowledgment checklist

Complete every item before setting `providers.agy.enabled = true` (each item maps 1:1 to a gate id
enforced by `AGY_CONSTRAINTS` in `src/config/schema.ts`).

- [ ] `tos-third-party-access-ambiguity` — I have read §3 above and the five linked Google AI
  Developer Forum threads, and I accept as the operator that orchestration of `agy` from this
  plugin is my own legal risk decision.
- [ ] `fatal-control-frames` — I understand that `control_request` / `control_response` frames and
  slash commands are fatal (exit `2`) and that the transport hard-filters stdin to `user` events.
- [ ] `no-mid-turn-steer` — I understand that `agy` cannot be steered mid-turn and that steering is
  queued and delivered at the next turn boundary.
- [ ] `auto-allowed-workspace-writes` — I understand that `agy` auto-allows workspace writes by
  default and that enforcement relies on declarative allow-rules and an explicit
  `--dangerously-skip-permissions` consent flag.

Configuration form (all four ids must be present before enablement; a partial list is rejected):

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
      ]
    }
  }
}
```

---

## 5. Decision record

| Field | Value |
|---|---|
| Operator (name / handle) | ______________________________ |
| Decision | [ ] Acknowledged — enable `providers.agy`  [ ] Declined — keep `providers.agy` disabled |
| Forum threads reviewed (§3) | 185992, 186954, 185494, 186952, 187241 |
| Constraint register covered | tos-third-party-access-ambiguity, fatal-control-frames, no-mid-turn-steer, auto-allowed-workspace-writes |
| Signature | ______________________________ |
| Date (UTC) | ______________________________ |

Recorded decision unlocks Wave B tasks `cb-21`..`cb-27`. Until this record is signed, those tasks
remain blocked.

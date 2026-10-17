/**
 * Minimal AI SDK provider package shim for the `agy` (Google Antigravity CLI)
 * bridge (REQ-CB-AGY-001, design D11/D12).
 *
 * OpenCode resolves a provider's `package` field in one of two ways:
 *
 *   - a native `@opencode/ai/providers/*` (or `@ai-sdk/*`) package that exports
 *     `model(modelID, settings)`, or
 *   - an `aisdk:`-prefixed package whose npm module exports a factory whose name
 *     starts with `create`; OpenCode installs/imports that module and calls the
 *     factory to obtain an AI SDK provider whose `languageModel(id)` is the model.
 *
 * The agy bridge never speaks the AI SDK over HTTP - generation is driven by the
 * `ctx.aisdk.hook("language", ...)` registration in `src/index.ts`, which
 * supplies the real `LanguageModelV3` adapter. This module exists only so the
 * `aisdk:` path is taken (instead of trying to `npm install antigravity-cli`
 * and read a `model` export that does not exist): its `create*` factory returns a
 * harmless marker SDK that is never actually used for generation, because the
 * language hook overrides `event.language` before `sdk.languageModel` is ever
 * consulted.
 *
 * `loadSDKFactory` (opencode core) imports this file directly via its `file://`
 * URL, so it must remain a plain, dependency-free ESM module.
 */
export function createAgyProviderSdk(_options) {
  return {
    languageModel: (_modelId) => {
      throw new Error(
        "agy: the dummy SDK's languageModel was invoked; the LanguageModelV3 adapter must be supplied by the aisdk language hook",
      )
    },
  }
}

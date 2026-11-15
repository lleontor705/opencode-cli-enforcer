/**
 * Plain-ESM `aisdk:` provider shim for `claude` (REQ-CB-PROV-001).
 * Loaded by OpenCode v2's JS loader before `ctx.aisdk.hook("language", ...)`
 * supplies the real `LanguageModelV3` adapter. Must contain no TS syntax.
 */
export function createClaudeBridgeProviderSdk(_options) {
  return {
    languageModel: (_modelId) => {
      throw new Error(
        "claude: the dummy SDK's languageModel was invoked; the LanguageModelV3 adapter must be supplied by the aisdk language hook",
      );
    },
  };
}

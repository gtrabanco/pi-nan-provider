path-protection-records@1
justification | test/compat.test.ts | P1 | 2026-09-29 | execute-phase | Type-level adaptation: ProviderModelConfig union requires cast to access contextWindow/maxTokens; assertions unchanged
justification | test/mcp-media.test.ts | P2 | 2026-09-29 | execute-phase | Type-level adaptation: ExtensionToolContext supersedes ExtensionContext for tool.execute ctx param; assertions unchanged
justification | test/mcp-media.test.ts:29 | P2a | 2026-09-29 | execute-phase | Type-level: ctxWithKey return cast fixed from ExtensionContext to ExtensionToolContext; same mock data
justification | test/mcp-search.test.ts | P3 | 2026-09-29 | execute-phase | Type-level adaptation: ExtensionToolContext supersedes ExtensionContext for tool.execute ctx param; assertions unchanged

## Test call-site type adaptations

### test/compat.test.ts:109-114 — cast model to access contextWindow/maxTokens
**Reason**: `ProviderModelConfig` is a union type (`ProviderChatModelConfig | ProviderImageModelConfig | ProviderClassifierModelConfig`). Only `ProviderChatModelConfig` has `contextWindow` and `maxTokens`. The test iterates over all models in the catalog (which are all chat models from the generated fallback), so casting to a type with those properties is safe and preserves the assertions. Not weakening — same expectations.

### test/mcp-media.test.ts:149,163 — ExtensionContext → ExtensionToolContext
**Reason**: pi 0.99.1 changed `ToolDefinition.execute`'s `ctx` parameter from `ExtensionContext` to `ExtensionToolContext` (extends `ExtensionContext` with `tools` and `executeTool`). Tests that pass mock context to `tool.execute()` must use the new type. The mock data is the same — just a type cast change.

### test/mcp-search.test.ts:163,179,201 — ExtensionContext → ExtensionToolContext
**Reason**: Same as mcp-media — the `ctx` parameter type widened to `ExtensionToolContext`.

## No src/ code changes needed
All source files compile against 0.99.1 API. The ProviderModel union is backward-compatible (our model arrays are assignable). The ExtensionToolContext supertype relationship preserves existing call sites in src/.

## AGENTS.md fact updates
- Verified: bare root import only in src/, compat re-exports openAICompletionsApi, factory await still present
- Updated: "no built-in MCP client" claim → now acknowledges built-in mcp extension since 0.99.0
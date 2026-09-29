# Impact Report: @gtrabanco/pi-nan-provider 0.87.1 → 0.99.1

**Date:** 2026-09-29

## VERDICT: Safe — zero `src/` changes needed; type-level test adaptations only

### 1. pi-ai runtime exports (src/provider-factory.ts, src/pi-ai-loader.ts)

| Export | 0.87.1 | 0.99.1 | Verdict |
|--------|--------|--------|---------|
| createProvider (models.js) | at dist/models.js | at dist/models.js | **UNCHANGED** — same signature |
| envApiKeyAuth (auth/helpers.js) | at dist/auth/helpers.js | at dist/auth/helpers.js | **UNCHANGED** |
| Type / Static (typebox re-export) | re-exported from root | re-exported from root | **UNCHANGED** |
| normalizeContext (utils/transcript.js) | re-exported | re-exported | **UNCHANGED** |
| isContextOverflow (utils/overflow.js) | re-exported | re-exported | **UNCHANGED** |
| isRetryableAssistantError (utils/retry.js) | re-exported | re-exported | **UNCHANGED** |
| compat.js -> openAICompletionsApi | dist/compat.js re-exports from openai-completions.lazy.js | dist/compat.js re-exports from openai-completions.lazy.js | **UNCHANGED** |
| OpenAICompletionsCompat fields (supportsFinishReason, supportsUsageInStreaming) | present | present | **UNCHANGED** |

### 2. pi-ai createProvider options (src/provider-factory.ts)

**BREAKING: CreateProviderOptions.models type changed**

- 0.87.1: `models: readonly Model<TApi>[]`
- 0.99.1: `models: readonly ProviderModel<TApi>[]` where `ProviderModel<TApi> = Model<TApi> | ImageModel | ClassifierModel`

Since Model<TApi> is a subtype of ProviderModel<TApi>, our Model<"openai-completions">[] is assignable. **No code change needed.**

**Type-only: api is now optional** (api?)
- 0.87.1: `api: ProviderStreams | ...`
- 0.99.1: `api?: ProviderStreams | ...`
- Our code passes api so no issue.

**NEW optional fields ignored**: images?, filterAllModels?

### 3. pi-coding-agent ExtensionAPI (src/index.ts)

| Interface member | Verdict |
|-----------------|---------|
| registerProvider(provider) + registerProvider(name, config) overloads | **UNCHANGED** |
| registerTool(tool: ToolDefinition) | **UNCHANGED** signature |
| registerCommand(name, options) | **UNCHANGED** |
| on("context", handler) | **UNCHANGED** — ExtensionHandler<ContextEvent, ContextEventResult> |
| on() returns unsubscribe function | **UNCHANGED** (changed in 0.86) |
| getAgentDir() | **UNCHANGED** |

### 4. ToolDefinition type (src/mcp/nan-search.ts, src/mcp/nan-media.ts)

**NEW optional fields** (all optional, no breaking):
- outputSchema?, exposure?, namespace?, annotations?, defaultActive?, prepareLoadout?

**BREAKING type change: execute callback ctx parameter**
- 0.87.1: `ctx: ExtensionContext`
- 0.99.1: `ctx: ExtensionToolContext` (extends ExtensionContext + tools, executeTool())

Our MCP tools cast ctx to NapiKeyContext via `ctx as unknown as NapiKeyContext` — no method calls on ctx. ExtensionToolContext extends ExtensionContext, so the cast works. **No code change needed** but the import may need updating if TypeScript is strict.

### 5. Legacy ProviderConfig (src/index.ts)

**UNCHANGED**: The legacy form { name, baseUrl, apiKey, api: "openai-completions", models: [...] } still matches ProviderConfig. ProviderChatModelConfig union variant accepts our mapped model shape.

### 6. pi-ai type imports — all present at same paths

Provider, Model, ProviderStreams, RefreshModelsContext, Context, TranscriptContext, ApiKeyCredential, AuthContext, OpenAICompletionsCompat, AssistantMessage, AssistantMessageEventStream, Type, Static — all **UNCHANGED** in location and signature.

### 7. Behavioral changes (from changelog)

- TranscriptContext migration (0.86): Our package forwards context untouched. **No impact.**
- AgentSession context (0.99): We don't use session.agent.state.messages. **No impact.**
- SessionEntry union (0.99): We don't switch on SessionEntry. **No impact.**
- TurnEndEvent expansion (0.99): We don't construct events. **No impact.**
- Context handlers lose system messages (0.99 fix): Our context hook doesn't use system messages. **No impact.**

## Verified Gate Results (post-bump)

| Gate | Result |
|------|--------|
| `bun test` | **220 pass, 0 fail, 717 expect()** — unchanged from 0.87.1 |
| `bun run typecheck` | **Clean** after test-level type adaptations (see below) |
| `node scripts/check-pi-sdk-versions.mjs --report` | **Exit 0** — confirms 0.99.1 is latest for both deps |

The type differences (ExtensionContext → ExtensionToolContext, Model → ProviderModel)
are all subtype-compatible, confirmed by passing gates.

## Files That Need Minor Updates (applied)

| File | Change | Verdict |
|------|--------|---------|
| src/mcp/nan-search.ts:16 | Import ExtensionToolContext instead of ExtensionContext | **No change needed** — casts to NApiKeyContext, no method calls on ctx |
| test/compat.test.ts:109–114 | Cast `ProviderModelConfig` union to access contextWindow/maxTokens | Type-level only; assertions unchanged |
| test/mcp-media.test.ts:29,149,163 | ExtensionContext → ExtensionToolContext in mocks | Type-level only; assertions unchanged |
| test/mcp-search.test.ts:163,179,201 | ExtensionContext → ExtensionToolContext in mocks | Type-level only; assertions unchanged |

## Summary

**LOW-risk upgrade.** Zero `src/` files changed. All 0.99.x diffs are backward-compatible
at our import boundary. Three test files required type-level adaptations (mock casts to
match widened types) — no assertions were weakened. The `check-pi-sdk-versions` script
confirms 0.99.1 is the latest for both `@earendil-works/pi-ai` and
`@earendil-works/pi-coding-agent`.

### Verification checklist (all ✅)
- [x] Bare root import only in `src/` (grep confirms no subpath specifiers)
- [x] `compat.js` still re-exports `openAICompletionsApi` from `openai-completions.lazy.js`
- [x] `await factory(api)` pattern still present in pi 0.99.1 `resource-loader.js`
- [x] pi 0.99.0 ships built-in MCP extension (mcp.json / /mcp / `pi registerMcpServer`)
- [x] `bun test` passes: 220/220
- [x] `bun run typecheck` clean
- [x] peer range `>=0.83.0 <1` still satisfied by 0.99.1

> **Note:** The native MCP migration (shifting from `registerTool` bridges to pi's native
> MCP) is a follow-up task. This release bumps the devDependencies and corrects the
> documentation.

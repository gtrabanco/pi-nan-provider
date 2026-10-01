# AGENTS.md — rules for any agent working on this repo

## The One Rule

You must understand and be able to explain any code you write. If you cannot explain
why a line exists, delete it or learn why before shipping. (Mirrors pi's own
CONTRIBUTING "One Rule" — we apply it to ourselves too.)

## No fabricated model metadata

Every context-window, max-token, modality, cost, and compat value must trace to a
source:

- **models.dev** (provider `nan` in `https://models.dev/api.json`) — the default
  source, pulled by `scripts/generate-models.ts`; or
- **an explicit manual note** recorded on the generated entry
  (`notes` in `scripts/models.generated.ts`) stating where the value was confirmed
  (URL + date).

Never guess limits. If a model is missing from models.dev or has incomplete limits,
the generator omits it and flags it (`needs manual verification`); do not invent
numbers to fill the gap. The same applies to auth mechanics: only documented pi
behavior (`docs/custom-provider.md` shipped with pi) — no invented flows.

## Verify before done

Run both before considering any task done:

```bash
bun test        # all tests must pass
bun run typecheck  # typecheck must be clean (bunx resolves tsc; bun publish lifecycle lacks node_modules/.bin on PATH)
```

Regenerate the catalog after touching `scripts/generate-models.ts`:

```bash
bun run generate-models
```

## Live NaN API during diagnosis

Diagnostic calls against the real gateway are allowed — they spend the
maintainer's quota, so they are **permission-gated**:

- **Ask the maintainer before running any live probe, with an approximate token
  cost (input + output).** No silent probing. If the cost is not worth it, report
  the behavior to NaN and let them reproduce it instead of debugging it here.
- **Tests must never hit the network.** `bunfig.toml` preloads
  `test/network-guard.ts`, which makes any un-injected `fetch` throw. Keep it:
  inject `fetchImpl` / `options.fetch`, or use the local fixture. The permission
  gate covers ad-hoc diagnosis only, never `bun test`.
- **Default to `qwen3.6` — it is unlimited.**
- **For massive/bulk probes prefer a model the maintainer uses less with a large
  token budget, e.g. `mimo-v2.6-flash`** (1M context, 1.0B monthly quota).
- **When the model under investigation is the point** (e.g. reproducing a
  model-specific 400), use it, but minimize tokens: smallest viable prompt,
  lowest `max_tokens`, stop at the first decisive response.
- Repro commands that run a real `pi` session (`pi --fork ... -p ...`) use the
  same key; keep them minimal and delete the forked session files afterwards.

## One shared implementation for all providers

`nan` (and any future provider, e.g. `helmcode`) must stay behind the single shared
factory in `src/provider-factory.ts`. A second provider-specific file is a smell:
refactor back to the factory and add a config entry in `src/providers.ts` instead.
The `factory is shared` test in `test/provider-factory.test.ts` guards this contract.

## Version policy (strict semver)

Every PR that changes code MUST bump `package.json` version in the same PR; CI publishes only when the version differs from npm.

- **PATCH** (`0.1.z`): bug fixes, docs, comment-only changes, catalog regeneration with identical values.
- **MINOR** (`0.x.0`): new features — new provider entries, new MCP tools, new env vars/config options, and (while `0.x`) breaking changes, each breaking change called out explicitly in the PR/changelog.
- **MAJOR** (`x.0.0`): breaking changes once `1.0.0` is reached.
- Never reuse a published version; never publish with failing tests (CI gates publish on tests + typecheck).
- The npm registry is the source of truth for "published"; `.github/workflows/publish.yml` compares `package.json` against `npm view` and publishes only on difference.

## Verified API facts (do not re-derive from stale docs)

- **Extension-side pi-ai imports + streaming-API instance binding (v0.6.10; verified on pi-ai 0.83.0–0.87.1 and pi 0.87.1):**
  statically import ONLY the bare `@earendil-works/pi-ai` root from `src/`. pi's
  extension loader maps that specifier to the compat entrypoint on the bundled
  CLI, Node-mode jiti aliases and compiled-binary virtualModules, and compat
  re-exports every lazy API factory — including `openAICompletionsApi`. A static
  SUBPATH import (`@earendil-works/pi-ai/api/...`) gets the alias applied as a
  prefix and resolves to `<compat.js>/api/...`, which does not exist: the whole
  extension fails to load (the v0.4.x load failure). Type-only subpath imports
  are erased before resolution and are safe.
  **Exception (issue #8):** on pi-web's sessiond-on-Bun loader (pi-web
  1.202609.0 / pi 0.87.0 / Bun) the bare root is NOT aliased to `/compat`
  (observed namespace = core, `import.meta.resolve` = core), and a bare SUBPATH
  specifier resolved to a stale hoisted `@earendil-works/pi-ai@0.85.1` under
  `~/.pi/agent/npm/node_modules`; its `estimateMessageTokens` lacks the `system`
  branch and crashes pi 0.87's string-content `system` transcript with
  `block.name.length`. `src/pi-ai-loader.ts` therefore binds the streaming
  factory to the same package instance the host loaded: use the root export
  when present, else resolve the bare root **from the host process entrypoint**
  (`process.argv[1]`) via
  `import.meta.resolve("@earendil-works/pi-ai", hostAnchor)` — an
  extension-relative resolve returns the extension tree's stale copy (the
  v0.6.10 regression that left #8 open) — then derive a FILE URL for
  `api/openai-completions.lazy.js` (then `compat.js`). No bare pi-ai subpath
  specifier is imported anywhere in `src/` (static or dynamic); failure is loud
  (`PiAiStreamingApiResolutionError`). Guarded by `test/extension-load.test.ts`
  and `test/issue-8-pi-ai-instance.test.ts`.
- The REAL pi-ai root (plain node/bun, outside pi) does not export
  `openAICompletionsApi`; `createProvider` and `envApiKeyAuth(name, envVars)` are
  on the root. `envApiKeyAuth` implements exactly: stored credential key wins →
  first set env var → unconfigured; `login()` prompts with `{ type: "secret" }`.
- pi awaits extension factories (`await factory(api)`) on 0.83.0 through 0.87.1
  alike, so the extension entrypoint may be async (v0.5.0: streaming-API
  resolution needs it).
- pi-ai 0.83.0 runtime surface verified identical for this package's needs:
  compat re-exports `index.js` (`createProvider`, `envApiKeyAuth`) and
  `api/openai-completions.lazy.js`; `createProvider` options (`auth`, `models`,
  `fetchModels(context)`, `filterModels(models, credential)`, `api`) and
  `RefreshModelsContext.credential` match 0.84.4; `registerProvider` has both
  the full-`Provider` and `(name, config)` overloads in 0.83's ExtensionAPI.
  (pi-ai 0.86 changed provider stream entry points to a branded `TranscriptContext`
  — see next bullet — but this package's runtime is untouched.)
- **pi-ai 0.86.0 `TranscriptContext` migration (verified 2026-09-29):** provider
  stream entry points (`Provider.stream`, `ProviderStreams.stream/streamSimple`,
  `StreamFunction`) now take a branded `TranscriptContext = { messages: Message[] }`
  instead of the public `Context = { systemPrompt?: string; messages; tools? }`.
  `normalizeContext(context: Context): TranscriptContext` (exported from the pi-ai
  root) folds prompt + tools into a leading system message
  `{ role: "system", content: <prompt>, toolsAdded: <tools>, timestamp: 0 }`.
  `Context` itself still exists and is what the public entry points accept, so raw
  `Context` literals only fail where a *provider-level* stream is called directly
  (the 6 test call sites). Tests now build contexts with `normalizeContext(...)`.
  This package's `src/` files never hand-build a provider context, so no `src/`
  code changed: `wrapApiForStrictSanitization` forwards `context` untouched, and
  `withContextOverflowClassification` only *reads* it for the estimate, which still
  counts prompt + tools because they ride inside `messages[0]`.
- pi 0.87 rejects extension tools that declare no parameter schema at registration;
  all this package's MCP tools declare TypeBox `parameters`, so they register fine.
  pi 0.87 also changed `pi.on()` to return an unsubscribe function (unused by
  this package).
- `pi.registerProvider(provider)` accepts a complete pi-ai `Provider`; pi's Models
  runtime then drives `fetchModels` refreshes (network refresh at interactive
  startup and periodically, cache-only at registration) and persists the overlay.
  A `fetchModels` rejection never blocks startup.
- **pi 0.99 virtual models do not break the provider, but they do interact with the
  cross-model thinking guard** (verified pi 0.99.1/0.99.2). A virtual model
  (`pi.registerVirtualModel`, api `pi-virtual`) can be registered under `nan` and
  route to physical `nan` models via `ctx.modelRegistry.find("nan", id)` — no
  provider-side change needed. Inside the extension `context` hook, though,
  `ctx.model` is the **selection** (the virtual entry), never the routed physical
  model (`core/virtual-models.js`; `agent-session.js` "The selection stays in
  agent state; only this request uses the routed model"), and the routed target is
  not exposed to the hook. `stripCrossModelThinking` therefore skips virtual
  selections (`src/cross-model-thinking-guard.ts`, `VIRTUAL_MODEL_API`); otherwise
  its same-model check would strip reasoning on every continuation. Registered
  virtual models are otherwise transparent to the catalog/factory.
- **Factory-time ExtensionAPI has NO `modelRegistry`** (verified pi 0.99.1):
  The `ExtensionAPI` interface does not include `modelRegistry`; it exists only on
  `ExtensionContext` (the `ctx` passed to command/event handlers). At factory time,
  stored credentials are resolved via `readStoredCredential("nan")` from
  `@earendil-works/pi-coding-agent`. Command-time paths (`/nan-mcp`, `/nan-usage`) use
  `ctx.modelRegistry`.
- models.json overrides compose **above** registered native providers.
- Capability values that diverge from models.dev are recorded as build-time
  `MANUAL_OVERRIDES` (mandatory provenance note) in `scripts/manual-overrides.ts`,
  applied by `scripts/generate-models.ts` — never hand-edited into
  `scripts/models.generated.ts` and never invented. e.g. deepseek-v4-flash
  image input (Vision-Exp variant; models.dev now also lists text+image,
  checked 2026-09-13, so the override is kept as a pin rather than a
  divergence). Re-verify
  overrides when the sources update: the qwen3.8-flash contextWindow 1,000,000
  override (maintainer-confirmed 2026-09-05) was withdrawn 2026-09-07 — the
  updated NaN docs still say 262K "the model's native window" and models.dev
  agrees at 262,144.
- **Which models exist**: https://nan.builders/docs/models is the source of
  truth (maintainer instruction, reaffirmed 2026-09-29), cross-checked against
  the `model` param description in https://nan.builders/openapi.json; models.dev
  (provider `nan`) supplies the numeric limits for the ids it documents, and
  every divergence or exclusion is recorded with provenance.
  Official chat models (checked 2026-09-29): community `deepseek-v4-flash`,
  `mimo-v2.6-flash`, `qwen3.8-flash`, `glm5.3-flash`, `qwen3.6`, `gemma4`
  (all text+image vision) + premium-tier `glm5.3`
  (~753B MoE, text-only input, 1M context, 400M tokens/rolling 4h window).
  glm5.3 is now documented by models.dev too (1M context / 131,072 max output,
  checked 2026-09-13) but stays out of the static catalog via
  `LIVE_ONLY_MODEL_IDS` (premium tier) so a non-premium key never sees a
  model it cannot call when the live `/models` fetch is unavailable; premium
  keys still receive it live with conservative placeholder limits.
  Removed by the provider: `glm5.2` (2026-09-05) and `mimo-v2.5` (checked
  2026-09-29 — zero mentions in the docs and in openapi.json, and models.dev
  dropped it too; superseded by `mimo-v2.6-flash`). models.dev may re-list a
  removed id, so the generator excludes them via `PROVIDER_REMOVED_MODEL_IDS`,
  and the four community ids the docs require (`qwen3.6`, `gemma4`,
  `deepseek-v4-flash`, `mimo-v2.6-flash`) are `REQUIRED_MODEL_IDS` — if one
  never reaches the catalog (from models.dev or from a manual-only entry),
  generation exits non-zero instead of inventing data.
  `mimo-v2.6-flash` entered through `MANUAL_ONLY_MODEL_IDS` while models.dev
  lacked it; models.dev started listing it on 2026-09-29, and the generator
  then skips the manual entry (attaching its note to the models.dev-derived
  entry) so the id is never emitted twice.
  Non-chat endpoints: qwen3-embedding, rerank, kokoro (TTS), whisper (STT),
  flux-2-klein and qwen-image-2.1 (images) — MCP-bridge territory, not chat
  catalog models. The classification is now applied at RUNTIME too:
  `NON_CHAT_MODEL_IDS` is exported from `src/fetch-models.ts` (single source
  of truth: id → provenance reason), imported by `scripts/generate-models.ts`
  (one definition, no duplicate), enforced by `mergeLiveWithGenerated` (those
  ids land in the `nonChat` bucket and never enter the registry), and filtered
  defensively by `baselineModels`. The generator excluded `qwen-image-2.1` via
  this constant before (it also sits on models.dev with `limit.output: 0`,
  excluded instead of being flagged "needs manual verification" forever); all
  six ids are now under the same guard so they can never be emitted as chat
  models or registered at runtime.
- NaN can close an SSE stream **before** `finish_reason`. The catalog sets
  `supportsFinishReason: true` so pi-ai raises the retryable
  `Stream ended without finish_reason` (pi-ai's `RETRYABLE_PROVIDER_ERROR_PATTERN`
  matches `"ended without"`, so the turn is retried) instead of silently
  synthesizing `stop`/`toolUse`. `supportsUsageInStreaming` is `true` for chat
  models (issue #7): NaN's published schema does not document `stream_options`,
  but the live gateway honors `stream_options.include_usage` — measured
  2026-09-16 on `deepseek-v4-flash`, `glm5.3-flash`, `qwen3.6`, `mimo-v2.5` and
  `gemma4` (0 usage chunks without the flag, exactly 1 with it, carrying
  prompt/completion/reasoning/cached counts; a real pi session then recorded
  real tokens where it recorded zeros). The sanitizer gates its
  `stream_options` removal on the model's effective
  `compat.supportsUsageInStreaming`, so the stock catalog reports real usage and
  a per-model `models.json` override of `false` restores the strict payload
  (`test/issue-4-token-usage.test.ts`, `test/issue-7-streaming-usage-default.test.ts`;
  issues #2, #4, #7). Regression tests:
  `test/issue-2-truncated-stream.test.ts`, `test/issue-4-token-usage.test.ts`,
  `test/issue-7-streaming-usage-default.test.ts`;
  issues #2, #4 and #7.
- **Catalog now declares `thinkingLevelMap` for reasoning suppression** (issue #16, measured 2026-09-27 against live gateway, repro script in the issue). `deepseek-v4-flash` → `{ off: "none" }` (0 reasoning tokens, reproducible); `glm5.3-flash` → `{ off: "minimal" }` (38 reasoning tokens + answer; `none` does NOT work on glm5.3 — 13,382 tokens); `qwen3.6` and `gemma4` → `{ off: "none" }` (gap left by the measured-only fix: the NaN docs state that with no parameter both reason by default with a 16,384-token budget and that `none`/`minimal` skip the reasoning phase entirely — https://nan.builders/docs/models#controlling-reasoning, checked 2026-10-01 — so `off` must send `none` explicitly). `reasoningEffortValues` corrected: deepseek-v4-flash from `[]` to `["none"]`; glm5.3-flash from `["low","medium","high","max"]` to include `"minimal"`. README limits table notes that `maxTokens` does NOT bound the reasoning phase (measured: max_tokens=512 still yielded 13,376 reasoning tokens). pi-ai's `buildRequest` (0.99.1) maps `reasoning: "off"` → `reasoningEffort: undefined` → fires the off-branch that checks `model.thinkingLevelMap?.off` (verified in pi-ai source ~line 718-722). A model whose reasoning depth is genuinely not adjustable (`qwen3.8-flash`, `mimo-v2.6-flash`) keeps no `thinkingLevelMap`: `off` sends nothing and the model uses its own default.
- A NaN request that still exceeds the destination model's context window (the
  cross-model thinking guard is disabled with `NAN_THINKING_GUARD=0`, the
  inflation is not a `thinking` block, or the window is smaller) gets NaN's
  generic 400 `Invalid request. Check your request parameters.`, which pi-ai's
  `isContextOverflow()` does NOT match — so pi never compacts and the session
  wedges (upstream `earendil-works/pi#9409`). `src/context-overflow-classifier.ts`
  re-checks the request size at the provider boundary and rewrites that error
  into a pi-recognizable overflow message (chars/3.47 estimate; conservative:
  only when estimated over the window). Wired in `src/provider-factory.ts` after
  the sanitizer. Regression tests: `test/issue-3-model-switch-overflow.test.ts`,
  `test/context-overflow-classifier.test.ts`; issue #3.
- Relative imports inside this package use `.ts` extensions (pi's official
  extension examples do the same; pi transpiles extension sources).
- pi 0.87 breaking changes NOT used by this package: `ContextEditEntry` added to
  the `SessionEntry` union, expanded `TurnEndEvent`, removed `shouldStopAfterTurn`,
  `SessionManager` canonical for provider context. The package touches none of them.
- Since 0.10.0, this package uses native MCP via `pi.registerMcpServer()`.
  Both servers are session-scoped, visible in `/mcp` with source "extension".
  Server names and tool IDs:
  - `nan-search` → tools: `mcp__nan-search__web_search`
    (official remote, HTTP, `Authorization: Bearer <key>` header)
  - `nan-media` → tools: `mcp__nan-media__generate_image/edit_image/text_to_speech/list_voices/speech_to_text`
    (community stdio, `npx -y nan-mcp-server@1.1.2`, 120s timeout)
  - `exposure: "direct"` on both — tools are declared to the model.
  - User `mcp.json` entries with the same name take precedence.
  - `/nan-mcp enable/disable` calls `pi.registerMcpServer()` / `pi.unregisterMcpServer()` directly.
  - Missing `NAN_API_KEY` at load: web-search server NOT registered (console.warn).
  NaN integration facts remain:
  - NaN's official remote MCP server: `https://api.nan.builders/mcp` (host
    root, NOT /v1; JSON-RPC 2.0 over streamable HTTP, stateless; same `sk-`
    key, shared rate limit/quota). Spec: https://nan.builders/openapi.json
    (tag "MCP"). Currently exposes `web_search`.
  - Community `nan-mcp-server` (https://github.com/luciferfran/nan-mcp-server):
    stdio MCP server, version-pinned via NAN_MEDIA_MCP_VERSION (default 1.1.2)
    or full command override via NAN_MEDIA_MCP_COMMAND. Tools: generate_image,
    edit_image, text_to_speech, list_voices, speech_to_text.
  - Automated check (scripts/check-nan-mcp-server.ts) compares the npm registry
    against the pin weekly and files a `dependencies` issue when a newer release
    exists, with a breaking/safe verdict from the live server tool surface.
- **pi reports unhandled MCP registrations right after `session_start`** (verified
  on pi 0.99.1): `AgentSession.bindExtensions()` emits `session_start` and then
  calls `ExtensionRunner.reportUnhandledMcpServers()`, which raises
  `MCP server "<name>" is registered, but no loaded extension connects MCP
  servers` whenever no loaded extension handles `mcp_servers_change`. A host
  that builds `DefaultResourceLoader` WITHOUT `extensionFactories` loads no
  `builtin:*` extension at all — PI WEB's `createAgentSessionServices` does
  exactly that (pi-web 1.202609.1, verified 2026-09-30 with a faithful loader
  run: packages load, `builtin:mcp` absent, no `/mcp` command), so its sessions
  have no MCP connector and `mcp.json` servers never connect either.
  `src/mcp/host-support.ts` detects the gap through the `/mcp` command
  (`pi.getCommands()` missing → conservative "connector present"), claims
  `mcp_servers_change` so pi's report stays silent, and warns once per session;
  `/nan-mcp enable` persists the toggle without registering. Regression tests:
  `test/mcp-host-connector.test.ts`.

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
  token budget, e.g. `mimo-v2.5`** (1M context).
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

- **Extension-side pi-ai imports (v0.5.0, verified on pi-ai 0.83.0 AND 0.84.4):**
  statically import ONLY the bare `@earendil-works/pi-ai` root from `src/`. pi's
  extension loader maps that specifier to the compat entrypoint in every loading
  mode (bundled CLI interception, Node-mode jiti aliases, compiled-binary
  virtualModules), and the compat entrypoint re-exports every lazy API factory —
  including `openAICompletionsApi`. A static SUBPATH import
  (`@earendil-works/pi-ai/api/...`) gets the alias applied as a prefix and
  resolves to `<compat.js>/api/...`, which does not exist: the whole extension
  fails to load (the v0.4.x load failure). Type-only subpath imports are erased
  before resolution and are safe; a DYNAMIC subpath `import()` is the sanctioned
  plain-node fallback and never runs under pi because the root (compat) exports
  the factory. Guarded by `test/extension-load.test.ts`.
- The REAL pi-ai root (plain node/bun, outside pi) does not export
  `openAICompletionsApi`; `createProvider` and `envApiKeyAuth(name, envVars)` are
  on the root. `envApiKeyAuth` implements exactly: stored credential key wins →
  first set env var → unconfigured; `login()` prompts with `{ type: "secret" }`.
- pi awaits extension factories (`await factory(api)`) on 0.83.0 and 0.84.4
  alike, so the extension entrypoint may be async (v0.5.0: streaming-API
  resolution needs it).
- pi-ai 0.83.0 runtime surface verified identical for this package's needs:
  compat re-exports `index.js` (`createProvider`, `envApiKeyAuth`) and
  `api/openai-completions.lazy.js`; `createProvider` options (`auth`, `models`,
  `fetchModels(context)`, `filterModels(models, credential)`, `api`) and
  `RefreshModelsContext.credential` match 0.84.4; `registerProvider` has both
  the full-`Provider` and `(name, config)` overloads in 0.83's ExtensionAPI.
- `pi.registerProvider(provider)` accepts a complete pi-ai `Provider`; pi's Models
  runtime then drives `fetchModels` refreshes (network refresh at interactive
  startup and periodically, cache-only at registration) and persists the overlay.
  A `fetchModels` rejection never blocks startup.
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
- NaN's official chat model list (https://nan.builders/openapi.json `model`
  param description + https://nan.builders/docs/models, checked 2026-09-07):
  community `deepseek-v4-flash`, `mimo-v2.5`, `qwen3.8-flash`, `glm5.3-flash`,
  `qwen3.6`, `gemma4` (all text+image vision) + premium-tier `glm5.3`
  (~753B MoE, text-only input, 1M context, 400M tokens/rolling 4h window).
  glm5.3 is now documented by models.dev too (1M context / 131,072 max output,
  checked 2026-09-13) but stays out of the static catalog via
  `LIVE_ONLY_MODEL_IDS` (premium tier) so a non-premium key never sees a
  model it cannot call when the live `/models` fetch is unavailable; premium
  keys still receive it live with conservative placeholder limits.
  `glm5.2` was removed by the provider (2026-09-05); models.dev may still list
  it — the generator excludes it via `PROVIDER_REMOVED_MODEL_IDS`. Non-chat
  endpoints: qwen3-embedding, rerank, kokoro (TTS), whisper (STT),
  flux-2-klein (images) — MCP-bridge territory, not chat catalog models.
- NaN can close an SSE stream **before** `finish_reason`. The catalog sets
  `supportsFinishReason: true` so pi-ai raises the retryable
  `Stream ended without finish_reason` (pi-ai's `RETRYABLE_PROVIDER_ERROR_PATTERN`
  matches `"ended without"`, so the turn is retried) instead of silently
  synthesizing `stop`/`toolUse`. `supportsUsageInStreaming` is `false` because
  `src/openai-compat-sanitizer.ts` strips `stream_options`. Regression tests:
  `test/issue-2-truncated-stream.test.ts`; issue #2.
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
- pi intentionally has NO built-in MCP client (docs/usage.md). MCP integration
  happens by bridging servers into pi custom tools via `pi.registerTool()`:
  - NaN's official remote MCP server: `https://api.nan.builders/mcp` (host
    root, NOT /v1; JSON-RPC 2.0 over streamable HTTP, stateless; same `sk-`
    key, shared rate limit/quota). Spec: https://nan.builders/openapi.json
    (tag "MCP"). Currently exposes `web_search` (same args as POST /v1/search);
    "growing registry" — use tools/list to discover.
  - Community `nan-mcp-server` (https://github.com/luciferfran/nan-mcp-server):
    stdio MCP server, spawned per tool call (lazy), opt-in NAN_MEDIA_MCP=1,
    version-pinned via NAN_MEDIA_MCP_VERSION (default 1.0.8) or a full command
    override via NAN_MEDIA_MCP_COMMAND. Tools: generate_image, edit_image,
    text_to_speech, list_voices, speech_to_text, embed, rerank, list_models
    (we bridge the audio/image/transcription scope). An automated check
    (scripts/check-nan-mcp-server.ts + .github/workflows/check-nan-mcp-server-update.yml)
    compares the npm registry against the pin weekly and files a `dependencies` issue
    with a breaking/safe verdict from the live server tool surface (unpkg).

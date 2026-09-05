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
  `scripts/models.generated.ts` and never invented. e.g. qwen3.8-flash
  contextWindow 1,000,000 (maintainer-confirmed 2026-09-05; models.dev and NaN
  docs still listed 262,144 that day).
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
    version-pinned via NAN_MEDIA_MCP_VERSION (default 1.0.7) or a full command
    override via NAN_MEDIA_MCP_COMMAND. Tools: generate_image, edit_image,
    text_to_speech, list_voices, speech_to_text, embed, rerank, list_models
    (we bridge the audio/image/transcription scope).

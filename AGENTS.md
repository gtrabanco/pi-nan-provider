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

- pi 0.84.4: `openAICompletionsApi` is **not** exported from the `@earendil-works/pi-ai`
  root (the `custom-provider.md` snippet is stale). Import it from
  `@earendil-works/pi-ai/api/openai-completions.lazy`.
- `createProvider` and `envApiKeyAuth(name, envVars)` are on the pi-ai root.
  `envApiKeyAuth` implements exactly: stored credential key wins → first set env
  var → unconfigured; `login()` prompts with `{ type: "secret" }`.
- `pi.registerProvider(provider)` accepts a complete pi-ai `Provider`; pi's Models
  runtime then drives `fetchModels` refreshes (network refresh at interactive
  startup and periodically, cache-only at registration) and persists the overlay.
  A `fetchModels` rejection never blocks startup.
- models.json overrides compose **above** registered native providers.
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

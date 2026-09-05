# @gtrabanco/pi-nan-provider

[NaN Builders](https://nan.builders) model provider + MCP bridges for [pi](https://github.com/earendil-works/pi). Registers the `nan` provider via `pi.registerProvider()` using NaN's OpenAI-compatible API (`https://api.nan.builders/v1`, LiteLLM behind it), and bridges NaN's MCP tools into pi with `pi.registerTool()`.

**Docs in English** (this file) · [Documentación en español](README.es.md)

Get your NaN API key (referral link): **<https://cloud.nan.builders/r/7GK06FX8>**

## How it works

Two-layer model catalog, never either alone:

1. **Generated fallback** (`scripts/models.generated.ts`, committed): pulled at build time from [models.dev](https://models.dev) (provider `nan`). This is NaN's *served* configuration — if the underlying model can do 2M context but NaN serves it at 1M, the catalog says what your key gets, not the raw model maximum. Every value traces to its source, and the full raw models.dev entry is preserved per model (`extras`) so no documented property is lost. Nothing is invented: entries models.dev documents incompletely are omitted and flagged.
2. **Live `/models` fetch** at runtime: NaN's endpoint returns only model `id`s, so it is used to confirm which IDs your key can actually call. Live IDs are merged with the generated capability data; a live ID without generated data is kept with conservative placeholder limits (never fabricated capabilities). On timeout (~3s), network failure, auth error, or an unusable response, the generated catalog is used and startup is never blocked.

**Tier detection:** with a key configured, the live `/models` list is authoritative — it lists exactly the models your NaN membership can call, and models absent from it are filtered out of the available set (`filterModels`). That includes tier-gated models: a premium-tier model simply does not appear unless your key has the tier. Without a key (or if the fetch fails), the full generated catalog is shown.

The registration is synchronous on purpose: the generated fallback catalog is available immediately, and pi's Models runtime drives the live refresh (network refresh at interactive startup and periodically, cache-only at registration), persisting the overlay between runs.

## Install

```bash
pi install npm:@gtrabanco/pi-nan-provider
# or, from git:
pi install git:github.com/gtrabanco/pi-nan-provider
# or, to try it without installing:
pi -e npm:@gtrabanco/pi-nan-provider
```

Then restart pi (or `/reload`). Verify with:

```bash
pi --list-models nan
```

## Authentication

`resolve()` checks the stored credential first, then falls back to the matching env var — the same precedence pi's built-in providers use. No prompt is needed when the env var is set. Keys are never hardcoded or logged.

**Option 1 — env var (quick):** having the package installed is enough; just export the key and NaN is configured:

```bash
export NAN_API_KEY="sk-your-key-here"
```

**Option 2 — `/login` (persistent):** run `/login nan` in pi and paste your key; it is stored in `~/.pi/agent/auth.json`.

**Option 3 — `~/.pi/agent/auth.json` directly:**

```json
{
  "nan": { "type": "api_key", "key": "sk-your-key-here" }
}
```

Get a key from the [NaN platform](https://cloud.nan.builders/r/7GK06FX8) (user settings → API Keys; referral link). The key is personal and non-transferable.

## MCP bridges

pi intentionally ships without an MCP client ("It intentionally does not include built-in MCP" — pi's `docs/usage.md`). This package bridges MCP servers into pi as native custom tools, so the LLM calls them like any built-in tool.

Both bridges are **enabled and lazy by default** and are configured with the `/nan-mcp` slash command this package ships (pi has no `/mcp` command of its own — it has no MCP client at all — so the command is namespaced `/nan-mcp`):

| Command | Effect |
|---|---|
| `/nan-mcp status` | State of both bridges and where each toggle comes from (env / persisted / default) |
| `/nan-mcp enable [target]` | Enable a bridge — or both when no target is given — and persist it in `<agentDir>/nan-provider.json` (e.g. `~/.pi/agent/nan-provider.json`); tools register immediately for the current session |
| `/nan-mcp disable [target]` | Disable persistently; pi has no `unregisterTool`, so already-registered tools remain until restart, future sessions skip them |

Targets: `web-search` (official bridge) and `nan-mcp-server` (community media bridge; alias `media`). Example: `/nan-mcp enable nan-mcp-server`. Explicit env vars override the persisted toggles for the session (see the table below).

### 1. Official NaN MCP server (default: enabled, lazy)

NaN's official remote MCP server ([`https://api.nan.builders/mcp`](https://nan.builders/docs/api), JSON-RPC 2.0 over HTTP, same `sk-` key, same rate limit/quota/concurrency as the REST API) is bridged as:

- **`nan_web_search(query, count?, freshness?, fetch_content?)`** — web search through NaN. The HTTP call happens only when the tool is invoked.

The server is a growing registry (discover with `tools/list`); this package currently bridges the documented `web_search` tool and keeps a generic `callNanMcpTool()` helper for future tools.

### 2. Community media MCP server (default: enabled, lazy)

[`nan-mcp-server`](https://github.com/luciferfran/nan-mcp-server) is a stdio MCP server exposing NaN's media tools: image generation/editing (flux-2-klein), TTS (kokoro), and STT (whisper). Because pi has no MCP client, this package bridges it as pi tools via a minimal built-in MCP stdio client:

- **Enabled by default**, toggled persistently with `/nan-mcp enable|disable nan-mcp-server` (or `media`), or per-session with `NAN_MEDIA_MCP` (any explicit value — e.g. `NAN_MEDIA_MCP=0` — overrides the persisted toggle).
- **Lazy**: the MCP server process is spawned *per tool call* and terminated immediately after. Nothing starts, connects, or costs anything unless audio/image/transcription is actually invoked.
- **Config**: `NAN_API_KEY` is forwarded automatically (same key as the provider); generated files land in `~/nan-mcp-output/` (the server's default, override with `NAN_OUTPUT_DIR`).

| Tool | Purpose |
|---|---|
| `nan_generate_image(prompt, size?, n?, seed?, guidance?, outputName?)` | Generate an image (flux-2-klein) |
| `nan_edit_image(prompt, images, size?, n?, seed?, guidance?, outputName?)` | Edit an image image→image (flux-2-klein) |
| `nan_text_to_speech(text, voice?, format?, speed?, outputName?)` | Synthesize audio (kokoro) |
| `nan_list_voices()` | List kokoro voices by language |
| `nan_speech_to_text(file, language?, verbose?)` | Transcribe audio (whisper) |

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `NAN_MEDIA_MCP` | — | Per-session override for the media bridge: any explicit value (incl. `0`) beats the `/nan-mcp` persisted toggle; unset → persisted/default |
| `NAN_MEDIA_MCP_VERSION` | `1.0.7` | Pinned server version for `npx -y nan-mcp-server@<v>` (upstream's own supply-chain recommendation) |
| `NAN_MEDIA_MCP_COMMAND` | — | Full custom command, e.g. `bunx nan-mcp-server@1.0.7` |
| `NAN_MEDIA_MCP_TIMEOUT_MS` | `120000` | Per-call timeout; the process is killed after it |
| `NAN_MCP_TOOLS` | — | Per-session override for the official bridge: `0`/`false`/`off` disables `nan_web_search`; unset → persisted/default |

## Models

Baseline catalog (from models.dev, provider `nan`, fetched 2026-09-04 — NaN's *served* limits, not raw model maxima):

| Model | Context | Max output | Input | Reasoning |
|---|---|---|---|---|
| `qwen3.6` | 262,144 | 65,536 | text, image | yes |
| `gemma4` | 262,144 | 32,768 | text, image | yes |
| `deepseek-v4-flash` | 1,000,000 | 384,000 | text, image | yes |
| `mimo-v2.5` | 1,048,576 | 131,072 | text, image | yes |
| `glm5.2` | 500,000 | 131,072 | text | yes |
| `glm5.3-flash` | 1,000,000 | 131,072 | text, image | yes |
| `qwen3.8-flash` | 1,000,000 | 131,072 | text, image | yes |

Notes (recorded per entry in `scripts/models.generated.ts`):

- `qwen3.8-flash` context window is maintainer-confirmed at 1M (2026-09-05); models.dev and NaN's docs still listed 262,144 at that date. Divergences like this are recorded as build-time `MANUAL_OVERRIDES` (with provenance) in `scripts/manual-overrides.ts` — apply one instead of editing the generated file.
- `deepseek-v4-flash` includes image input because NaN serves the Vision-Exp variant ([NaN docs](https://nan.builders/docs/models)); models.dev lists text only.
- `mimo-v2.5` is omnimodal (text/image/audio) on NaN, but pi's model type only represents text/image input, so audio is dropped from `input`.
- NaN bills via membership quota, which models.dev reports as zero per-token cost — pi's cost display will read $0.
- Compat (`supportsDeveloperRole: false`, `supportsReasoningEffort: true`, `supportsUsageInStreaming: true`, `maxTokensField: "max_tokens"`) matches the battle-tested LiteLLM config this package replaces; NaN's docs example (`supportsDeveloperRole: true`) is not battle-tested.
- **Tier/quota**: which models you can call is decided by your NaN membership. With a key, the live fetch reflects exactly that (see *How it works* — tier detection). The premium-tier GLM 5.3 is not in the models.dev `nan` provider at all; only `glm5.3-flash` is.

### Relationship to `~/.pi/agent/models.json`

This package replaces the hand-written `nan` block in `~/.pi/agent/models.json` (the NaN docs [pi example](https://nan.builders/docs/examples)). If you keep that block, be aware that **models.json overrides compose above registered providers** — the static file wins over this package. Remove the `nan` entry from `models.json` (keep `defaultProvider`/`defaultModel` in `settings.json` if you use them) to use the live catalog from this package. Per-request output caps can still be set there or via model `params`.

## pi version compatibility

Verified against pi **0.83.0**, **0.84.4**, and the 0.85 line (`registerProvider(provider)`, `registerProvider(name, config)`, `registerTool`, and `modelRegistry.getApiKeyForProvider` all present in both; pi-ai's compat entrypoint re-exports the openai-completions API factory on 0.83 and 0.84 alike). The extension degrades gracefully across versions:

- **Native path**: full Provider with stored-credential-then-env auth, live catalog overlay, and tier filtering.
- **Legacy fallback**: if the native Provider overload is rejected (or provider construction fails), registration falls back to the documented legacy `(name, config)` form with the same generated catalog and `$NAN_API_KEY` env auth (stored-credential auth is a limitation of the legacy path, not a silent behavior change).
- **MCP bridges**: skipped entirely on runtimes without `registerTool`; providers still register.
- **Async entrypoint**: pi awaits extension factories on 0.83 and 0.84 alike, so the streaming-API resolution at registration is transparent.
- `peerDependencies` is `>=0.83.0` with no upper bound (0.83 forks included).
- **Extension-side pi-ai imports**: only the bare `@earendil-works/pi-ai` root is imported statically. pi's extension loader aliases that specifier to the compat entrypoint; subpath imports (e.g. `@earendil-works/pi-ai/api/openai-completions.lazy`) get the alias applied as a prefix and fail to resolve, which is a whole-extension load failure. Guarded by `test/extension-load.test.ts`.

## helmcode

The shared factory (`src/provider-factory.ts`) is provider-agnostic, but `helmcode` is **not registered**: no confirmed base URL or capability source exists for it (absent from models.dev and NaN's docs), and this repo does not fabricate provider data. When an endpoint is confirmed, registering it is one entry in `src/providers.ts` plus catalog data — no second implementation. A contract test (`factory is shared`) already exercises a second provider through the same code path.

## Development

```bash
bun install
bun run generate-models   # regenerate the fallback catalog from models.dev (pre-publish)
bun test                  # unit + integration tests (fetch, auth, MCP bridges, compat)
bun run typecheck         # typecheck via bunx (local tsc, auto-installs if missing)
```

`prepublishOnly` runs generation + tests + typecheck. Typecheck resolves `tsc` via `bunx` because `bun publish` runs lifecycle scripts without `node_modules/.bin` on PATH (a bare `tsc` fails there with exit 127). Releases follow strict semver (see `AGENTS.md`); CI publishes when a merge to main changes code and the version. See `CONTRIBUTING.md` for the full contribution flow.
# @gtrabanco/pi-nan-provider

[NaN Builders](https://nan.builders) model provider for [pi](https://github.com/earendil-works/pi) — registers the `nan` provider via `pi.registerProvider()` using NaN's OpenAI-compatible API (`https://api.nan.builders/v1`, LiteLLM behind it).

Two-layer model catalog, never either alone:

1. **Generated fallback** (`scripts/models.generated.ts`, committed): capability data pulled from [models.dev](https://models.dev) (provider `nan`) at build time. Every number traces to its source — nothing is invented.
2. **Live `/models` fetch** at runtime: NaN's endpoint returns only model `id`s, so it is used to confirm which IDs are currently live. Live IDs are merged with the generated capability data; a live ID without generated data is kept with conservative placeholder limits (never fabricated capabilities). On timeout (~3s), network failure, auth error, or an unusable response, the generated catalog is used and startup is never blocked.

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

**Option 1 — env var (quick):**

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

Get a key from the [NaN platform](https://nan.builders) (user settings → API Keys). The key is personal and non-transferable.

## Models

Baseline catalog (from models.dev, provider `nan`, fetched 2026-09-04):

| Model | Context | Max output | Input | Reasoning |
|---|---|---|---|---|
| `qwen3.6` | 262,144 | 65,536 | text, image | yes |
| `gemma4` | 262,144 | 32,768 | text, image | yes |
| `deepseek-v4-flash` | 1,000,000 | 384,000 | text, image | yes |
| `mimo-v2.5` | 1,048,576 | 131,072 | text, image | yes |
| `glm5.2` | 500,000 | 131,072 | text | yes |
| `glm5.3-flash` | 1,000,000 | 131,072 | text, image | yes |
| `qwen3.8-flash` | 262,144 | 131,072 | text, image | yes |

Notes (recorded per entry in `scripts/models.generated.ts`):

- `deepseek-v4-flash` includes image input because NaN serves the Vision-Exp variant ([NaN docs](https://nan.builders/docs/models)); models.dev lists text only.
- `mimo-v2.5` is omnimodal (text/image/audio) on NaN, but pi's model type only represents text/image input, so audio is dropped from `input`.
- NaN bills via membership quota, which models.dev reports as zero per-token cost — pi's cost display will read $0.
- Compat (`supportsDeveloperRole: false`, `supportsReasoningEffort: true`, `supportsUsageInStreaming: true`, `maxTokensField: "max_tokens"`) matches the battle-tested LiteLLM config this package replaces; NaN's docs example (`supportsDeveloperRole: true`) is not battle-tested.

### Relationship to `~/.pi/agent/models.json`

This package replaces the hand-written `nan` block in `~/.pi/agent/models.json` (the NaN docs [pi example](https://nan.builders/docs/examples)). If you keep that block, be aware that **models.json overrides compose above registered providers** — the static file wins over this package. Remove the `nan` entry from `models.json` (keep `defaultProvider`/`defaultModel` in `settings.json` if you use them) to use the live catalog from this package. Per-request output caps can still be set there or via model `params`.

## helmcode

The shared factory (`src/provider-factory.ts`) is provider-agnostic, but `helmcode` is **not registered in v0.1.0**: no confirmed base URL or capability source exists for it (absent from models.dev and NaN's docs), and this repo does not fabricate provider data. When an endpoint is confirmed, registering it is one entry in `src/providers.ts` plus catalog data — no second implementation. A contract test (`factory is shared`) already exercises a second provider through the same code path.

## Development

```bash
bun install
bun run generate-models   # regenerate the fallback catalog from models.dev (pre-publish)
bun test                  # unit tests (fetch success/timeout/partial/fallback, auth, registration)
bun run typecheck         # tsc --noEmit
```

`prepublishOnly` runs generation + tests + typecheck. See `AGENTS.md` for the rules any agent (or human) must follow in this repo.

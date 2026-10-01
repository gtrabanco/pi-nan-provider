# Issue #17 — qwen3.8-flash returns unrelated/context-contaminated output with pi-nan-provider

https://github.com/gtrabanco/pi-nan-provider/issues/17 — triage, offline verification and
live probes (maintainer-authorized 2026-10-01, matrix A×3 + B×2 + C×3 + D×2 plus ~10 extra
cache-characterization calls on `qwen3.8-flash`, all ≤64 max_tokens).

## Verdict

**Not a client-side bug in pi-nan-provider (or in pi).** The reported foreign strings never
appear in anything pi sends. The only demonstrated gateway-side anomaly is a **response
cache on the NaN gateway that serves byte-identical requests from cache**; the remaining
explanation for the report is gateway-side (shared/stale cached completion or router
fallback), which belongs to NaN, not this package.

## Evidence

### 1. Offline payload capture (mock gateway, zero model tokens)

Isolated `PI_CODING_AGENT_DIR` + local Bun mock logging every request body; real pi 0.99.2
one-shot runs, extension vs `--no-extensions`:

- **System prompt is byte-identical with and without the extension** (25,420 chars):
  pi's base prompt + the cwd `AGENTS.md`. Extensions contribute NO prompt text.
- The extension's only delta: `tools` 4 → 13 (builtins + `web_search` + 8 `nan-media`
  tools), `max_tokens: 131072` (catalog), `store` removed by the sanitizer,
  `stream_options` preserved (usage compat).
- Search for the report's strings across the captured payloads, this repo, pi/pi-ai dist,
  pi-ai `providers/data/*.json`, nan-mcp-server 1.0.6/1.1.2, models.dev and NaN's
  openapi.json: **zero matches** ("Generate an image…" exists in nan-mcp-server
  descriptions, but not the reported "Generate a image").
- Official NaN MCP server (live, free handshake): exposes `web_search` only.

### 2. Live probes (maintainer-authorized)

| Probe | Setup | Result |
|---|---|---|
| C×3 | raw curl, no tools, issue prompt | `QWEN_PROVIDER_OK` ×3 — clean |
| D×2 | raw curl, full captured 13-tool payload (24.8K system) | clean ×2 |
| A×3 | exact issue repro through pi + extension | clean ×3 |
| B×2 | pi + extension, MCP disabled (`NAN_MCP_TOOLS=0 NAN_MEDIA_MCP=0`) | clean ×2 |

**10/10 clean — the issue did not reproduce** on pi 0.99.2 / package 0.10.3 (2026-10-01).

### 3. Gateway response cache discovered (the anomaly)

Back-to-back identical requests return the **same completion object** (same `id` AND same
`created`) — a replayed cache entry, not a new generation:

- 3 identical non-stream calls → identical id/created (TTL ≥ ~3 s; minutes later the same
  prompt got a fresh id, so TTL is short).
- Identical streaming calls → same id replayed too (pi always streams).
- Key granularity measured: system prompt (sys A vs B → different ids), user message,
  `tools` presence, `max_tokens`, `temperature` — all in the key **within one key**.

What could NOT be measured with a single API key: **whether the cache is shared across API
keys**. If NaN's LiteLLM cache key omits the API key / team, one tenant's cached completion
can be served to another — the only vector consistent with the report, given the client
payload is provably clean. Supporting context: NaN is a LiteLLM gateway, LiteLLM router
messages use `openrouter/anthropic/...`-style model names, and LiteLLM exact-match response
caching has had cross-request collision issues historically.

## Disposition

- This package: no code change. No sanitizer/catalog/factory defect.
- Action passed to NaN (reporter-side reproduction data would help: capture
  `id`/`created` of a polluted response — a repeated `id` across different prompts proves
  a cache hit and gives NaN the exact entry).
- Side finding (separate from this issue): `nan-mcp-server@1.1.2` now exposes 8 tools
  (`generate_image`, `edit_image`, `text_to_speech`, `list_voices`, `speech_to_text`,
  `list_models`, `embed_text`, `rerank_documents`); AGENTS.md documents 5. Cosmetic doc drift.

## Probe economy

~15 gateway calls on `qwen3.8-flash`, all ≤64 `max_tokens`, ~10K input tokens total
($0 per models.dev); MCP checks were handshake-only (`initialize` + `tools/list`).

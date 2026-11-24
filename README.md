# @gtrabanco/𝜋-nan-provider

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-1.6.2-blue)](https://github.com/gtrabanco/pi-nan-provider/releases)
[![Built with NaN](https://nan.builders/badge/built-with-nan-compact.svg)](https://cloud.nan.builders/r/7GK06FX8)

[NaN Builders](https://cloud.nan.builders/r/7GK06FX8) model provider + a native MCP server for [pi](https://github.com/earendil-works/pi). 

Registers the `nan` provider via `pi.registerProvider()` using NaN's OpenAI-compatible API (`https://api.nan.builders/v1`), and registers the community media MCP server via pi's native `pi.registerMcpServer()`.

> [!NOTE]
> **Requirements:** pi **≥ 1.4.0** (peer range `^1.4.0`). The package is verified against **pi 1.6.0 / pi-ai 1.6.0**; the peer floor only rises on pi minor realigns.

## ✨ Features

| Area | What you get |
| :--- | :--- |
| **Two-layer model catalog** | Build-time generated fallback (pi always starts, even offline) merged with the live `GET /v1/models` list; `filterModels` then hides whatever your key cannot call. |
| **Read-time catalog overlay** | Capability data is re-applied from the generated catalog on every `getModels()` / `getAllModels()` read, so a `models-store.json` written by an older package version can neither shadow it ([#19](https://github.com/gtrabanco/pi-nan-provider/issues/19)) nor re-register non-chat ids as chat models ([#32](https://github.com/gtrabanco/pi-nan-provider/issues/32)). The store decides *which* ids exist; the generated catalog decides *what they can do*. |
| **Non-chat endpoint guard** | `NON_CHAT_MODEL_IDS` keeps embedding / rerank / TTS / STT / image / video ids out of pi's chat picker. |
| **Strict payload sanitizer** | Every `/chat/completions` body is rewritten to match [NaN's published schema](https://nan.builders/openapi.json) before it leaves pi, whatever pi-ai version is bundled. |
| **Context-overflow rescue** | NaN's generic `400 Invalid request` is reclassified as an overflow when the request is estimated over the model's window ([#3](https://github.com/gtrabanco/pi-nan-provider/issues/3)), and a cold-cache `524` over `NAN_COLD_CACHE_CEILING_TOKENS` too ([#18](https://github.com/gtrabanco/pi-nan-provider/issues/18)) — pi compacts and retries instead of wedging. |
| **Truncated-stream retry** | `supportsFinishReason: true` turns an SSE stream closed before `finish_reason` into a retryable error instead of a silent stall ([#2](https://github.com/gtrabanco/pi-nan-provider/issues/2)). |
| **Streaming token usage** | `stream_options.include_usage` is on by default, so pi reports real input/output/reasoning/cache counts ([#4](https://github.com/gtrabanco/pi-nan-provider/issues/4), [#7](https://github.com/gtrabanco/pi-nan-provider/issues/7)). |
| **Reasoning controls** | Per-model `reasoningEffortValues` + `thinkingLevelMap` ([#16](https://github.com/gtrabanco/pi-nan-provider/issues/16)), the reasoning-only stream guard ([#21](https://github.com/gtrabanco/pi-nan-provider/issues/21)), and the per-model max-token field (`qwen3.8-max` keeps `max_completion_tokens`; `qwen3.8-flash` returned to `max_tokens` after NaN's gateway fix, [#34](https://github.com/gtrabanco/pi-nan-provider/issues/34) → [#36](https://github.com/gtrabanco/pi-nan-provider/issues/36)). |
| **Model-facts export** | `NAN_MODEL_FACTS` — one frozen, typed entry per billed chat model: limits, cost rates, reasoning contract, tool protocol, `max_tokens` semantics, thinking budget, cache mode and billing class, every cell carrying a provenance id ([#47](https://github.com/gtrabanco/pi-nan-provider/issues/47)). |
| **Attribution header** | `X-Pi-Provider: gtrabanco/pi-nan-provider@<version>` on every request, stripped when pi's install telemetry is disabled. |
| **Native image models** | `flux-2-klein` and `qwen-image-2.1` registered as pi `type: "image"` models, reachable from codemode and extensions. |
| **Native MCP media bridge** | The `nan-media` server (10 tools) registered through `pi.registerMcpServer()`, managed with `/nan-mcp`. |
| **Credits reporting** | `/nan-usage` shows credits balance with a progress bar, per-model breakdown (input / cached / output in M, credits consumed), and billing period — all from `GET /v1/usage` ([#37](https://github.com/gtrabanco/pi-nan-provider/issues/37)). |
| **Cache-anomaly evidence** | `cf-ray` capture on the repeated `id` + `created` gateway signature ([#17](https://github.com/gtrabanco/pi-nan-provider/issues/17)) plus the deterministic `/nan-debug` collector ([#35](https://github.com/gtrabanco/pi-nan-provider/issues/35)) with per-error evidence, every response's `cf-ray` joined into `turns.jsonl` (S11), flexible `--interval` windows ([#44](https://github.com/gtrabanco/pi-nan-provider/issues/44)) and the HTTP attempt tap ([#49](https://github.com/gtrabanco/pi-nan-provider/issues/49)): status, whitelisted headers, invisible retries (`attempt_n`), process-scoped concurrency/RPM and `payload_bytes` — the zip carries no prompt or tool content unless you opt in. |
| **pi integration** | Model refresh driven by pi's Models runtime, per-model `models.json` overrides, and the extension changelog (`pi.changelogPath`) that pi shows after an update. |

Commands:

| Command | Purpose |
| :--- | :--- |
| `/nan-mcp` | Manage the media MCP bridge (`status` / `enable` / `disable`) |
| `/nan-usage [1-90]` | Credits balance with usage bar, per-model breakdown (in / cached / out in M · credits cr), and all-time totals |
| `/nan-debug [topic] [--window N] [--interval FLEX] [--out path] [--emit] [--include-prompts] [--include-tools] [--all]` | Redacted, reproducible evidence package for NaN; content is opt-in |

---

### ⚡ Quick Start

1. **Get an API Key**: [Claim your NaN API key here](https://cloud.nan.builders/r/7GK06FX8) (referral link).
2. **Install**:
   ```bash
   pi install npm:@gtrabanco/pi-nan-provider
   ```
3. **Authenticate**:
   ```bash
   export NAN_API_KEY="sk-your-key-here"
   ```
4. **Verify**:
   ```bash
   pi --list-models nan
   ```

---

**Docs in English** (this file) · [Documentación en español](README.es.md)

## ⚙️ How it works

The provider uses a **two-layer model catalog plus a read-time overlay** to ensure reliability:

| Layer | Source | Purpose |
| :--- | :--- | :--- |
| **1. Generated Fallback** | `scripts/models.generated.ts` | Build-time snapshot from [models.dev](https://models.dev) plus manual overrides with provenance. Ensures pi can always start, even if the network fails. |
| **2. Live `/models` Fetch** | NaN Runtime API | Fetches the models your key can actually call and merges them with the fallback; `filterModels` hides anything the live list does not return. |
| **3. Read-time Overlay** | `withStaleCatalogOverlay` (`src/provider-factory.ts`) | Re-applies generated capability data on every `getModels()` / `getAllModels()` read, so a `models-store.json` written by an older package version cannot shadow it ([#19](https://github.com/gtrabanco/pi-nan-provider/issues/19)) nor re-register non-chat ids as chat models ([#32](https://github.com/gtrabanco/pi-nan-provider/issues/32)). |

> [!IMPORTANT]
> **Live list**: The live list is authoritative. Since 2026-11-10 NaN no longer has tier-exclusive models, so every catalog model is meant to be available to every key; a model the live `/models` response does not list for your key is still filtered out.

NaN's live `/models` also returns non-chat endpoint ids (embedding, rerank, TTS, STT, image, video). These are **not registered** as chat models — the classification is the single exported `NON_CHAT_MODEL_IDS` from `src/fetch-models.ts` (the same source used by the build-time generator). The merge skips their placeholders and places them in an observable `nonChat` bucket; `baselineModels` also filters them defensively, and the read-time overlay drops chat-type entries whose id is in that list — a stale store written before #15 (issue #32) cannot resurrect them. This prevents pi's chat picker from offering endpoints that cannot serve chat (requests would 404).

The registration is synchronous on purpose: the generated fallback catalog is available immediately, and pi's Models runtime drives the live refresh (network refresh at interactive startup and periodically, cache-only at registration), persisting the overlay between runs.

### 🧾 Strict request sanitizer

NaN answers HTTP 400 `Invalid request. Check your request parameters.` for any body that does not match the schema it publishes at [nan.builders/openapi.json](https://nan.builders/openapi.json) — a schema stricter than what pi-ai emits in several places. `src/openai-compat-sanitizer.ts` rewrites every outgoing `/chat/completions` payload on the way out, so no pi-ai version or conversation shape can produce an invalid request:

- an assistant `content` array carrying a tool call is moved into the top-level `tool_calls` field (NaN's `ContentPart` accepts only `text` and `image_url`);
- `reasoning_details` is stripped, and unknown content parts (e.g. `thinking`) are folded into a `text` part so reasoning is not silently lost;
- fields NaN's schema does not list are removed: `store` always, an empty `tools` array always, and `stream_options` unless the model's `compat.supportsUsageInStreaming` says the gateway reports it;
- `max_completion_tokens` is renamed to `max_tokens` (the documented field) unless the model's `compat.maxTokensField` opts out ([#34](https://github.com/gtrabanco/pi-nan-provider/issues/34); `qwen3.8-max` is the only catalog model that opts out after the [#36](https://github.com/gtrabanco/pi-nan-provider/issues/36) revert).

A caller-supplied `onPayload` hook is preserved and chained after sanitization.

### 🏷️ Attribution header

Every model this package registers carries an `X-Pi-Provider: gtrabanco/pi-nan-provider@<version>` HTTP header, added on top of whatever identity headers pi-ai sends (pi's own `User-Agent` is never modified). It identifies the requests coming from this provider extension — including the `/nan-usage` quota fetch — and it is omitted silently when the package version cannot be resolved. User `models.json` overrides that replace a model entry replace its headers too.

The header **follows pi's telemetry setting**: with `enableInstallTelemetry: false` in `settings.json` the header disappears from every request (evaluated live, so toggling the setting applies on the next request without a restart) — the header identifies the package in use, and users who opted out of telemetry should not be identifiable by it.

### 🧠 Model-switch safety

When you switch models, older pi-ai versions replayed the previous model's reasoning as plain assistant text with **no size bound**, which could overflow a 262K-context model's window; NaN answered with a generic `400 Invalid request. Check your request parameters.` that looked like a provider bug (upstream tracking: [pi-nan-provider#3](https://github.com/gtrabanco/pi-nan-provider/issues/3)). pi-ai 1.3.0 fixed this upstream (`transformMessages` now drops thinking blocks from a different model) and this package requires **pi ≥ 1.4.0** (peer range `^1.4.0`), so the extension-side guard that used to mitigate it was **removed in package 1.4.0** — no action is needed, upstream handles it.

A request can still overflow on its own merits — oversized tool outputs, images, or a destination window simply smaller than the content — and NaN answers the same generic 400 instead of naming the overflow, while pi's auto-compaction does not recognize it, so the session would wedge at the ceiling. The provider therefore **re-checks the request size on the way out**: when that generic 400 arrives for a request estimated over the model's window, the error is rewritten into a context-overflow message pi recognizes, so it compacts and retries instead of stalling. A generic 400 on a within-window request is left untouched, so unrelated errors are never mislabelled.

### ⏱️ Intermittent truncated streams (auto-retry, no silent stall)

NaN's LiteLLM gateway occasionally closes an SSE stream **before** emitting the final `finish_reason` chunk (observed on `glm5.3-flash`; [issue #2](https://github.com/gtrabanco/pi-nan-provider/issues/2)). The catalog declares `supportsFinishReason: true`, so pi-ai turns that into the error `Stream ended without finish_reason` — which matches pi's retryable-provider pattern and is **retried automatically**, instead of silently accepting a half-finished answer. If a gateway version never sends `finish_reason`, the turn now fails visibly once the retry budget is exhausted.

You can override any model's `compat` per-model in `~/.pi/agent/models.json` (pi's `docs/models.md` → Per-model Overrides); overrides compose above the registered provider. Example (forcing the retry behavior explicitly):

```json
{
  "providers": {
    "nan": {
      "modelOverrides": {
        "glm5.3-flash": { "compat": { "supportsFinishReason": true } }
      }
    }
  }
}
```

> Setting `supportsFinishReason: false` restores the old silent-stall behavior — not recommended.

**pi-ai 1.5.1+ compat escape hatches** (`~/.pi/agent/models.json`, per model, unchanged in 1.6.0): `compat.requiresToolsWithToolHistory: true` restores sending `tools: []` in conversations with tool history (pi-ai 1.5.1 omits it by default, fixing vLLM 0.20+ `tools must not be an empty array` rejections behind LiteLLM); `compat.requiresNonNullAssistantContent: true` sends `""` instead of `null` in assistant messages that only carry tool calls; `compat.promptCacheKeyMode: "disabled"` guarantees `prompt_cache_key` is never sent to the gateway (the default `auto` already never enables it for NaN).

**Streaming token usage:** `supportsUsageInStreaming` is `true` by default. NaN's published schema does not document `stream_options`, but the live gateway honors it — measured 2026-09-16 ([#7](https://github.com/gtrabanco/pi-nan-provider/issues/7)): two identical streaming calls per model, 0 usage chunks without the flag and exactly 1 with it, on `deepseek-v4-flash`, `glm5.3-flash`, `qwen3.6`, `gemma4` and `mimo-v2.5` (since removed). pi therefore reports real input/output/reasoning/cache token counts instead of zeros. If a model turns out not to report streaming usage, opt out per model — the request sanitizer then strips `stream_options` and the payload stays strict:

```json
{
  "providers": {
    "nan": {
      "modelOverrides": {
        "some-model": { "compat": { "supportsUsageInStreaming": false } }
      }
    }
  }
}
```

## 🔑 Authentication

`resolve()` checks the stored credential first, then falls back to the matching environment variable.

| Method | Command / Action | Notes |
| :--- | :--- | :--- |
| **Env Var** | `export NAN_API_KEY="..."` | Fastest for local development. |
| **`/login`** | `pi > /login nan` | Persistent; stores in `~/.pi/agent/auth.json`. |
| **Manual Config** | Edit `~/.pi/agent/auth.json` | Direct JSON manipulation. |

Get a key from the [NaN platform](https://cloud.nan.builders/r/7GK06FX8) (user settings → API Keys; referral link).

## 🔌 Native MCP Server

Since [pi 0.99.0 ships a built-in MCP client](https://github.com/earendil-works/pi/blob/main/docs/usage.md), this package bridges to native MCP (requires **pi >= 1.4.0**, the peer range floor since package 1.5.0).

The media bridge is **enabled by default** (session-scoped, visible in `/mcp`). Use `/nan-mcp` to manage it.

> [!WARNING]
> **NaN's official remote MCP server no longer exposes any tool.** Until 1.2.0 this package shipped a
> `nan-search` bridge pointing at `https://api.nan.builders/mcp`, which exposed
> `web_search`. That server now answers `initialize` with an empty `capabilities.tools` and
> `tools/list` with `{"tools":[]}` — verified with a valid key on 2026-10-15 — and NaN removed every
> MCP mention from its documentation (the old `/docs/mcp` page now redirects to `/docs/agent-setup`).
> The bridge was removed in **1.2.1** because registering a server that exposes nothing only produces
> a tool-less server in `/mcp`.
>
> **Bring your own `web_search` and fetch.** Install an MCP server that provides them (e.g. the
> `fetch` + `brave-search` pair for the official MCP servers, or any other search/fetch MCP server)
> and declare it in your global `mcp.json`:
>
> ```json
> {
>   "mcpServers": {
>     "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] },
>     "web-search": {
>       "command": "npx",
>       "args": ["-y", "@modelcontextprotocol/server-brave-search"],
>       "env": { "BRAVE_API_KEY": "your-key" }
>     }
>   }
> }
> ```
>
> Re-check `https://api.nan.builders/mcp` periodically: if NaN publishes tools again, this package can
> restore the bridge.

### 🛠️ Management Command: `/nan-mcp`

| Command | Effect |
| :--- | :--- |
| `/nan-mcp status` | Shows the media bridge state and API key resolution. |
| `/nan-mcp enable [target]` | Enables `nan-mcp-server` (persisted). |
| `/nan-mcp disable [target]` | Disables it persistently. |

The bridge resolves the stored `/login nan` credential (stored → env). If neither resolves, the server does not register and a warning is shown in the status output.

> [!NOTE]
> Registration happens when the extension loads. If you run `/login nan` **after** the session started, the factory has already run — run `/reload` (or `/nan-mcp enable`) to register the bridges without restarting pi.

### 🚧 Hosts without pi's built-in MCP extension (PI WEB)

pi connects registered servers from the extension that handles `mcp_servers_change` — the built-in
`mcp` extension, which also registers `/mcp`. Hosts that build pi's resource loader without
`extensionFactories` load **no** built-in extension at all (verified: PI WEB's
`createAgentSessionServices`, pi 0.99.1 / pi-web 1.202609.1), so nothing connects the servers and pi
reports `MCP server "nan-media" is registered, but no loaded extension connects MCP servers`.

There the bridges cannot expose tools, so this package replaces that cryptic error with one warning
per session, keeps the registrations idle, and lets `/nan-mcp enable` persist the toggle without
registering a server that can never connect. To get MCP in the CLI, enable the connector with
`pi config` → Built-in extensions → `mcp`.

### pi features and NaN models

- **Virtual models** — register a router under `nan` (`pi.registerVirtualModel({ provider: "nan", ... })`);
  it routes to the physical NaN models with no provider-side configuration.
- **Codemode** — works with any tool-calling NaN model. This package's MCP tools use
  `exposure: "direct"`, so codemode scripts can call them as well. Requires pi's built-in `codemode`
  extension (see the PI WEB note above).
- **Classifier models** — not applicable: NaN exposes no classifier API (chat plus
  embedding/rerank/audio/image endpoints only), so this provider registers no `type: "classifier"` models.

- **Native NaN image models** — flux-2-klein (text-to-image + image-to-image) and
  qwen-image-2.1 (text-to-image) are registered as pi image models (`type: "image"`,
  api `"nan-images"`). They do not appear in `/model`; they are reached through codemode
  with `models.generateImages(model, { input })` or from extensions with
  `ctx.modelRegistry.generateImages()`:

  ```
  const painter = await models.getModelOfType("image", "nan", "flux-2-klein")
  const result = await models.generateImages(painter, { input: [{ type: "text", text: "A red fox in the snow, watercolor" }] })
  if (result.stopReason !== "stop") return result.errorMessage
  for (const block of result.output) if (block.type === "image") image(block)
  ```

  Both models need the "inference" membership tier (403 otherwise); the image endpoints
  are rate-limited separately from chat (20 requests/min, 100 requests/month shared
  between the two models) and do not consume the chat token budget.
  [NaN docs](https://nan.builders/docs/models) and [OpenAPI](https://nan.builders/openapi.json)
  (checked 2026-10-01). The community nan-media MCP server already offers the same
  generation and editing as MCP tools, while the native image models let codemode and
  extensions call them directly.

---

### Community Media MCP Server
*Bridges [`nan-mcp-server`](https://github.com/luciferfran/nan-mcp-server) via a minimal local stdio client.*

- **Session-scoped**: The server connects at registration time (eager). Appears in `/mcp` with source "extension".
- **Config**: Files land in `~/nan-mcp-output/`.

| Tool | Purpose |
| :--- | :--- |
| `mcp__nan_media__generate_image` | Image generation (flux-2-klein) |
| `mcp__nan_media__edit_image` | Image-to-image editing (flux-2-klein) |
| `mcp__nan_media__text_to_speech` | Audio synthesis (kokoro) |
| `mcp__nan_media__list_voices` | List available voices |
| `mcp__nan_media__speech_to_text` | Audio transcription (whisper) |
| `mcp__nan_media__list_models` | List the NaN model ids the key can reach |
| `mcp__nan_media__embed_text` | Text embeddings (qwen3-embedding) |
| `mcp__nan_media__rerank_documents` | Document reranking (Qwen3-Reranker) |
| `mcp__nan_media__get_quota` | Per-model token quota (used / cap / remaining / reset) |
| `mcp__nan_media__get_usage` | Real consumption and credit pool (`GET /v1/usage`; preferred over stale `get_quota` counters) |

> pi 0.99.0–0.99.1 used the hyphenated form (`mcp__nan-media__*`); pi 0.99.2+ sanitizes tool
> names to `[A-Za-z0-9_]` only, so hyphens became underscores. The underscore form applies
> on every supported version (pi >= 1.4.0).

#### 🔧 Media Bridge Configuration

| Variable | Default | Description |
| :--- | :--- | :--- |
| `NAN_MEDIA_MCP` | — | Per-session override (`0` or `false` to disable). |
| `NAN_MEDIA_MCP_VERSION` | `1.5.0` | Pinned server version (recommended). |
| `NAN_MEDIA_MCP_COMMAND` | — | Custom command override. |
| `NAN_MEDIA_MCP_TIMEOUT_MS` | `120000` | Per-call timeout. |

#### 🤖 Automated Update Detection

A newer `nan-mcp-server` release won't silently drift this bridge's pin. The scheduler (`.github/workflows/check-nan-mcp-server-update.yml`) runs weekly and, when a newer version is found, opens an issue describing if the bump is **breaking** or **safe**.

```bash
bun run check-nan-mcp-server            # human-readable report
bun run check-nan-mcp-server --json     # machine-readable JSON
bun run check-nan-mcp-server --issue    # create/refresh the issue
```

PI SDK updates (`@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent`) are automated
too: the weekly `check-pi-sdk-versions` workflow files the `sdk-monitor` issue **and**
prepares a devDependencies-bump PR (`bun test` + `bun run typecheck` + type-surface diff
included) for human review — see `.github/workflows/check-pi-sdk-versions.yml` and `scripts/check-pi-sdk-versions.mjs`.

---

## 📊 Credits: `/nan-usage`

Shows your NaN credits balance with a progress bar, per-model breakdown (input / cached / output in millions, credits consumed), billing period, and all-time totals.

### How it works

`/nan-usage` calls NaN's [`GET /v1/usage`](https://nan.builders/docs/api#tag/usage) endpoint with the **same API key you already use for chat** — pi's stored credential (`/login nan`) or `NAN_API_KEY`. No CLI login, no session cookie, no extra setup.

The endpoint returns your usage (rows per date and model) plus totals covering the requested window — at most 90 inclusive days. The command reads those totals and displays them in a credits-first layout: the main progress bar reflects credits consumed vs. your plan's allowance, and each model row shows tokens (in / cached / out) and the credits it cost.

Rate limit: 30 requests per minute for `/usage`, separate from the model endpoints.

### Usage

```
/nan-usage        # current UTC month (matches the billing period)
/nan-usage 7      # rolling 7-day window (1-90)
/nan-usage 30     # rolling 30-day window
/nan-usage help   # show the usage line
```

### Setup

1. **Authenticate the `nan` provider in pi** with your `sk-...` key:
   ```
   /login nan
   ```
   or export it instead:
   ```bash
   export NAN_API_KEY=sk-...
   ```
2. **Use in pi**:
   ```
   /nan-usage
   ```

> [!TIP]
> No API key resolves? The command falls back to the static quota table from the docs and tells you how to authenticate.

### What you see

**With an API key** (real usage):
```
💳 Credits
  [████████░░░░░░░░░░░░] 13.4% used · 936.7 / 7000 (6063.3 remaining)
  Period: 2026-11-02 → 2026-12-02 UTC

⏱️  Next billing reset: 2026-12-02 UTC (20d 16h 0m 0s)

⚡ Usage
  deepseek-v4-flash · 2701.1M in / 450.9M cached / 8.8M out · 189.7 (cr)
  glm5.3-flash · 1619.6M in / 20.9M cached / 7.2M out · 621.4 (cr)
  qwen3.6 · 1123.9M in / 37.1M cached / 3.3M out · 0 (cr)
  mimo-v2.6-flash · 368.4M in / 67.4M cached / 3.3M out · 104.3 (cr)
  qwen3.8-flash · 286.4M in / 0.0M cached / 1.3M out · 21.3 (cr)
  qwen3-embedding · 4.6M in / 0.0M cached / 0.0M out · 0 (cr)
  gemma4 · 1.0M in / 0.0M cached / 0.0M out · 0 (cr)

Total credits consumed: 936.7 (cr)

All time: 30.9B tokens · 125,915 requests (as of 2026-11-12)
💡 Source: GET /v1/usage
```

- **💳 Credits**: progress bar showing `% used · used / allowance (remaining)`, billing period dates, pack credits with expiration if applicable, frozen-account warning.
- **⚡ Usage**: models sorted by credits consumed (primary billing metric), each row: `model · X.XM in / YM cached / Z.ZM out · W (cr)`.
- **All time**: lifetime totals with the last cache timestamp.

**Without an API key** (static limits only):
```
📊 NaN Quota Status (static limits)

⏱️  Next billing reset: 2026-09-30 UTC (2d 14h 30m 0s)

Model                        Monthly Cap
─────────────────────────────────────────────────
DeepSeek V4 Flash            3.0B
MiMo V2.5                    1.0B
MiMo V2.6 Flash              1.0B
Qwen 3.6                     uncapped
Gemma 4                      uncapped
Qwen 3.8 Flash               500.0M
GLM 5.3 Flash                2.0B
GLM 5.3                      3.0B (rolling 400.0M/4h)

💡 Set NAN_API_KEY or run `/login nan` to see real usage (GET /v1/usage).
```

Failures stay actionable: `401` → run `/login nan` or fix `NAN_API_KEY`, `404` → the account has no usage identity to report, `429` → retry after the `Retry-After` seconds.

---

## 🧾 Cache anomaly evidence: `/nan-debug`

NaN disabled the proxy response cache on 2026-11-17 (support confirmation): two
identical requests now return two real completions, each with its own usage. The
old cache could replay the same completion `id` and `created` timestamp for
back-to-back requests (the issue #17 signature). The capture stays as a relapse
tripwire; NaN asked for the `model` and the `cf-ray` of a couple of calls when it
recurs, and pi transcripts do
not keep response headers, so the provider captures them itself.

When two streams for the same model return the same `id` + `created`, one JSON
line is appended to `<agentDir>/nan-cache-anomalies.jsonl` —
`model`, the `id`/`created` pair, both `cf-ray` values, ISO timestamps and a
SHA-256 of the request payload. It is **local-only**: no prompt or response
content, no credentials, no paths, no upload. A write failure never breaks a
stream.

Independently of any anomaly, every response's `cf-ray` is kept in
`<agentDir>/nan-response-rays.jsonl` — `response_id`, `cf_ray`, `model`,
`observed_at`, newest 50,000 lines, local-only (issue #35 S11) — and the
report joins it into `turns.jsonl` as `cf_ray`, so support gets the rays of
any pair of calls without waiting for a recurrence.

Every HTTP **attempt** — including the retries pi-ai hides and the 429s that never
produce a gateway id — is kept in `<agentDir>/nan-http-attempts.jsonl`
(issue [#49](https://github.com/gtrabanco/pi-nan-provider/issues/49)): status,
the whitelisted response headers (`cf-ray`, `x-request-id`, `Retry-After`,
`x-should-retry`, `rate-limit-*`), millisecond start/end plus `latency_ms`,
`attempt_n`, `payload_bytes`, the request parameters (`reasoning_effort`,
`max_tokens`, the field actually sent, `stream`) and the process-scoped
inflight/60 s counters. The report embeds the window-filtered rows as
`http_attempts.jsonl`, so one zip answers *which attempt failed, with which
status and headers, after how many retries*.

`/nan-debug` turns those files plus your session transcripts into a redacted,
reproducible evidence package for NaN:

```text
/nan-debug                          # last 7 days; writes <agentDir>/nan-debug-report-<emission timestamp>/
/nan-debug cache --window 2         # topic label + a 2-day window
/nan-debug --window 2 --emit        # also writes <agentDir>/nan-debug-report-<emission timestamp>.zip
/nan-debug cache --include-prompts --emit   # embed raw transcripts (tool calls stripped)
/nan-debug --all --emit             # transcripts + tool calls + usage_window.json (the pre-#49 dump)
/nan-debug cache --out ~/evidence --emit
/nan-debug --interval 5min          # relative spans: 5min, 2h, 3d, 1mes
/nan-debug --interval "2026-11-10 - 2026-11-11 17:30"  # ranges, open ends, single points too
```

- The default directory and zip names carry the **emission** timestamp in UTC
  (`nan-debug-report-YYYY-MM-DDTHH:mm:ss`; the zip uses `-` instead of `:` so the
  name is portable), so consecutive runs never overwrite each other. The
  reported window lives in `metadata.window`. An explicit `--out` is respected
  verbatim.
- `--window N` (1–90 days) also fetches `GET /v1/usage` for the same period with
  your stored key and writes `usage_window.json`; without the flag nothing is
  fetched. That live call counts against your quota's request rate. The usage
  window stays out of the zip unless `--all`: it identifies your account/tier.
- `--interval <desc>` replaces `--window` (using both is an error) and accepts
  relative spans (`5min`, `2h`, `3d`, `1mes`), date/time ranges
  (`2026-11-10 - 2026-11-11 17:30`, `10:30 - 11:00`, cross-midnight
  `23:00 - 01:00`), open ends (`2026-11-10 -`, `- 2026-11-10`), year-months
  (`2026-11 - 2026-12`) and single points (`2026-11-10`,
  `2026-11-10T10:00:00Z`). The span is capped at 90 days and parsing is fully
  deterministic — no LLM calls. The topic, when you use one, goes before the flag.
- Content is opt-in and **off by default**: `--include-prompts` embeds the
  window-filtered transcripts under `sessions/` with tool calls and results
  stripped; `--include-tools` keeps them (it implies prompts); `--all` equals
  both plus `usage_window.json`. The preview states what will be shared before
  `--emit` writes anything.
- The default artifact contains `README.md`, `anonymized_usage.jsonl` (per
  date/session/model totals, stop-reason counts, cache-hit rate), `turns.jsonl`
  (per-turn usage, stop reason, error class, response id, `cf_ray`, gateway
  `created`, terminal `status`, `attempt_n` and the request parameters),
  `errors.jsonl` (class, `status`, `cf_ray`, `attempt_n`, the parsed
  `error_type`/`error_code`/`error_param`, the gateway's own message capped at
  200 chars and an MD5 hash; a failed request has no response id, so its
  `status`/`cf_ray`/`attempt_n` are correlated by model and the turn's span —
  with concurrent requests to the same model, `http_attempts.jsonl` is the
  authoritative per-attempt record), `http_attempts.jsonl` (one row per attempt plus one
  `response` row per completed request), `anomalies.jsonl` (the `cf-ray` pair) and
  `metadata.json` (package/pi-ai/pi versions, catalog provenance,
  `error_summary`, `topic_hash`, and `attempt_summary` with status counts, 429
  ratios per model/hour and the longest 429 streak). It carries **no** prompt,
  response or tool content.
- The zip is written **only** with `--emit`; the default run writes the local
  report and prints the preview.
- `--out <path>` writes the report anywhere you name it (and, with `--emit`,
  `<path>.zip`); a leading `~/` expands to your home directory, so the examples
  above write where they say. A flag token is never accepted as the path.
- A `topic` is hashed in the artifact (`topic_hash`, MD5[:16]); the console
  preview is local only. Session and worktree labels are MD5 truncated to 16
  characters (no per-report salt, so the same session links across reports).
  `errors.jsonl` never stores transport or pi-side exception text, a surviving
  server message has your home directory scrubbed to `~`, and credentials plus
  every non-whitelisted header are never collected.
- `inflight_process_at_start` and `starts_last_60s_process*` are scoped to this
  pi process: they are **not** your key's concurrency/RPM when other clients
  share the key. Merge every client's log for key-wide numbers.
- **Not public.** The artifact is for NaN support: `cf-ray`, `response_id` and
  millisecond timestamps are deliberately not anonymized, and `anomalies.jsonl`
  fingerprints the request payload with SHA-256. Identical inputs still produce
  byte-identical zip bytes.

## 🧭 Model facts: `NAN_MODEL_FACTS`

Most of what this package knows about the fleet used to live in this README and
in inline comments. Issue [#47](https://github.com/gtrabanco/pi-nan-provider/issues/47)
promotes it to data: one frozen, typed record, exported from the package entry
point, so your own scripts can plan context, caching and spend without parsing
prose or reaching into `scripts/`.

```ts
import { NAN_MODEL_FACTS, NAN_ENDPOINT_FACTS, NAN_MODEL_FACTS_META } from "@gtrabanco/pi-nan-provider";

const facts = NAN_MODEL_FACTS["deepseek-v4-flash"];
facts.contextWindow;             // 1048576
facts.maxTokens;                 // 32768
facts.cost;                      // { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
facts.input;                     // ["text", "image"]
facts.toolCalling;               // "openai-tools" | "xml"
facts.maxTokensSemantics;        // "bounds-total" | "bounds-visible-answer"
facts.thinkingBudget;            // "honoured" | "ignored" | "unmeasured"
facts.cacheMode;                 // "automatic" | "opt-in" | "unsupported" | "unmeasured"
facts.billingClass;              // "quota-only" | "credit-standard" | "credit-larger"
facts.parallelToolCalls;         // boolean | "unmeasured"
facts.structuredOutput;          // boolean | "unmeasured"

facts.provenance.toolCalling;                  // "docs"
NAN_MODEL_FACTS_META.sources["docs"];          // URL + check date
```

- **Facts, not policy.** The record says what a model *is*. How you use it —
  phases per context, a routing ladder, a cache-warming strategy — stays yours.
- **One entry per billed chat model** (13 today), keyed by model id. Non-chat
  endpoints (embedding, rerank, TTS, STT, image, video) are not chat models and
  are not exported.
- **Provenance per cell.** Every cell names a source id; `NAN_MODEL_FACTS_META.sources`
  resolves it to a URL with its check date or to a dated measurement recorded in
  this repo. The `override`, `compat` and `catalog-cost` ids point at the
  entry's own `notes`, which already carry those citations.
- **`"unmeasured"` means no claim was made**, never "false". `parallelToolCalls`
  is `"unmeasured"` on every model because nothing documents or measures several
  tool calls per turn; `structuredOutput` is a boolean only where the NaN docs
  document `json_object` / `json_schema` for that model.
- **Cold-prompt ceiling.** `coldCeilingTokens` is `"unmeasured"` on every entry:
  the only measurement is endpoint-wide, so it ships separately as
  `NAN_ENDPOINT_FACTS.coldCacheCeilingTokens` (200,000 tokens, measured
  2026-10-01) with a `coldCeilingScope` stating it is Cloudflare's 120 s
  proxy-read limit, not a model capability. Size a first cold request under it.
- **Offline and frozen.** The record is derived from the shipped generated
  catalog plus the build-time facts layer, so reading it performs no network
  call, and it is deep-frozen: one consumer cannot change what the next one
  reads. It never feeds provider registration — the read-time overlay
  ([#19](https://github.com/gtrabanco/pi-nan-provider/issues/19)) still decides
  the models a session sees.

## 📊 Models

Baseline catalog (verified against [NaN docs](https://nan.builders/docs/models) and [OpenAPI](https://nan.builders/openapi.json)).

Chat models:

| Model | Context | Max Output | Input | Reasoning |
| :--- | :--- | :--- | :--- | :---: |
| `qwen3.6` | 262,144 | 65,536 | text, image | ✅ |
| `gemma4` | 262,144 | 32,768 | text, image | ✅ |
| `deepseek-v4-flash` | 1,048,576 | 32,768* | text, image | ✅ |
| `mimo-v2.6-flash` | 1,048,576 | 131,072 | text, image | ✅ |
| `glm5.3-flash` | 1,048,576 | 131,072 | text, image | ✅ |
| `qwen3.8-flash` | 1,048,576 | 131,072 | text, image | ✅ |
| `glm5.3` | 1,048,576 | 131,072 | text | ✅ |
| `hy4-flash` | 1,048,576 | 65,536 | text, image | ✅ |
| `hy4` | 1,048,576 | 65,536 | text, image | ✅ |
| `kimi-k3.1-pro` | 1,048,576 | 1,048,576 | text, image | ✅ |
| `qwen3.8-max` | 1,000,000 | 131,072 | text, image | ✅ |
| `qwen4-max` | 1,000,000 | 131,072 | text, image | ✅ |
| `deepseek-v4-pro` | 1,048,576 | 393,216 | text | ✅ |

> [!NOTE]
> Context windows and max output above are the **documented** values from [the NaN docs](https://nan.builders/docs/models) (checked 2026-11-17), which are the source of truth; models.dev is a downstream mirror a human updates later and may lag. `glm5.3` was premium-only and live-only until NaN removed tier-exclusive models on 2026-11-10; it now ships in the static catalog, **text only** (an image, audio, video or file part — or an earlier turn carrying one — answers `400`, so start a new session or switch models).
>
> The **larger models** — `kimi-k3.1-pro`, `qwen3.8-max`, `qwen4-max`, `deepseek-v4-pro`, `hy4`, `hy4-flash` — are the ones NaN bills as "larger model" (they use credits faster). The four that entered the catalog on 2026-11-10 were carrying a flat 32,768 max output and no reasoning mapping because the docs did not document them yet; since 2026-11-17 each one declares its own "Max answer" and its documented reasoning behaviour. `qwen4-max` and `hy4-flash` are new ids the catalog did not have (models.dev provider `nan` lists neither; the live `/models` and the docs do). Maximum output is a ceiling, not a request: pi-ai clamps the outgoing budget to the room left in the context window (`clampMaxTokensToContext`), so a 1M-token ceiling on `kimi-k3.1-pro` never turns into an over-context `max_tokens`.
>
> `qwen3.8-max` sends `max_completion_tokens` instead of `max_tokens`: its docs state that `max_tokens` bounds only the visible answer while the reasoning bills on top of it, so the client budget must cap the total (2026-11-17 docs). `qwen3.8-flash` used the same interim field after NaN confirmed the behaviour on 2026-11-11 ([#34](https://github.com/gtrabanco/pi-nan-provider/issues/34)); NaN support reported the gateway fix deployed and validated on 2026-11-17, so [#36](https://github.com/gtrabanco/pi-nan-provider/issues/36) removed that override and it sends the classic `max_tokens` again (the docs page still carries the old sentence; the support-confirmed gateway behaviour wins).
>
> Every catalog model reports **cost 0**: NaN bills a credit pool (1 credit ≈ 0.026 €), not per-token USD, so pi's cost estimate has nothing to report. models.dev provider `nan` started publishing a derived USD conversion on 2026-11-17; the catalog does not adopt it, because pi would show that estimate as real money. Use `/nan-usage` for the real consumption.
>
> `*` deepseek-v4-flash max output 32,768 is the ceiling from the official NaN pi docs (https://nan.builders/docs/pi, "the same set the NaN CLI writes", issue #20, 2026-10-02); models.dev lists 384,000 but the gateway rejects `max_tokens` above ~256k with 403. `gemma4` keeps models.dev's 32,768: the docs' 65,536 in the pi/OpenCode blocks is described there as "a client-side budget rather than a server cap", so the smaller value stays rather than risking a `400`.
>
> **Cold prompt cache practical ceiling (issue #18).** The context windows above are the models' real windows, but the api.nan.builders edge (Cloudflare) aborts responses past its 120 s Proxy Read Timeout. Measured with direct cold requests (unique filler, no prompt cache; 2026-10-01): 208,036 tokens (~960 KB body) answered in 12.9 s while ~220k and ~286k tokens returned **HTTP 524 `origin_response_timeout`** at ~126 s; the same sizes with a warm prompt cache answer in ~10 s. The practical ceiling for cold requests is therefore well below the declared windows. Since 1.0.0 the provider reclassifies a 524 on an estimated over-200,000-token request (`NAN_COLD_CACHE_CEILING_TOKENS`) as a context overflow so pi compacts and retries instead of wedging; a 524 on a smaller request is left alone (genuine transient timeout).

Non-chat image models (available through `models.generateImages()` /
`getModelOfType("image", …)`, not through `/model`):

| Model | Input | Purpose |
| :--- | :--- | :--- |
| `flux-2-klein` | text, image | Text-to-image + image-to-image |
| `qwen-image-2.1` | text | Text-to-image |

`minimax-h3` (video generation, listed by the live `/models` since 2026-11-10) is classified as non-chat too: it is never registered as a chat model.

> [!NOTE]  
> `mimo-v2.6-flash` is served by NaN and has been listed by models.dev provider `nan` since 2026-09-29. Before that it entered the catalog through a manual-only entry; that entry is kept as a fallback (re-emitted automatically if models.dev drops the model again) and its provenance note stays attached to the generated entry.
>
> `mimo-v2.5` was removed by NaN: it no longer appears in the [NaN docs](https://nan.builders/docs/models) nor in the [OpenAPI model list](https://nan.builders/openapi.json) (checked 2026-09-29), so it is out of the catalog — `mimo-v2.6-flash` replaces it (same 1,048,576 / 131,072 limits, 1.0B monthly quota). Historical `/nan-usage` consumption for `mimo-v2.5` still shows under the undocumented-models section.

---

## 🧠 Reasoning controls

NaN's `reasoning_effort` parameter controls how much the model thinks before answering — but the degree of control varies by model:

| Model | Reasoning effort | How it works |
| :--- | :--- | :--- |
| `glm5.3`, `glm5.3-flash` | `minimal` · `low` · `medium` · `high` · `xhigh` · `max` | GLM cannot stop reasoning: the docs apply `none` as `minimal`, its shortest reasoning (a few tokens), so `thinking: "off"` sends `minimal` via the catalog's `thinkingLevelMap`. Higher values reason longer before answering. `glm5.3-flash` was measured at ~38 reasoning tokens for `minimal` (issue #16, 2026-09-27); `none` does not suppress it |
| `qwen3.6`, `gemma4` | `none` · `minimal` · `low` · `medium` · `high` · `xhigh` · `max` | `none`/`minimal` skip reasoning entirely; the others cap the reasoning phase at 2K / 8K / 16K / 32K tokens. `thinking: "off"` sends `reasoning_effort: "none"` automatically via the catalog's `thinkingLevelMap` — the NaN docs state that with no parameter these models reason by default (16,384-token budget), so off must be explicit |
| `deepseek-v4-flash` | `none` · `minimal` · `low` · `medium` · `high` · `xhigh` · `max` | `none` disables reasoning (0 reasoning tokens, a full answer); every other value only steers it — measured 57 reasoning tokens for `low`, 63 for omitting the parameter, 109 for `minimal` (issue #16, re-probed live 2026-10-14). `thinking: "off"` sends `reasoning_effort: "none"` via the catalog's `thinkingLevelMap` — without it the model runs away to `finish_reason: "length"` with no answer |
| `qwen3.8-flash` | `none` · `minimal` · `low` · `medium` · `high` · `xhigh` · `max` | Reasoning is on by default (`none` turns it off, the rest steer its depth). `thinking: "off"` sends `reasoning_effort: "none"`; its budget is capped with `max_tokens`, which NaN's gateway now honours (issue #36), and a hard reasoning cap is available through `thinking_budget` |
| `qwen4-max` | `none` · `minimal` · `low` · `medium` · `high` · `xhigh` · `max` | `none` turns reasoning off, `minimal` to `max` steer it, and `max_tokens` bounds reasoning **plus** answer. The docs advise setting a budget: an open-ended answer can run for many minutes |
| `mimo-v2.6-flash` | `none` · `low` · `medium` · `high` · `max` | `none` turns reasoning off (`minimal` is applied as `low`, `xhigh` as `max`, so those two are not declared separately); reasoning counts inside `max_tokens`. Measured live 2026-10-14: `none` gives 0 reasoning tokens with a full answer |
| `qwen3.8-max` | `none` | `none` turns reasoning off. `max_tokens` bounds only the visible answer, so the catalog sends `max_completion_tokens` to cap the total. A reasoning budget (`thinking_budget`) is not honoured on this model |
| `hy4` | `none` | Reasons by default — the gateway applies `low` when the request names no level, and your own value always wins. `none` turns it off. `max_tokens` bounds reasoning plus answer |
| `hy4-flash` | `none` | Reasons by default with no default level; `reasoning_effort: "none"` turns it off (it ignores `enable_thinking`). `max_tokens` bounds reasoning plus answer, so a small one can come back empty |
| `kimi-k3.1-pro`, `deepseek-v4-pro` | *(no mapping declared)* | The docs keep these two out of the reasoning contract and state that the `none` aliases are **not mapped** on them, so the catalog declares no effort values and no `thinkingLevelMap`: `thinking: "off"` sends no parameter and the model decides |

> [!NOTE]
> **`xhigh` and `max` are opt-in in pi.** pi-ai only offers a model those two levels when its `thinkingLevelMap` declares them (`getSupportedThinkingLevels`; a request for either one is otherwise silently clamped to `high`). The catalog therefore carries identity entries (`xhigh: "xhigh"`, `max: "max"`) on every model whose docs declare a ladder up to `max` — the seven chat models plus `mimo-v2.6-flash`, where the gateway applies `xhigh` as `max`. `hy4`, `hy4-flash` and `qwen3.8-max` document only their off switch, and `kimi-k3.1-pro`/`deepseek-v4-pro` sit outside the contract, so those five stay at `off`…`high`.
> [!NOTE]  
> `maxTokens` can stop before the visible answer on some models. The measured case is `deepseek-v4-flash`: `max_tokens=512` still consumed 13,376 completion tokens, all reasoning (26x the ceiling, issue #16, 2026-09-27). `qwen3.8-max` documents the same shape — `max_tokens` bounds only the visible answer — so its catalog entry sends `max_completion_tokens` to cap the total (2026-11-17 docs). `qwen3.8-flash` was the #34 case (NaN confirmed the same behaviour on 2026-11-11); NaN support reported the gateway fix deployed and validated on 2026-11-17, so package 1.5.7 removed the interim override and it sends the classic `max_tokens` again (issue #36). Per the 2026-11-17 docs, `max_tokens` does bound reasoning plus answer on `qwen4-max` (up to 131,000), `hy4`/`hy4-flash` (up to 64,000) and `mimo-v2.6-flash`. Reasoning alone can still consume the whole budget and end the turn with empty content; that closure carries NaN's `reasoning_only_stream` marker and pi-ai retries the turn (issue #21).


---

## 🚀 Development

```bash
bun install
bun run generate-models   # Regenerate fallback catalog
bun test                  # Run all tests
bun run typecheck         # Run typechecking
bun run check-nan-mcp-server            # Newer nan-mcp-server release?
bun run check-pi-sdk-versions           # Newer pi / pi-ai release?
```

Every code change must bump `package.json` in the same PR; capability values that diverge from
models.dev belong in `scripts/manual-overrides.ts` with a provenance note, never hand-edited into
the generated catalog.

*Releases follow strict semver. CI publishes automatically on merge to `main`. After an update, pi
shows this package's `CHANGELOG.md` (`pi.changelogPath`, pi 1.5.0+).*

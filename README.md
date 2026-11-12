# @gtrabanco/𝜋-nan-provider

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-1.5.4-blue)](https://github.com/gtrabanco/pi-nan-provider/releases)
[![Built with NaN](https://nan.builders/badge/built-with-nan-compact.svg)](https://cloud.nan.builders/r/7GK06FX8)

[NaN Builders](https://cloud.nan.builders/r/7GK06FX8) model provider + a native MCP server for [pi](https://github.com/earendil-works/pi). 

Registers the `nan` provider via `pi.registerProvider()` using NaN's OpenAI-compatible API (`https://api.nan.builders/v1`), and registers the community media MCP server via pi's native `pi.registerMcpServer()`.

> [!NOTE]
> **Requirements:** pi **≥ 1.4.0** (peer range `^1.4.0`). The package is verified against **pi 1.5.1 / pi-ai 1.5.1**; the peer floor only rises on pi minor realigns.

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
| **Reasoning controls** | Per-model `reasoningEffortValues` + `thinkingLevelMap` ([#16](https://github.com/gtrabanco/pi-nan-provider/issues/16)), the reasoning-only stream guard ([#21](https://github.com/gtrabanco/pi-nan-provider/issues/21)) and the `max_completion_tokens` interim bound for `qwen3.8-flash` ([#34](https://github.com/gtrabanco/pi-nan-provider/issues/34)). |
| **Attribution header** | `X-Pi-Provider: gtrabanco/pi-nan-provider@<version>` on every request, stripped when pi's install telemetry is disabled. |
| **Native image models** | `flux-2-klein` and `qwen-image-2.1` registered as pi `type: "image"` models, reachable from codemode and extensions. |
| **Native MCP media bridge** | The `nan-media` server (9 tools) registered through `pi.registerMcpServer()`, managed with `/nan-mcp`. |
| **Credits reporting** | `/nan-usage` shows credits balance with a progress bar, per-model breakdown (input / cached / output in M, credits consumed), and billing period — all from `GET /v1/usage` ([#37](https://github.com/gtrabanco/pi-nan-provider/issues/37)). |
| **Cache-anomaly evidence** | `cf-ray` capture on the repeated `id` + `created` gateway signature ([#17](https://github.com/gtrabanco/pi-nan-provider/issues/17)) plus the deterministic `/nan-debug` collector ([#35](https://github.com/gtrabanco/pi-nan-provider/issues/35)). |
| **pi integration** | Model refresh driven by pi's Models runtime, per-model `models.json` overrides, and the extension changelog (`pi.changelogPath`) that pi shows after an update. |

Commands:

| Command | Purpose |
| :--- | :--- |
| `/nan-mcp` | Manage the media MCP bridge (`status` / `enable` / `disable`) |
| `/nan-usage [1-90]` | Credits balance with usage bar, per-model breakdown (in / cached / out in M · credits cr), and all-time totals |
| `/nan-debug [topic] [--window N] [--out path] [--emit]` | Redacted, reproducible evidence package for NaN |

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
- `max_completion_tokens` is renamed to `max_tokens` (the documented field) unless the model's `compat.maxTokensField` opts out ([#34](https://github.com/gtrabanco/pi-nan-provider/issues/34), `qwen3.8-flash`).

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

**pi-ai 1.5.1 compat escape hatches** (`~/.pi/agent/models.json`, per model): `compat.requiresToolsWithToolHistory: true` restores sending `tools: []` in conversations with tool history (pi-ai 1.5.1 omits it by default, fixing vLLM 0.20+ `tools must not be an empty array` rejections behind LiteLLM); `compat.requiresNonNullAssistantContent: true` sends `""` instead of `null` in assistant messages that only carry tool calls; `compat.promptCacheKeyMode: "disabled"` guarantees `prompt_cache_key` is never sent to the gateway (the default `auto` already never enables it for NaN).

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

> pi 0.99.0–0.99.1 used the hyphenated form (`mcp__nan-media__*`); pi 0.99.2+ sanitizes tool
> names to `[A-Za-z0-9_]` only, so hyphens became underscores. The underscore form applies
> on every supported version (pi >= 1.4.0).

#### 🔧 Media Bridge Configuration

| Variable | Default | Description |
| :--- | :--- | :--- |
| `NAN_MEDIA_MCP` | — | Per-session override (`0` or `false` to disable). |
| `NAN_MEDIA_MCP_VERSION` | `1.3.0` | Pinned server version (recommended). |
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

NaN's gateway response cache can replay the same completion `id` and `created`
timestamp for back-to-back requests (the issue #17 signature). NaN asked for the
`model` and the `cf-ray` of a couple of calls when it recurs; pi transcripts do
not keep response headers, so the provider captures them itself.

When two streams for the same model return the same `id` + `created`, one JSON
line is appended to `<agentDir>/nan-cache-anomalies.jsonl` —
`model`, the `id`/`created` pair, both `cf-ray` values, ISO timestamps and a
SHA-256 of the request payload. It is **local-only**: no prompt or response
content, no credentials, no paths, no upload. A write failure never breaks a
stream.

`/nan-debug` turns that file plus your session transcripts into a redacted,
reproducible evidence package for NaN:

```text
/nan-debug                          # last 7 days, writes <agentDir>/nan-debug-report/
/nan-debug cache --window 2         # topic label + a 2-day window
/nan-debug --window 2 --emit        # also writes <agentDir>/nan-debug-report.zip
/nan-debug cache --out ~/evidence --emit
```

- `--window N` (1–90 days) also fetches `GET /v1/usage` for the same period with
  your stored key and writes `usage_window.json`; without the flag nothing is
  fetched. That live call counts against your quota's request rate.
- The zip is written **only** with `--emit`; the default run writes the local
  report and prints a preview.
- `--out <path>` writes the report anywhere you name it (and, with `--emit`,
  `<path>.zip`); a leading `~/` expands to your home directory, so the examples
  above write where they say. A flag token is never accepted as the path.
- The report contains `README.md`, `anonymized_usage.jsonl` (per date/session/
  model totals, stop-reason counts, cache-hit rate), `turns.jsonl` (per-turn
  usage, stop reason, error class, response id), `anomalies.jsonl` (`cf-ray`
  pair) and `metadata.json` (package/pi-ai/pi versions, catalog provenance).
- Session and worktree labels are MD5-truncated to 12 chars; `errorMessage` is
  reduced to `overflow | rate_limited | invalid_request | transport | other`;
  prompt/response content and credentials are never collected. Identical inputs
  produce byte-identical zip bytes.

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
| `glm5.3` | 1,048,576 | 131,072 | text, image | ✅ |
| `kimi-k3.1-pro` | 1,048,576 | 32,768 | text, image | ✅ |
| `qwen3.8-max` | 1,000,000 | 32,768 | text, image | ✅ |
| `deepseek-v4-pro` | 1,048,576 | 32,768 | text | ✅ |
| `hy4` | 1,048,576 | 32,768 | text, image | ✅ |

> [!NOTE]
> Context windows above are the **documented** windows from [the NaN docs](https://nan.builders/docs/models) (checked 2026-10-14), which are the source of truth; models.dev is a downstream mirror a human updates later and may lag. `glm5.3` was premium-only and live-only until NaN removed tier-exclusive models on 2026-11-10; it now ships in the static catalog with the values it carried (text+image, 1,048,576 / 131,072).
>
> `kimi-k3.1-pro`, `qwen3.8-max`, `deepseek-v4-pro` and `hy4` are NaN's external-provider (ZDR) models launched on 2026-11-10. NaN's docs and OpenAPI do not list them yet, but the live `GET /v1/models` does (checked 2026-11-10). Their values come from NaN's pricing page ("1M context"), the NaN pi docs (`maxTokens` 32,768 for every 1M-context model) and the first-party vendor entries on models.dev (modalities; `qwen3.8-max` uses the vendor's 1,000,000 window); cost is 0 and no `reasoning_effort` mapping is declared, because how the gateway handles it for external providers is unmeasured. Each entry carries its provenance note in `scripts/models.generated.ts`.
>
> `*` deepseek-v4-flash max output 32,768 is the ceiling from the official NaN pi docs (https://nan.builders/docs/pi, "the same set the NaN CLI writes", issue #20, 2026-10-02); models.dev still lists 384,000 but the gateway rejects `max_tokens` above ~256k with 403.
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
| `glm5.3` | `low` · `medium` · `high` · `max` | Fully controllable — higher values let the model reason longer. `thinking: "off"` sends `low`, the shallowest level the NaN docs list, via the catalog's `thinkingLevelMap`. `minimal` is **not** in this model's declared values: issue #16 measured it on `glm5.3-flash` only, and `glm5.3` itself was never measured |
| `glm5.3-flash` | `minimal` · `low` · `medium` · `high` · `max` | Fully controllable — higher values let the model reason longer; `minimal` yields ~38 reasoning tokens (issue #16, measured 2026-09-27). `none` does NOT suppress reasoning (13,382 tokens), so `thinking: "off"` sends `minimal`, the shallowest effective value, via the catalog's `thinkingLevelMap` |
| `qwen3.6`, `gemma4` | `none` · `minimal` · `low` · `medium` · `high` · `max` | `none`/`minimal` skip reasoning entirely; others cap at 2K / 8K / 16K / 32K tokens. `thinking: "off"` sends `reasoning_effort: "none"` automatically via the catalog's `thinkingLevelMap` — the NaN docs state that with no parameter these models reason by default (16,384-token budget), so off must be explicit |
| `deepseek-v4-flash` | `none` (catalog declares ["none"]) | `none` disables reasoning (0 reasoning tokens, a full answer); every other value — including `minimal` and omitting the parameter — leaves it ON (57 / 63 / 109 reasoning tokens), so the catalog declares only `none`. Re-probed live 2026-10-14: the NaN docs claim "any value (no effect)", but the measurement wins. `thinking: "off"` sends `reasoning_effort: "none"` automatically via the catalog's `thinkingLevelMap` — without it the model runs away to `finish_reason: "length"` with no answer (issue #16) |
| `qwen3.8-flash` | *(accepted but not adjustable)* | The parameter is accepted and never rejected, but the model manages its own reasoning depth — it is never an error to send a value this model doesn't adjust |
| `kimi-k3.1-pro`, `qwen3.8-max`, `deepseek-v4-pro`, `hy4` | *(no mapping declared)* | External-provider models launched 2026-11-10; how the gateway translates `reasoning_effort` for them is unmeasured, so the catalog declares no effort values and no `thinkingLevelMap` (`thinking: "off"` sends no parameter) |
| `mimo-v2.6-flash` | `none` | The docs called this "depth not adjustable", but the live gateway (2026-10-14) shows `none` gives 0 reasoning tokens with a full answer while `low` gives 22 and omitting the parameter 17 — so `thinking: "off"` sends `reasoning_effort: "none"` via the catalog's `thinkingLevelMap` |
> [!NOTE]  
> `maxTokens` does NOT bound the reasoning phase on NaN models. The reasoning phase runs to completion (or is cut at NaN's reasoning-only stream limit: 45,000 reasoning characters, or 420 s without visible output) regardless of `maxTokens` — measured: `max_tokens=512` on deepseek-v4-flash still consumed 13,376 completion tokens, all reasoning (26x the ceiling). This is gateway behavior confirmed by issue #16 (measured 2026-09-27) and by NaN for `qwen3.8-flash` (issue #34, 2026-11-11 — the excess also bills against the quota). As an interim bound for `qwen3.8-flash` the catalog sends `max_completion_tokens` instead, which NaN confirmed IS respected; it survives because that model's compat opts out of the schema sanitizer's rename to `max_tokens` (its published OpenAPI schema still documents only `max_tokens`). Remove that override once NaN ships their gateway fix — `test/issue-34-max-completion-tokens.test.ts` is the tripwire. Reasoning alone can still consume the whole budget and end the turn with empty content; that closure carries NaN's `reasoning_only_stream` marker and pi-ai retries the turn (issue #21).


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

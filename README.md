# @gtrabanco/pi-nan-provider

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-0.10.0-blue)](https://github.com/gtrabanco/pi-nan-provider/releases)

[NaN Builders](https://nan.builders) model provider + native MCP servers for [pi](https://github.com/earendil-works/pi). 

Registers the `nan` provider via `pi.registerProvider()` using NaN's OpenAI-compatible API (`https://api.nan.builders/v1`), and registers MCP servers via pi's native `pi.registerMcpServer()`.

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

The provider uses a **two-layer model catalog** to ensure reliability:

| Layer | Source | Purpose |
| :--- | :--- | :--- |
| **1. Generated Fallback** | `scripts/models.generated.ts` | Build-time snapshot from [models.dev](https://models.dev). Ensures pi can always start, even if the network fails. |
| **2. Live `/models` Fetch** | NaN Runtime API | Fetches your real-time available models based on your API key's tier. Merged with fallback data. |

> [!IMPORTANT]
> **Tier Detection**: The live list is authoritative. If your key has premium access, those models will appear automatically; otherwise, they are filtered out.

The registration is synchronous on purpose: the generated fallback catalog is available immediately, and pi's Models runtime drives the live refresh (network refresh at interactive startup and periodically, cache-only at registration), persisting the overlay between runs.

### 🧠 Model-switch safety (cross-model reasoning guard)

When you switch models, pi-ai replays the previous model's reasoning as plain assistant text — with **no size bound**. A single long or degenerate reasoning trace can therefore overflow a 262K-context model's window, and NaN answers with a generic `400 Invalid request. Check your request parameters.` that looks like a provider bug (upstream tracking: [pi-nan-provider#3](https://github.com/gtrabanco/pi-nan-provider/issues/3); open upstream issue: [pi#6167](https://github.com/earendil-works/pi/issues/6167)).

This package **drops every replayed cross-model reasoning block**, so switching from a 1M-context model to a 262K one (`qwen3.6`) no longer overflows the window. The models' answers and tool results are untouched — only their internal reasoning traces are removed, so `qwen3.6` can still answer about what another model did. Same-model reasoning is never altered, and the guard only acts on requests targeting this package's providers. Set `NAN_THINKING_GUARD=0` to disable it.

If a request still overflows — the guard is disabled, the inflation is not a reasoning block (large tool outputs, images), or the destination window is simply smaller — NaN answers the same generic 400 instead of naming the overflow, and pi's auto-compaction does not recognize it, so the session wedges at the ceiling. The provider therefore **re-checks the request size on the way out**: when that generic 400 arrives for a request estimated over the model's window, the error is rewritten into a context-overflow message pi recognizes, so it compacts and retries instead of stalling. A generic 400 on a within-window request is left untouched, so unrelated errors are never mislabelled.

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

**Streaming token usage:** `supportsUsageInStreaming` is `true` by default. NaN's published schema does not document `stream_options`, but the live gateway honors it — measured 2026-09-16 ([#7](https://github.com/gtrabanco/pi-nan-provider/issues/7)): two identical streaming calls per model, 0 usage chunks without the flag and exactly 1 with it, on `deepseek-v4-flash`, `glm5.3-flash`, `qwen3.6`, `mimo-v2.5` and `gemma4`. pi therefore reports real input/output/reasoning/cache token counts instead of zeros. If a model turns out not to report streaming usage, opt out per model — the request sanitizer then strips `stream_options` and the payload stays strict:

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

## 🔌 Native MCP Servers

Since [pi 0.99.0 ships a built-in MCP client](https://github.com/earendil-works/pi/blob/main/docs/usage.md), this package migrates its bridges to native MCP (requires `pi >=0.99` — breaking).

Both bridges are **enabled by default** (session-scoped, visible in `/mcp`). Use `/nan-mcp` to manage them.

### 🛠️ Management Command: `/nan-mcp`

| Command | Effect |
| :--- | :--- |
| `/nan-mcp status` | Shows current state of both bridges and API key resolution. |
| `/nan-mcp enable [target]` | Enables `web-search` or `nan-mcp-server` (persisted). |
| `/nan-mcp disable [target]` | Disables a bridge persistently. |

Both bridges resolve the stored `/login nan` credential (stored → env). If neither resolves, the bridge does not register and a warning is shown in the status output.

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

### pi 0.99 features and NaN models

- **Virtual models** — register a router under `nan` (`pi.registerVirtualModel({ provider: "nan", ... })`);
  it routes to the physical NaN models with no provider-side configuration. The cross-model thinking
  guard skips virtual selections, because the routed physical model is not visible to the `context` hook.
- **Codemode** — works with any tool-calling NaN model. This package's MCP tools use
  `exposure: "direct"`, so codemode scripts can call them as well. Requires pi's built-in `codemode`
  extension (see the PI WEB note above).
- **Classifier models** — not applicable: NaN exposes no classifier API (chat plus
  embedding/rerank/audio/image endpoints only), so this provider registers no `type: "classifier"` models.

---

### 1. Official NaN MCP Server
*Official remote MCP server registered natively via `pi.registerMcpServer()`.*

- **`mcp__nan-search__web_search(query, ...)`**: Performs web searches through NaN's gateway.

### 2. Community Media MCP Server
*Bridges [`nan-mcp-server`](https://github.com/luciferfran/nan-mcp-server) via a minimal local stdio client.*

- **Session-scoped**: The server connects at registration time (eager). Appears in `/mcp` with source "extension".
- **Config**: Files land in `~/nan-mcp-output/`.

| Tool | Purpose |
| :--- | :--- |
| `mcp__nan-media__generate_image` | Image generation (flux-2-klein) |
| `mcp__nan-media__edit_image` | Image-to-image editing (flux-2-klein) |
| `mcp__nan-media__text_to_speech` | Audio synthesis (kokoro) |
| `mcp__nan-media__list_voices` | List available voices |
| `mcp__nan-media__speech_to_text` | Audio transcription (whisper) |

#### 🔧 Media Bridge Configuration

| Variable | Default | Description |
| :--- | :--- | :--- |
| `NAN_MEDIA_MCP` | — | Per-session override (`0` or `false` to disable). |
| `NAN_MEDIA_MCP_VERSION` | `1.1.2` | Pinned server version (recommended). |
| `NAN_MEDIA_MCP_COMMAND` | — | Custom command override. |
| `NAN_MEDIA_MCP_TIMEOUT_MS` | `120000` | Per-call timeout. |
| `NAN_MCP_TOOLS` | — | Override for the official bridge (`0` to disable). |

#### 🤖 Automated Update Detection

A newer `nan-mcp-server` release won't silently drift this bridge's pin. The scheduler (`.github/workflows/check-nan-mcp-server-update.yml`) runs weekly and, when a newer version is found, opens an issue describing if the bump is **breaking** or **safe**.

```bash
bun run check-nan-mcp-server            # human-readable report
bun run check-nan-mcp-server --json     # machine-readable JSON
bun run check-nan-mcp-server --issue    # create/refresh the issue
```

---

## 📊 Quota Usage: `/nan-usage`

Shows your NaN token usage per model merged with the documented monthly caps, the window totals, your all-time totals, and the time until the billing cycle resets.

### How it works

`/nan-usage` calls NaN's [`GET /v1/usage`](https://nan.builders/docs/api#tag/usage) endpoint with the **same API key you already use for chat** — pi's stored credential (`/login nan`) or `NAN_API_KEY`. No CLI login, no session cookie, no extra setup.

The endpoint returns your usage (rows per date and model) plus totals covering the requested window — at most 90 inclusive days. The command reads those totals and merges them with the caps published in the [NaN docs](https://nan.builders/docs/models) to show how much of each monthly cap you have consumed. `/usage` reports consumption only, so the caps themselves always come from the documented table (checked 2026-09-27).

Rate limit: 30 requests per minute for `/usage`, separate from the model endpoints.

### Usage

```
/nan-usage        # current UTC month (matches the monthly caps)
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
📊 NaN Usage

🗓️  Window: 2026-09-01 → 2026-09-27 UTC (27 days)

⏱️  Next billing reset: 2026-09-30 UTC (2d 14h 30m 0s)

Models with monthly caps:

DeepSeek V4 Flash:
  [████████░░░░░░░░░░░░] 40.0% of monthly cap
  Used: 1.2B / 3.0B (1.8B remaining) · 5,120 requests

MiMo V2.5:
  [███░░░░░░░░░░░░░░░░░] 12.5% of monthly cap
  Used: 125.0M / 1.0B (875.0M remaining) · 840 requests

GLM 5.3 👑:
  [████████░░░░░░░░░░░░] 40.0% of monthly cap
  Used: 1.2B / 3.0B (1.8B remaining) · 2,400 requests
  ↳ rolling window: 400.0M / 4h (daily granularity — /usage cannot break it down)

Uncapped models:

Qwen 3.6: 890.5K used · 123 requests

Window totals: 2.6B tokens (2.0B prompt / 640.0M completion) · 18,432 requests
All time: 13.2B tokens · 41,250 requests (cached 2026-02-01)
💡 Source: GET /v1/usage · caps from https://nan.builders/docs/models
```

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
GLM 5.3                      3.0B 👑 (rolling 400.0M/4h)

💡 Set NAN_API_KEY or run `/login nan` to see real usage (GET /v1/usage).
```

Failures stay actionable: `401` → run `/login nan` or fix `NAN_API_KEY`, `404` → the account has no usage identity to report, `429` → retry after the `Retry-After` seconds.

---

## 📊 Models

Baseline catalog (verified against [NaN docs](https://nan.builders/docs/models) and [OpenAPI](https://nan.builders/openapi.json)).

| Model | Context | Max Output | Input | Reasoning |
| :--- | :--- | :--- | :--- | :---: |
| `qwen3.6` | 262,144 | 65,536 | text, image | ✅ |
| `gemma4` | 262,144 | 32,768 | text, image | ✅ |
| `deepseek-v4-flash` | 1,000,000 | 384,000 | text, image | ✅ |
| `mimo-v2.6-flash` | 1,048,576 | 131,072 | text, image | ✅ |
| `glm5.3-flash` | 1,000,000 | 131,072 | text, image | ✅ |
| `qwen3.8-flash` | 262,144 | 131,072 | text, image | ✅ |

> [!NOTE]  
> `mimo-v2.6-flash` is served by NaN and has been listed by models.dev provider `nan` since 2026-09-29. Before that it entered the catalog through a manual-only entry; that entry is kept as a fallback (re-emitted automatically if models.dev drops the model again) and its provenance note stays attached to the generated entry.
>
> `mimo-v2.5` was removed by NaN: it no longer appears in the [NaN docs](https://nan.builders/docs/models) nor in the [OpenAPI model list](https://nan.builders/openapi.json) (checked 2026-09-29), so it is out of the catalog — `mimo-v2.6-flash` replaces it (same 1,048,576 / 131,072 limits, 1.0B monthly quota). Historical `/nan-usage` consumption for `mimo-v2.5` still shows under the undocumented-models section.

---

## 🧠 Reasoning controls

NaN's `reasoning_effort` parameter controls how much the model thinks before answering — but the degree of control varies by model:

| Model | Reasoning effort | How it works |
| :--- | :--- | :--- |
| `glm5.3`, `glm5.3-flash` | `minimal` · `low` · `medium` · `high` · `max` | Fully controllable — higher values let the model reason longer; `minimal` yields ~38 reasoning tokens (issue #16, measured 2026-09-27); `none` does NOT suppress reasoning on glm5.3-flash (13,382 tokens) |
| `qwen3.6`, `gemma4` | `none` · `minimal` · `low` · `medium` · `high` · `max` | `none`/`minimal` skip reasoning entirely; others cap at 2K / 8K / 16K / 32K tokens. `thinking: "off"` sends `reasoning_effort: "none"` automatically via the catalog's `thinkingLevelMap` — the NaN docs state that with no parameter these models reason by default (16,384-token budget), so off must be explicit |
| `deepseek-v4-flash` | `none` · `minimal` · `low` · `medium` · `high` · `max` (catalog declares ["none"]) | `none` reliably disables reasoning (0 reasoning tokens, measured 2026-09-27); every other value leaves 13-14K reasoning tokens and causes runaway reasoning (finish_reason:"length" with ZERO answer text) — the catalog only declares `none` because the rest are useless. `thinking: "off"` now sends `reasoning_effort: "none"` automatically via the catalog's `thinkingLevelMap` |
| `qwen3.8-flash`, `mimo-v2.6-flash` | *(accepted but not adjustable)* | The parameter is accepted and never rejected, but the model manages its own reasoning depth — it is never an error to send a value these models don't adjust |
> [!NOTE]  
> `maxTokens` does NOT bound the reasoning phase on NaN models. The reasoning phase runs to completion (or truncates at ~60,000 chars for deepseek-v4-flash) regardless of `maxTokens` — measured: `max_tokens=512` on deepseek-v4-flash still consumed 13,376 completion tokens, all reasoning (26x the ceiling). This is gateway behavior confirmed by issue #16 (measured 2026-09-27).


---

## 🚀 Development

```bash
bun install
bun run generate-models   # Regenerate fallback catalog
bun test                  # Run all tests
bun run typecheck         # Run typechecking
```

*Releases follow strict semver. CI publishes automatically on merge to `main`.*
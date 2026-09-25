# @gtrabanco/pi-nan-provider

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-0.6.5-blue)](https://github.com/gtrabanco/pi-nan-provider/releases)

[NaN Builders](https://nan.builders) model provider + MCP bridges for [pi](https://github.com/earendil-works/pi). 

Registers the `nan` provider via `pi.registerProvider()` using NaN's OpenAI-compatible API (`https://api.nan.builders/v1`), and bridges NaN's MCP tools into pi with `pi.registerTool()`.

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

## 🔌 MCP Bridges

Since [pi does not include a built-in MCP client](https://github.com/earendil-works/pi/blob/main/docs/usage.md), this package bridges MCP servers as **native pi tools**.

Both bridges are **enabled and lazy by default**. Use `/nan-mcp` to manage them.

### 🛠️ Management Command: `/nan-mcp`

| Command | Effect |
| :--- | :--- |
| `/nan-mcp status` | Shows current state of both bridges. |
| `/nan-mcp enable [target]` | Enables `web-search` or `nan-mcp-server` (persisted). |
| `/nan-mcp disable [target]` | Disables a bridge persistently. |

---

### 1. Official NaN MCP Server
*Official bridge for remote tools via [https://api.nan.builders/mcp](https://nan.builders/docs/api).*

- **`nan_web_search(query, ...)`**: Performs web searches through NaN's gateway.

### 2. Community Media MCP Server
*Bridges [`nan-mcp-server`](https://github.com/luciferfran/nan-mcp-server) via a minimal local stdio client.*

- **Lazy Loading**: The server process is spawned **only** when a tool is invoked and terminated immediately after.
- **Config**: Files land in `~/nan-mcp-output/`.

| Tool | Purpose |
| :--- | :--- |
| `nan_generate_image` | Image generation (flux-2-klein) |
| `nan_edit_image` | Image-to-image editing (flux-2-klein) |
| `nan_text_to_speech` | Audio synthesis (kokoro) |
| `nan_list_voices` | List available voices |
| `nan_speech_to_text` | Audio transcription (whisper) |

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

Shows your NaN token usage per model, monthly limits, and time until the billing cycle resets.

### How it works

`/nan-usage` reads the session token from `~/.config/nan/session.json` — the same file the [NaN CLI](https://github.com/helmcode/nan-cli) uses. If the file exists and contains a valid session, the command fetches real usage data from NaN's dashboard. Otherwise, it shows static quota limits from the docs.

### Setup

1. **Install the NaN CLI**:
   ```bash
   curl -fsSL https://nan.builders/install | sh
   ```
2. **Log in**:
   ```bash
   nan auth login
   ```
   This sends a sign-in link to your email. Paste the link back into the terminal.
3. **Use in pi**:
   ```
   /nan-usage
   ```

> [!TIP]
> The session token is shared automatically — no env vars or extra config needed. If the session expires, run `nan auth login` again.

### What you see

**With a valid session** (real usage):
```
📊 NaN Quota Status

⏱️  Next billing reset: 2026-10-01 UTC (8d 14h 32m 15s)

Models with monthly caps:

DeepSeek V4 Flash:
  [████████░░░░░░░░░░░░] 40.2%
  Used: 1.2B / 3.0B (1.8B remaining)

MiMo V2.5:
  [██░░░░░░░░░░░░░░░░░░] 12.5%
  Used: 125.0M / 1.0B (875.0M remaining)

Uncapped models:

Qwen 3.6: 890.5K used
Gemma 4: 234.1K used
```

**Without a session** (static limits only):
```
📊 NaN Quota Status (static limits)

⏱️  Next billing reset: 2026-10-01 UTC (8d 14h 32m 15s)

Model                        Monthly Cap
─────────────────────────────────────────────────
DeepSeek V4 Flash            3.0B
MiMo V2.5                    1.0B
Qwen 3.6                     uncapped
Gemma 4                      uncapped
Qwen 3.8 Flash               500.0M
GLM 5.3 Flash                2.0B
GLM 5.3 👑                   3.0B (rolling 400.0M/4h)

💡 Run `nan auth login` to see real usage data.
```

---

## 📊 Models

Baseline catalog (verified against [NaN docs](https://nan.builders/docs/models) and [OpenAPI](https://nan.builders/openapi.json)).

| Model | Context | Max Output | Input | Reasoning |
| :--- | :--- | :--- | :--- | :---: |
| `qwen3.6` | 262,144 | 65,536 | text, image | ✅ |
| `gemma4` | 262,144 | 32,768 | text, image | ✅ |
| `deepseek-v4-flash` | 1,000,000 | 384,000 | text, image | ✅ |
| `mimo-v2.5` | 1,048,576 | 131,072 | text, image | ✅ |
| `mimo-v2.6-flash` | 1,048,576 | 131,072 | text, image | ✅ |
| `glm5.3-flash` | 1,000,000 | 131,072 | text, image | ✅ |
| `qwen3.8-flash` | 262,144 | 131,072 | text, image | ✅ |

> [!NOTE]  
> `mimo-v2.6-flash` is served by NaN but not yet listed on models.dev provider `nan`; it enters the catalog through a manual-only entry with the same limits as `mimo-v2.5`. The model will be auto-detected from models.dev once added there.

---

## 🧠 Reasoning controls

NaN's `reasoning_effort` parameter controls how much the model thinks before answering — but the degree of control varies by model:

| Model | Reasoning effort | How it works |
| :--- | :--- | :--- |
| `glm5.3`, `glm5.3-flash` | `low` · `medium` · `high` · `max` | Fully controllable — higher values let the model reason longer |
| `qwen3.6`, `gemma4` | `none` · `minimal` · `low` · `medium` · `high` · `max` | `none`/`minimal` skip reasoning entirely; others cap at 2K / 8K / 16K / 32K tokens |
| `deepseek-v4-flash`, `qwen3.8-flash`, `mimo-v2.5`, `mimo-v2.6-flash` | *(accepted but not adjustable)* | The parameter is accepted and never rejected, but the model manages its own reasoning depth — it is never an error to send a value these models don't adjust |

---

## 🚀 Development

```bash
bun install
bun run generate-models   # Regenerate fallback catalog
bun test                  # Run all tests
bun run typecheck         # Run typechecking
```

*Releases follow strict semver. CI publishes automatically on merge to `main`.*
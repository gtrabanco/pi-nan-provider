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

**Streaming token usage:** `supportsUsageInStreaming` is `false` by default because NaN's published schema does not document `stream_options`; without it usage reads as zero. If you have confirmed that your model returns a streaming usage chunk, opt in per model — the request sanitizer then forwards `stream_options: { "include_usage": true }` and pi reports real token counts instead of zeros:

```json
{
  "providers": {
    "nan": {
      "modelOverrides": {
        "qwen3.6": { "compat": { "supportsUsageInStreaming": true } }
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
| `NAN_MEDIA_MCP_VERSION` | `1.0.8` | Pinned server version (recommended). |
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

## 📊 Models

Baseline catalog (verified against [NaN docs](https://nan.builders/docs/models) and [OpenAPI](https://nan.builders/openapi.json)).

| Model | Context | Max Output | Input | Reasoning |
| :--- | :--- | :--- | :--- | :---: |
| `qwen3.6` | 262,144 | 65,536 | text, image | ✅ |
| `gemma4` | 262,144 | 32,768 | text, image | ✅ |
| `deepseek-v4-flash` | 1,000,000 | 384,000 | text, image | ✅ |
| `mimo-v2.5` | 1,048,576 | 131,072 | text, image | ✅ |
| `glm5.3-flash` | 1,000,000 | 131,072 | text, image | ✅ |
| `qwen3.8-flash` | 262,144 | 131,072 | text, image | ✅ |

---

## 🚀 Development

```bash
bun install
bun run generate-models   # Regenerate fallback catalog
bun test                  # Run all tests
bun run typecheck         # Run typechecking
```

*Releases follow strict semver. CI publishes automatically on merge to `main`.*
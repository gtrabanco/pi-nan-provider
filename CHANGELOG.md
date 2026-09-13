# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.7] — 2026-09-13

### Fixed

- **A model that declares streaming usage now reports real token counts instead of an all-zero `message.usage` ([#4](https://github.com/gtrabanco/pi-nan-provider/issues/4)).**
  The strict-schema sanitizer removed `stream_options` from every outgoing `/chat/completions` payload unconditionally. pi-ai only emits
  `stream_options: { include_usage: true }` when the model's effective `compat.supportsUsageInStreaming` is not `false`, and an OpenAI-compatible
  gateway only returns the terminal usage chunk when asked for it — so a user who truthfully overrode the flag through `models.json` still got zeros:
  the sanitizer silently undid the override. Rule 4 is now gated on the model's effective compat: when `supportsUsageInStreaming` is `true` the
  sanitizer forwards `stream_options` untouched, and pi's session accounting, context tracking and downstream tooling see real input/output/cache
  counts. Every other model keeps the exact strict payload as before (`stream_options` and `store` removed; `store` is never preserved). The
  generated catalog default stays `false` — NaN's published schema does not document `stream_options`, so opting in remains an explicit,
  per-model user decision rather than a guessed capability.

### Added

- `test/issue-4-token-usage.test.ts` — end-to-end acceptance tests through the real pi-ai adapter and a mock NaN gateway that only emits the usage
  chunk when the request carried `stream_options.include_usage` (like the real endpoint): an opted-in catalog model and a glm5.3 `models.json`-style
  override must both receive `stream_options` and surface non-zero usage; without the opt-in the conservative strict payload is unchanged.

## [0.6.6] — 2026-09-13

### Fixed

- **A NaN model switch that still overflows no longer wedges the session on the opaque `400 Invalid request. Check your request parameters.` ([#3](https://github.com/gtrabanco/pi-nan-provider/issues/3)).**
  The `0.6.3`/`0.6.4` cross-model thinking guard drops the reasoning pi-ai replays across a model switch, so the request usually fits. When a request
  still exceeds the destination model's context window — the guard is disabled with `NAN_THINKING_GUARD=0`, the inflation is not a `thinking` block
  (large tool outputs, images), or the window is smaller — NaN's LiteLLM gateway answers the generic 400 instead of naming the overflow. pi's
  auto-compaction keys on pi-ai's `isContextOverflow()`, whose documented patterns do not match that generic text, so the session stuck at the
  ceiling (upstream `earendil-works/pi#9409`, listed by the issue).

  New `src/context-overflow-classifier.ts` makes the package **re-check the request size on the way out**: when the terminal error carries NaN's
  generic-400 marker and the request we sent was estimated to exceed the model's context window, the error message is rewritten into a form that
  matches pi-ai's overflow patterns (original provider text preserved), so pi compacts and retries instead of stalling. Reclassification is
  conservative — a generic 400 on a within-window request is left untouched, so unrelated errors are never mislabelled. Estimation uses the same
  chars/3.47 ratio as the issue's offline measurements (system prompt and tool schemas counted explicitly). Wired into the shared provider factory
  after the strict-schema sanitizer, so it applies to every NaN-compatible provider.

### Added

- `test/issue-3-model-switch-overflow.test.ts` — end-to-end acceptance tests through the real pi-ai adapter and a mock NaN gateway: with
  `NAN_THINKING_GUARD=0` an over-window replay's generic 400 must be classifiable as a context overflow; with the guard enabled the same session
  must fit and succeed; a generic 400 on a within-window request must stay a generic error.
- `test/context-overflow-classifier.test.ts` — unit coverage for the estimator, the generic-400 matcher, and the conservative reclassification.

## [0.6.5] — 2026-09-13

### Fixed

- **Intermittent "Stream ended without finish_reason" no longer stalls a turn silently ([#2](https://github.com/gtrabanco/pi-nan-provider/issues/2)).**
  The generated catalog declared `supportsFinishReason: false`, so when NaN's LiteLLM gateway closed an SSE stream before the final
  `finish_reason` chunk, pi-ai synthesized `stop`/`toolUse` and the turn ended mid-answer with no error and no retry (observed on
  `glm5.3-flash`: 2 of 42 turns truncated in one real session). The catalog now declares `supportsFinishReason: true`: pi-ai raises
  `Stream ended without finish_reason`, which matches its retryable-provider pattern (`"ended without"`), so the turn is retried
  automatically. A model whose gateway never emits `finish_reason` now fails **loudly** after the retry budget instead of stalling
  silently. Regression tests (`test/issue-2-truncated-stream.test.ts`) drive the real pi-ai `openai-completions` adapter with a
  truncated SSE stream and assert `stopReason: "error"` plus a retryable classification.
- **The streaming-usage declaration no longer contradicts the request sanitizer.** `supportsUsageInStreaming` is now `false`,
  matching the fact that `src/openai-compat-sanitizer.ts` strips `stream_options` (NaN's strict schema does not document it).
  Previously the flag was `true`, so pi-ai requested usage it never received; usage stays zero, but the declaration is now honest.
- **`glm5.3` is now documented by models.dev** (1M context / 131,072 max output, checked 2026-09-13). It stays deliberately
  **live-only** (premium tier): a new `LIVE_ONLY_MODEL_IDS` generator guard keeps it out of the static fallback so a non-premium key
  never sees a model it cannot call when the live `/models` fetch is unavailable; premium keys still receive it live with the
  conservative placeholder limits. Catalog exclusion notes are now recorded unconditionally, so a regeneration cannot drop the
  reason a model is absent.
- `deepseek-v4-flash` provenance note updated: models.dev now lists the DeepSeek V4.1 Flash entry with image input too; the override
  is kept as a pin, not presented as a divergence.

### Added

- `test/issue-2-truncated-stream.test.ts` — end-to-end acceptance tests through the real pi-ai adapter: a truncated stream must
  produce `stopReason: "error"` and be classified retryable, never a silent `stop`.

## [0.6.4] — 2026-09-11

### Fixed

- **Switching to `qwen3.6` (262K context) still returned the generic HTTP 400 after 0.6.3.** The 0.6.3 guard capped
  each replayed cross-model `thinking` block at 16,000 chars, but nothing bounded the **sum** across messages —
  measured on real sessions, replayed reasoning is **30–60% of the whole context** (e.g. 356,723 of 903,464 chars in
  one session; 349,882 of 749,525 in another). A session above qwen3.6's 262K window therefore still overflowed.

  `src/cross-model-thinking-guard.ts` now **drops every replayed cross-model `thinking` block outright** instead of
  capping it. Only the reasoning trace is removed — each model's answers and tool results stay intact, so `qwen3.6`
  can still answer questions about research done by `glm5.3-flash`/`deepseek-v4-flash`. Same-model replay is never
  altered (signatures and continuity depend on it), non-NaN targets and non-assistant messages are untouched, and the
  input is never mutated. `NAN_THINKING_GUARD=0` disables it.

  Offline simulation over the maintainer's real sessions (chars/3.47 + ~31K tools + ~12K system, no live tokens): one
  session went 334K → 223K tokens and another 268K → 167K (it was **over** the 262K window); every sampled session
  fits after the drop. Tests cover the drop, sibling/tool-call preservation, multiple blocks,
  same-model/undefined/foreign-provider no-ops, the measured size reduction, the env opt-out, and the extension
  wiring.

## [0.6.3] — 2026-09-10

### Fixed

- **HTTP 400 `Invalid request. Check your request parameters.` on NaN model switch caused by an unbounded replayed
  reasoning trace.** pi-ai's `transformMessages` downgrades a previous model's `thinking` blocks to plain assistant
  text **with no size bound** when history is replayed into a different model
  (`packages/ai/src/api/transform-messages.ts`, still true on pi 0.85.1 and `main`). A long or degenerate reasoning
  trace — observed in the wild: `glm5.3-flash` ending with `stopReason: "length"` after emitting a 445,888-char /
  131,072-token thinking block — is therefore replayed as a 445 KB assistant `content` string. On a 262K-context NaN
  model (`qwen3.6`) that pushes the request past its window, and NaN's gateway answers a generic 400 instead of an
  error that names the context overflow. Live-verified 2026-09-10: the exact outgoing payload returns 200 on
  `deepseek-v4-flash` and `glm5.3-flash` (both 1M-context), and 200 on `qwen3.6` once only that replayed message is
  removed.

  `src/cross-model-thinking-guard.ts` now runs on pi's `context` hook (registered from `src/index.ts`), which fires
  **before** pi-ai converts the blocks, and caps each replayed cross-model `thinking` block at
  `MAX_CROSS_MODEL_THINKING_CHARS` (16,000 chars, ~4K tokens) with a visible truncation marker. Same-model replay is
  never altered (signatures and continuity depend on it), non-NaN targets and non-assistant messages are untouched,
  and the input is never mutated. `NAN_THINKING_GUARD=0` disables it. Tests cover the cap, the marker,
  signature/sibling preservation, same-model/undefined/foreign-provider no-ops, multiple blocks, the env opt-out, and
  the extension wiring.

  This is a bounded mitigation, not the root fix: the unbounded conversion belongs upstream. Tracking issue:
  https://github.com/gtrabanco/pi-nan-provider/issues/3 (see also https://github.com/earendil-works/pi/issues/6167).

## [0.6.2] — 2026-09-09

### Fixed

- **HTTP 400 `Invalid request. Check your request parameters.` on NaN session replay / model switch.**
  NaN's gateway validates every `/chat/completions` payload against a strict OpenAI Chat Completions
  schema (https://nan.builders/openapi.json) that is narrower than what pi-ai emits by default. On a
  replayed history (or _any_ request) the payload could carry shapes NaN rejects: an `assistant`
  `content` array containing a `toolCall` block (NaN allows only `text` / `image_url` parts, and expects
  tool calls in a separate `tool_calls` field), an OpenAI-only `reasoning_details` field on assistant
  messages, an unknown content-part type (e.g. `thinking`), and undocumented top-level fields
  (`store`, `stream_options`, `max_completion_tokens`).

  A provider-side request sanitizer (**`src/openai-compat-sanitizer.ts`**) now runs on every outgoing
  payload via the `onPayload` hook in `src/provider-factory.ts`, so every provider registered through
  the shared factory is schema-valid regardless of which pi-ai version the runtime bundles:

  - assistant `toolCall` blocks are always moved into the standard `tool_calls` field
    (`{ id, type: "function", function: { name, arguments: "<json>" } }`) and never left in `content`;
  - `reasoning_details` is stripped and generic `reasoning` content is carried into `reasoning_content`
    (the field NaN understands);
  - `thinking` content parts are folded into `text`; unknown content parts are dropped; `image_url`
    parts are preserved;
  - `store` / `stream_options` are removed and `max_completion_tokens` is mapped to `max_tokens`;
  - an **empty `tools` array is dropped** — NaN rejects `tools: []` with the same 400 (live-verified),
    while `stream: true`, a `system` message, string content, and a `tool` role message are accepted;
    a non-empty `tools` list is preserved;
  - a caller-supplied `onPayload` is preserved and chained after sanitization.

  Regression tests cover the happy path and the edge cases (single-`toolCall` assistant message,
  dedupe against existing `tool_calls`, `reasoning_details`, `thinking`, unknown parts, `image_url`,
  string/object arguments, missing tool-call id, `store`/`stream_options` / empty-`tools` removal,
  `max_completion_tokens` mapping, same-model reasoning replay, and the `onPayload` chain).

## [0.6.1] — 2026-09-09

### Fixed

- Initial mitigation for the intermittent "Stream ended without finish_reason" gateway truncation: the generated catalog set
  `supportsFinishReason: false`. **Superseded by 0.6.5** — that flag hid the truncation instead of recovering it; see
  [#2](https://github.com/gtrabanco/pi-nan-provider/issues/2).

## [0.6.0] — 2026-09-09

### Added

- **Automated nan-mcp-server update detection**. New `scripts/check-nan-mcp-server.ts`
  (wired as `bun run check-nan-mcp-server`) compares the npm registry against the pinned
  `DEFAULT_NAN_MEDIA_MCP_VERSION`, inspects the *live* server tool surface via unpkg, and reports
  whether a bump is **non-breaking** or **breaking** for the bridged tools, plus the upstream commit
  list. A new scheduled workflow (`.github/workflows/check-nan-mcp-server-update.yml`, weekly +
  manual) opens/refreshes a single `dependencies`-labelled update issue when a newer release exists.
  Read-only against the repo; never auto-bumps.
- Bridged-tool constants (`NAN_MEDIA_MCP_SERVER_TOOLS`) typed as the single source of truth for both
  the media tool specs and the check script, so the bridge cannot drift from the surface it claims.
- Tests for the check script (`test/check-nan-mcp-server.test.ts`): version compare, tool-surface
  extraction, breaking/safe verdict, report builder, and injected-fetch network fetchers.

### Changed

- **Pinned nan-mcp-server to `1.0.8`** (verified non-breaking: the server tool surface is unchanged;
  upstream only tightened `edit_image` validation, added docs/tests).
- `nan_edit_image` schema now enforces `minItems: 1` / `maxItems: 4` on `images`, matching the
  upstream 1.0.8 zod schema (previously the annotation said "up to 4" without enforcing it).
- Schema-mirroring comments updated from v1.0.7 to v1.0.8.

## [0.5.2] — 2026-09-07

### Changed

- **Catalog re-verified against NaN docs** (https://nan.builders/docs/models + openapi.json, 2026-09-07): `qwen3.8-flash` contextWindow reverted from 1M back to 262,144 (docs still say "262K token context, the model's native window"; models.dev agrees). Withdrawal recorded with full provenance note.
- `deepseek-v4-flash` override note strengthened — now cites both [NaN docs](https://nan.builders/docs/models) and the vision content-parts in [openapi.json](https://nan.builders/openapi.json).
- README tables updated: removed stale `glm5.2` row, corrected `qwen3.8-flash` to 262K, documented premium `glm5.3` placeholder behavior (EN + ES).

### Added

- **Provider-removed model guard**: `PROVIDER_REMOVED_MODEL_IDS` in the generator prevents regeneration from resurrecting models NaN removed (e.g. `glm5.2` — still listed by models.dev but absent from the official API model list).
- Premium `glm5.3` flagged as **unemittable** in catalog metadata — absent from models.dev and no source documents its max output tokens (no-fabrication rule). Premium keys still get it live via the `/models` refresh with conservative placeholders (128K context / 4K output).

### Fixed

- Catalog now matches the [official chat model list](https://nan.builders/openapi.json) (`model` parameter description): deepseek-v4-flash, mimo-v2.5, qwen3.8-flash, glm5.3-flash, qwen3.6, gemma4 (community) + glm5.3 (premium, unemittable).
- Test contract: catalog set, exclusion guards, and note provenance pinned to verified facts.

## [0.5.1] — 2026-09-05

### Changed

- Removed `glm5.2` from catalog (provider-removed).

## [0.5.0] — 2026-09-05

### Added

- Manual capability overrides via `MANUAL_OVERRIDES` with mandatory provenance notes (`scripts/manual-overrides.ts`).
- Support for pi >= 0.83 (forks using 0.83).
- New test: `extension-load.test.ts` — regression guard for the pi-ai aliasing failure.

### Fixed

- **Extension load failure under pi's pi-ai aliasing**: bare-root `@earendil-works/pi-ai` import + dynamic `resolveOpenAICompletionsApi` — works in bundled CLI, Node-mode jiti aliases, and compiled-binary virtualModules.

## [0.4.0] — 2026-09-04

- Initial public release of the nan provider package for pi.

[Unreleased]: https://github.com/gtrabanco/pi-nan-provider/compare/v0.6.5...HEAD
[0.6.5]: https://github.com/gtrabanco/pi-nan-provider/compare/v0.6.4...v0.6.5
[0.6.4]: https://github.com/gtrabanco/pi-nan-provider/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/gtrabanco/pi-nan-provider/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/gtrabanco/pi-nan-provider/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/gtrabanco/pi-nan-provider/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/gtrabanco/pi-nan-provider/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/gtrabanco/pi-nan-provider/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/gtrabanco/pi-nan-provider/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/gtrabanco/pi-nan-provider/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/gtrabanco/pi-nan-provider/releases/tag/v0.4.0
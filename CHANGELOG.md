# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[Unreleased]: https://github.com/gtrabanco/pi-nan-provider/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/gtrabanco/pi-nan-provider/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/gtrabanco/pi-nan-provider/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/gtrabanco/pi-nan-provider/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/gtrabanco/pi-nan-provider/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/gtrabanco/pi-nan-provider/releases/tag/v0.4.0
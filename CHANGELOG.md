# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.0] - 2026-10-01

### Added
- **Native NaN image models for pi 1.0** (flux-2-klein, qwen-image-2.1). Registered as pi image models (type "image", api "nan-images"), reachable from codemode with models.generateImages() and from extensions with ctx.modelRegistry.generateImages(). flux-2-klein supports text-to-image and image-to-image (POST /v1/images/edits, up to 4 references); qwen-image-2.1 supports text-to-image. Both require the inference tier, are rate-limited separately from chat (20 req/min, 100 req/month shared) and do not consume the chat token budget. Requests ask for b64_json; the MIME type is sniffed from the decoded bytes because NaN returns no MIME type. Sources: https://nan.builders/docs/models and https://nan.builders/openapi.json (checked 2026-10-01).
- MCP server description for nan-search and nan-media (shown in pi's system prompt and used to rank MCP tools in tool search).

### Changed
- **pi 1.0.0 support**: peer range widened from "`>=0.99.0 <1`" to
  "`>=0.99.0 <2`"; devDependencies moved to pi/pi-ai 1.0.0. The package code is
  unchanged for this — pi-ai 1.0.0's public type surface is identical to 0.99.1.
- **MCP tool ids documented for pi >=0.99.2**: pi now sanitizes every character
  except `[A-Za-z0-9_]`, so the tools are `mcp__nan_search__web_search` and
  `mcp__nan_media__*` (hyphens on pi 0.99.0-0.99.1).

### Documentation
- Media bridge tool list updated to `nan-mcp-server@1.1.2`'s real surface
  (8 tools: the 5 previously documented plus `list_models`, `embed_text`,
  `rerank_documents`). `AGENTS.md` and both READMEs now match the pinned server;
  no code change. Also records the issue #17 triage verdict
  (`docs/fix/issue-17-gateway-cache/decisions.md`): payload provably clean, NaN
  gateway response cache identified as the anomaly.

## [0.10.3] — 2026-10-01

### Fixed

- **Non-chat live `/models` ids are no longer registered as chat models**
  (issue #15). NaN's `GET /v1/models` endpoint returns ids for
  embedding/rerank/TTS/STT/image endpoints (`qwen3-embedding`, `rerank`,
  `kokoro`, `whisper`, `flux-2-klein`, `qwen-image-2.1`) alongside chat
  models, so the live `/models` merge was registering them as chat models —
  pi's chat picker offered them and requests failed with 404.
  - `src/fetch-models.ts` now exports `NON_CHAT_MODEL_IDS` (single source of
    truth: id → provenance reason) imported by `scripts/generate-models.ts` —
    one definition, no duplicate. The generator already excluded
    `qwen-image-2.1`; all six ids are now in the same guard.
  - `mergeLiveWithGenerated` skips the placeholder for those ids and reports
    them in a new `MergedCatalog.nonChat: string[]` bucket; they never enter
    the provider registry. `resolveCatalog` exposes
    `ResolvedCatalog.nonChatIds: string[]` (`[]` on the fallback path).
  - `baselineModels` filters them defensively as an extra safety layer.
  - Uncatalogued CHAT ids (not in the list above) keep getting the
    conservative placeholder — that behavior is unchanged.

## [0.10.2] — 2026-10-01

### Fixed

- **Cross-model thinking guard no longer misfires on pi 0.99 virtual models.**
  In the `context` hook `ctx.model` is the virtual selection (`api:
  "pi-virtual"`), not the physical model the router picks for that request, so
  the guard's same-model check never matched and it stripped every replayed
  thinking block — including same-physical-model reasoning on a continuation,
  losing the prompt cache and thinking continuity. Virtual selections are now
  exempt (the routed physical target is not exposed to the hook). Regression
  tests: `test/cross-model-thinking-guard.test.ts`.

- **MCP bridges now resolve the stored `/login nan` credential** (issue #14).
  The factory-time `ExtensionAPI` has no `modelRegistry` (verified pi 0.99.1),
  so stored credentials are now resolved at extension load time via
  `readStoredCredential("nan")` from `@earendil-works/pi-coding-agent`, with env
  fallback. Precedence: stored credential → env var.
  - Web-search: no longer silently skips registration — a `console.warn` now
    clarifies the missing key (mentions `/login nan` and `NAN_API_KEY`).
  - Media: no longer spawns the child process with an empty API key (which
    caused `"MCP connection closed"`). Refuses to register without a key and warns.
  - `/nan-mcp enable` now uses the real command-context `ctx.modelRegistry`
    (was using `pi.modelRegistry` which is undefined on `ExtensionAPI`) and only
    claims "Native servers registered" when they actually are (fixes false
    success message when no key resolves).
  - `/nan-mcp status` no longer prints `API key: [object Promise].` (missing
    `await` on the async key status call).
  Regression tests: `test/mcp-search.test.ts`, `test/mcp-media.test.ts`,
  `test/nan-mcp-command.test.ts`.

- **Reasoning model `finish_reason: "length"` wedge when `thinking: "off"`**
  (issue #16). pi-ai maps `reasoning: "off"` to `reasoningEffort: undefined`;
  the NaN catalog had no `thinkingLevelMap` entries, so no `reasoning_effort`
  was sent, and NaN did NOT disable reasoning — runaway reasoning (13–14K
  tokens), `finish_reason: "length"` with zero answer text, empty assistant
  message, wedged session.
  - Added `thinkingLevelMap` to the generated catalog: deepseek-v4-flash
    (`off → "none"`, 0 reasoning tokens), glm5.3-flash (`off → "minimal"`,
    38 reasoning tokens; measured 2026-09-27, repro included in the issue),
    **qwen3.6** and **gemma4** (`off → "none"`). The last two close a gap left
    by the measured-only fix: the NaN docs state that with no parameter both
    models reason by default (16,384-token budget) and that `none`/`minimal`
    skip the reasoning phase entirely
    (https://nan.builders/docs/models#controlling-reasoning, checked
    2026-10-01), so `thinking: "off"` must send `reasoning_effort: "none"`
    explicitly. The prior regression test that asserted qwen3.6 sends nothing
    was codifying that gap and has been corrected (qwen3.8-flash, whose depth
    is genuinely not adjustable, now covers the no-map case).
  - Added `thinkingLevelMap` field to `GeneratedModelEntry` and propagated it
    through `toModel()`, the generator, and the legacy fallback path in
    `src/index.ts`.
  - Corrected `reasoningEffortValues`: deepseek-v4-flash from `[]` to
    `["none"]` (only "none" has deterministic effect), glm5.3-flash from
    `["low","medium","high","max"]` to include `"minimal"` (accepted by the
    gateway, effective but not documented).
  - Updated README limits table with a note that `maxTokens` does NOT bound
    the reasoning phase (measured: max_tokens=512 still yielded 13,376
    reasoning tokens).
  Regression tests: `test/issue-16-thinking-level-map.test.ts` (end-to-end
  payload test through the real provider and mock gateway); updated
  `test/generated-catalog.test.ts` (thinkingLevelMap contract + glm5.3-flash
  override now has a non-contextWindow field).

## [0.10.1] — 2026-09-30

### Fixed

- **No more `MCP server "nan-media" is registered, but no loaded extension connects MCP servers`.**
  Hosts that build pi's resource loader without `extensionFactories` (PI WEB
  sessions) load no built-in extension at all, so `builtin:mcp` never connects
  the registered servers and pi reports them as an extension error right after
  `session_start`. `src/mcp/host-support.ts` now detects the missing connector
  through the `/mcp` command (`pi.getCommands()` unavailable → conservative
  "present"), claims `mcp_servers_change` so pi's report stays silent, and warns
  once per session with the fix (`pi config` → Built-in extensions → `mcp`).
  `/nan-mcp status` states the missing connector; `/nan-mcp enable` persists the
  toggle without registering a server that can never connect. Registrations in a
  healthy `pi` CLI session are untouched. Regression tests:
  `test/mcp-host-connector.test.ts`.

## [0.10.0] — 2026-09-29

### Breaking

- **peerDependencies require `pi >= 0.99.0`**: bumped from `>=0.83.0 <1` to
  `>=0.99.0 <1` for both `@earendil-works/pi-ai` and
  `@earendil-works/pi-coding-agent`. Older pi versions should stay on package
  0.9.x; no registerTool bridge fallback for pi <0.99.
- **Tool names changed from `nan_*` to `mcp__<server>__<tool>`**:
  `nan_web_search` → `mcp__nan-search__web_search`;
  `nan_generate_image` / `nan_edit_image` / `nan_text_to_speech` /
  `nan_list_voices` / `nan_speech_to_text` → `mcp__nan-media__*`.
  MCP now uses native `pi.registerMcpServer()` (session-scoped, visible in
  `/mcp` with source "extension").
- **MCP bridges registered natively via `pi.registerMcpServer()`**: servers are
  session-scoped, appear in `/mcp` with source "extension", and `mcp.json`
  entries with the same name take precedence. `exposure: "direct"` on both
  servers — tools are declared to the model like built-ins.
- **`/nan-mcp` now registers/unregisters live**: `enable` calls
  `pi.registerMcpServer()` (immediate); `disable` calls
  `pi.unregisterMcpServer()` (immediate — tools hidden right away).
- **Missing API key at registration**: if `NAN_API_KEY` is not set at
  extension load, the web-search server is NOT registered (previously it
  registered and errored at call time). Guidance is written to the console.
- **Media server now connects eagerly** (at registration time), not spawned per
  call. The stdio client (`src/mcp/stdio-client.ts`) is deleted; the media MCP
  server is registered natively with `exposure: "direct"`, command, args, and
  timeout (seconds) in the server config. Timeout: 120 seconds (converted from
  120,000 ms); per-request progress notifications reset the timeout.

### Changed

- **Upgraded `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` from 0.87.1 to 0.99.1.**
  Zero source-code changes required — all 0.99.x diffs are backward-compatible
  at the import boundary: `ProviderModel<TApi>` union type is assignable where
  `Model<TApi>[]` was used; `ExtensionToolContext` supersedes `ExtensionContext`;
  the factory `await factory(api)` pattern persists. Gate green: 207 tests,
  687 expects, typecheck clean.
- **Native MCP migration** (see Breaking above): deleted `src/mcp/stdio-client.ts`,
  `src/mcp/nan-search.ts`, `src/mcp/nan-media.ts`; extracted gate resolution,
  API key resolution, media command/version/timeout helpers into new modules
  (`src/mcp/api-key.ts`, `src/mcp/media-server.ts`). Rewired `/nan-mcp` command
  to call `pi.registerMcpServer()` / `pi.unregisterMcpServer()` directly.
  All tests retargeted to the new contract.

- **Test rewrites**: `test/mcp-search.test.ts` and `test/mcp-media.test.ts`
  replaced ToolDefinition-wrapper tests with native MCP registration config
  tests. `test/compat.test.ts` updated to verify registerMcpServer calls
  instead of registerTool. `test/nan-mcp-command.test.ts` rewritten for
  native register/unregister.
  Justifications recorded in `docs/fix/native-mcp-migration/decisions.md`.

## [0.9.0] — 2026-09-29

### Changed

- **The catalog now takes *which models exist* from
  [https://nan.builders/docs/models](https://nan.builders/docs/models)**
  (maintainer instruction, reaffirmed 2026-09-29); models.dev keeps supplying
  the numeric limits for the ids it documents. The publish workflow failed on
  `bun run generate-models` because models.dev had dropped `mimo-v2.5`, and the
  docs and the OpenAPI `model` list no longer mention it either (zero mentions
  in both, checked 2026-09-29) — `mimo-v2.6-flash` supersedes it.
  - The required-model guard now checks the docs' community chat set
    (`qwen3.6`, `gemma4`, `deepseek-v4-flash`, `mimo-v2.6-flash`) against what
    actually reaches the catalog — from models.dev **or** from a manual-only
    entry — and its failure message no longer calls models.dev the authority.
  - **`mimo-v2.6-flash` is now listed by models.dev** (2026-09-29): the
    generator stops emitting a second manual-only entry for it, keeps the
    models.dev values and attaches the manual provenance note to that entry, so
    the id can never land in the catalog twice. The manual-only entry remains
    as the fallback for the next time models.dev drops a model.
  - `qwen-image-2.1` (new on models.dev) is excluded as a non-chat model
    (`NON_CHAT_MODEL_IDS`) instead of being flagged `needs manual
    verification` on every regeneration.
  - `/nan-usage` drops the `mimo-v2.5` quota row: its only source was the docs,
    and the docs no longer document the model. Historical consumption for
    `mimo-v2.5` still appears under the "models missing from the documented
    table" section.

### Removed

- **Breaking: `mimo-v2.5` leaves the static fallback catalog.** Removed by NaN
  (absent from the docs and the OpenAPI model list, checked 2026-09-29;
  superseded by `mimo-v2.6-flash`, same 1,048,576 context / 131,072 max output).
  It is recorded in `PROVIDER_REMOVED_MODEL_IDS` with its provenance, so a
  regeneration can never resurrect it, and `test/generated-catalog.test.ts`
  pins the exclusion the same way `glm5.2` is pinned. Sessions whose
  `models.json` names `mimo-v2.5` resolve it through the live `/models`
  refresh if the gateway still serves it (with placeholder limits), otherwise
  as an unknown id — use `mimo-v2.6-flash`.

## [0.8.1] — 2026-09-29

### Changed

- **devDependencies `@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` 0.84.4 → 0.87.1** ([#13](https://github.com/gtrabanco/pi-nan-provider/issues/13)).
  The `peerDependencies >=0.83.0 <1` constraint is untouched and `node scripts/check-pi-sdk-versions.mjs --report` exits 0.
  The pi-ai 0.86 breaking change (provider stream entry points `Provider.stream`, `ProviderStreams.stream/streamSimple`,
  `StreamFunction` now take a branded `TranscriptContext = { messages: Message[] }` instead of the public
  `Context = { systemPrompt?: string; messages; tools? }`; `normalizeContext(context)` produces it)
  required every test's context-literal sites to switch to `normalizeContext()` (6 test call sites). No
  `src/` file needed a behavioral change: `wrapApiForStrictSanitization` only rewrites `options.onPayload`
  and forwards `context` untouched, and `withContextOverflowClassification` forwards `context` untouched
  and only *reads* it for the estimate — `estimateRequestTokens` still counts prompt + tools under
  `TranscriptContext` because they ride inside `messages[0]` (`toolsAdded`), so the JSON of `messages`
  carries them. Runtime behavior of the extension is unchanged.

## [0.8.0] — 2026-09-27

### Changed

- **`/nan-usage` now reads NaN's `GET /v1/usage` endpoint**
  ([API reference · Usage](https://nan.builders/docs/api#tag/usage), OpenAPI spec
  checked 2026-09-27) instead of the dashboard endpoint that required a NaN CLI
  session cookie. The endpoint is authenticated with the same personal API key
  used for chat — pi's stored credential (`/login nan`) or `NAN_API_KEY` — so the
  command no longer depends on the CLI at all.

  The endpoint reports consumption, never caps: `src/usage.ts` requests the
  window's `totals` (`limit=1` — the daily rows are never needed, `totals` always
  spans the whole window) and merges them with the documented `MODEL_QUOTAS`
  (https://nan.builders/docs/models). Output now includes the effective window,
  per-model usage vs. monthly cap, request counts, window totals, all-time totals,
  and models missing from the documented table. The default window is the current
  UTC month (aligned with the monthly caps and the billing reset);
  `/nan-usage <days>` (1–90, the endpoint's maximum) selects a rolling window and
  `/nan-usage help` prints the usage line.

  Failures are mapped from the documented statuses: `401` → run `/login nan` or
  fix `NAN_API_KEY`, `404` → the account has no usage identity, `429` → retry
  after `Retry-After` (30 requests/min, a budget separate from the model
  endpoints), `409` → service-key alias, `400`/`5xx` → endpoint detail. Without
  an API key the command still prints the static quota table, now pointing at
  `/login nan` / `NAN_API_KEY`.

- **(breaking) The NaN CLI login flow is gone from `/nan-usage`.** The command
  never reads `~/.config/nan/session.json` or `cloud-api.nan.builders` anymore:
  users who only ever ran `nan auth login` must authenticate pi instead
  (`/login nan` or `NAN_API_KEY`). `test/nan-usage-command.test.ts` guards this
  by scanning the module for any runtime reference to the CLI session.

### Added

- Optional `/nan-usage [days]` argument (1–90 rolling window) with argument
  completion, plus injectable `fetchImpl` / `resolveApiKey` seams for tests
  (`NanUsageCommandOptions`).

## [0.7.0] — 2026-09-25

### Added

- **`mimo-v2.6-flash` catalog entry (manual-only — not yet on models.dev).**
  NaN serves this omnimodal model (text, image, audio input) but models.dev
  provider `nan` does not list it yet. It enters the catalog with the same
  limits as `mimo-v2.5`: 1,048,576 context / 131,072 max output / 1.0B monthly
  quota. A `reasoning_effort_values: []` note records that the parameter is
  accepted but depth is model-managed (https://nan.builders/docs/models,
  checked 2026-09-25). When models.dev adds it, the generator will emit its
  data natively and the manual override will no longer be needed.

- **`reasoning_effort_values` on every generated model entry.**
  Each model now carries the effort levels that the NaN docs declare as
  available (https://nan.builders/docs/models #controlling-reasoning).
  The values flow through to the pi model-selector so the UI can offer the
  correct granularity per model.

  | Model | Reasoning effort values |
  | :--- | :--- |
  | `glm5.3`, `glm5.3-flash` | `low` · `medium` · `high` · `max` (fully controllable) |
  | `qwen3.6`, `gemma4` | `none` · `minimal` · `low` · `medium` · `high` · `max` |
  | `deepseek-v4-flash`, `qwen3.8-flash`, `mimo-v2.5`, `mimo-v2.6-flash` | *empty* (accepted but model-managed) |

- **`/nan-usage` now shows `mimo-v2.6-flash` quota (1.0B/month).**

### Changed

- Added `reasoningEffortValues` field to `GeneratedModelEntry` and the
  generated catalog. Sources: NaN docs (https://nan.builders/docs/models
  #controlling-reasoning, checked 2026-09-25) — models.dev does not expose
  this field.

## [0.6.11] — 2026-09-22

### Fixed

- **Extension failed to load on the pi CLI since 0.6.10: `ResolveMessage: NameTooLong while resolving package 'data:text/javascript;base64,...' from '/$bunfs/root/pi'` ([#10](https://github.com/gtrabanco/pi-nan-provider/issues/10)).**
  `src/pi-ai-loader.ts` aliased `import.meta` to a local variable before reading `.resolve`. pi's jiti loader rewrites `import.meta.url` and
  `import.meta.resolve` but leaves a bare `import.meta` in its CommonJS wrapper, which is a `SyntaxError` there; jiti then falls back to importing
  the wrapper as a `data:` URL, which the compiled Bun binary cannot resolve. The loader now references `import.meta.resolve` directly.
  `test/extension-load.test.ts` forbids bare `import.meta` expressions in `src/`.

- **pi-web crash on model open/switch: `undefined is not an object (evaluating 'block.name.length')` ([#8](https://github.com/gtrabanco/pi-nan-provider/issues/8)).**
  v0.6.10 anchored on `import.meta.resolve("@earendil-works/pi-ai")` alone, which resolved relative to the importing module — the extension tree's
  stale hoisted `@earendil-works/pi-ai@0.85.1`. The true fix resolves with the host process entrypoint as the resolver's parent so the derived root is
  the instance the host loaded (verified on pi-web 1.202609.0 / pi 0.87.0 / Bun: `qwen3.6` and `gemma4` respond `stop=stop`, no crash). New exported
  seams `hostAnchorUrl()` and `resolvePiAiSpecifier()` keep the anchor testable; guarded by `test/issue-8-pi-ai-instance.test.ts`.


## [0.6.10] — 2026-09-21

### Fixed

- **pi-web models crash: `undefined is not an object (evaluating 'block.name.length')` before any network call ([#8](https://github.com/gtrabanco/pi-nan-provider/issues/8)).**
  On pi-web's sessiond-on-Bun loader path (pi-web 1.202609.0 / pi 0.87.0 / Bun), `resolveOpenAICompletionsApi()` fell back to a bare subpath import
  `@earendil-works/pi-ai/api/openai-completions.lazy`. The bare root `@earendil-works/pi-ai` was NOT aliased to the compat entrypoint under this
  loader — the observed namespace was the pi-ai 0.87 CORE (which has no `openAICompletionsApi`), and the bare subpath specifier resolved to a stale
  hoisted copy: `@earendil-works/pi-ai@0.85.1` under `~/.pi/agent/npm/node_modules`. That 0.85.1 version's `estimateMessageTokens` has no `system`
  branch, so it treated pi 0.87's string-content `system` transcript message as a block list and crashed on `block.name.length`. No network request
  was ever made.

  New `src/pi-ai-loader.ts` binds the openai-completions streaming factory to the **same** `@earendil-works/pi-ai` package instance as the
  extension's statically imported bare root — if the root exposes `openAICompletionsApi` it is used directly; otherwise a FILE URL is derived from
  `import.meta.resolve("@earendil-works/pi-ai")` (sibling `api/openai-completions.lazy.js`, then `compat.js`). No bare pi-ai subpath specifier
  is ever imported again from `src/`; resolution failure is loud (`PiAiStreamingApiResolutionError`) instead of silently loading a stale copy.
  Guarded by `test/issue-8-pi-ai-instance.test.ts` and the updated `test/extension-load.test.ts`.

### Added

- `test/issue-8-pi-ai-instance.test.ts` — regression tests with real temp-package fixtures proving the streaming factory is bound to the host-resolved
  package instance (a decoy sibling copy must never be selected), the file-URL derivation path, and a typed `PiAiStreamingApiResolutionError` on
  failure; plus a default-host test against the installed pi-ai. `test/extension-load.test.ts` now also forbids dynamic bare pi-ai subpath imports
  anywhere in `src/`.

## [0.6.9] — 2026-09-16

### Fixed

- **Token usage is no longer all-zero by default: chat models now opt in to streaming usage ([#7](https://github.com/gtrabanco/pi-nan-provider/issues/7)).**
  The generated catalog declared `supportsUsageInStreaming: false` everywhere because NaN's published schema
  (`https://nan.builders/openapi.json`) does not document `stream_options`, so usage read as zero unless every user rediscovered and set the
  per-model flag by hand. The reporter measured the live gateway on 2026-09-16 with two identical streaming calls per model, differing only in
  `stream_options`: `deepseek-v4-flash`, `glm5.3-flash`, `qwen3.6`, `mimo-v2.5` and `gemma4` each returned **0** usage chunks without the flag and
  exactly **1** with `stream_options: { include_usage: true }`, carrying prompt/completion/reasoning/cached token counts; a real pi session then
  recorded `{input:168, output:3, cacheRead:39040, totalTokens:39211}` where it had recorded zeros. The schema is silent, not forbidding, so the
  catalog (and the uncatalogued live-model placeholder) now declares `supportsUsageInStreaming: true`: pi-ai asks for the usage chunk, the
  sanitizer forwards `stream_options`, and pi reports real token counts out of the box. The conservative path remains as an explicit per-model
  opt-out — a `models.json` override of `false` strips `stream_options` and keeps the strict payload (the sanitizer gating itself shipped in 0.6.7
  with #4; this release only corrects the default).

### Added

- `test/issue-7-streaming-usage-default.test.ts` — end-to-end acceptance tests through the real pi-ai adapter and a mock NaN gateway that only
  emits the usage chunk when the request carried `stream_options.include_usage` (matching the measurement): a stock catalog model and an
  uncatalogued live model must both send the opt-in and surface non-zero usage; an explicit `false` override must keep the strict payload.

## [0.6.8] — 2026-09-14

### Changed

- **Bumped the media MCP bridge pin to `nan-mcp-server@1.1.2`** (auto-detected by `scripts/check-nan-mcp-server.ts`, see #6).
  Every bridged tool (`generate_image`, `edit_image`, `text_to_speech`, `list_voices`, `speech_to_text`) is still present and its zod input
  schema is unchanged, so the bump is non-breaking for this bridge. The upstream breaking change renamed `embed` → `embed_text` and
  `rerank` → `rerank_documents`, and added `list_models` — none of which this package bridges (optional future work).

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
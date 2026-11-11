# Issue #35 — persist `cf-ray` on cache-anomaly detection, plus a deterministic `/nan-debug` collector

https://github.com/gtrabanco/pi-nan-provider/issues/35

NaN could not reproduce the prompt-cache anomaly and asked for `model` + the
`cf-ray` of a couple of calls. pi's session JSONL records usage and response
ids but **no response headers**, so the evidence is lost by the time the
transcript is inspected. The provider is the only surface that sees raw
response headers (`onResponse`) and the raw gateway chunks (`id`/`created`).

Deliverables: (a) capture the `cf-ray` pair and persist a local anomaly record
when the #17 signature repeats (`id` + `created` identical across two requests),
and (b) an optional `/nan-debug` collector that turns session JSONL plus those
records into a redacted, reproducible evidence package — the exact format NaN
requested.

## Verbatim request (frozen)

- **S1**: "Apply to this repository: issue #35"
- **S2** (issue Summary): "In NaN's response to our token-consumption report (received **2026-11-11**), point 3 says they could **not reproduce** the prompt-cache anomaly and asks for evidence on recurrence:"
- **S3** (NaN's quoted ask): "La caché de prompt no la hemos podido reproducir en qwen3.8-flash, deepseek-v4-flash ni glm5.3-flash. Si te vuelve a pasar, pásanos modelo y cf-ray de un par de llamadas y lo miramos."
- **S4** (The gap): "The anomaly we reported is the #17 signature: identical requests back-to-back returning the same `id` + `created` (gateway response cache, key including system/user/tools/max_tokens/temperature, short TTL)."
- **S5** (The gap): "If the anomaly recurs we currently **cannot deliver what NaN asked for**:"
- **S6**: "- pi's session JSONL (`~/.pi/agent/sessions/**/*.jsonl`) records `message.usage` and ids, but **no response headers** — `cf-ray` is gone by the time we look at the transcript."
- **S7**: "- The provider is the only surface that sees raw response headers (via the `onProviderStreamEvent` observation path, same wiring the #21 guard uses)."
- **S8** (Proposal): "When the #17 signature is detected (identical `id`+`created` returned for distinct requests), persist a small local evidence record with what NaN needs to reproduce:"
- **S9**: "- `model`, the `cf-ray` response header (both requests), timestamps, `id`/`created` pair"
- **S10**: "- written to a local file (e.g. `~/.pi/agent/nan-cache-anomalies.jsonl`) — local-only, no remote telemetry"
- **S11**: "Alternative, lighter shape: a debug flag that logs `cf-ray` per response, and we grep it after a repro. Either way, the deliverable is \"model + cf-ray of a couple of calls\", exactly the format NaN requested."
- **S12**: "The detection heuristic (identical id+created) already exists conceptually from the #17 diagnosis; the only new capability is capturing and persisting the header pair at detection time."
- **S13** (comment): "## Proposal addition: optional `/nan-debug` collector"
- **S14**: "Native pi extension command `/nan-debug [topic] [--window N] [--out file]`, following the `/nan-usage` precedent."
- **S15**: "**Deterministic script, no LLM skill unless one proves necessary** — the collection must be reproducible byte-for-byte, and a skill adds model variability and cost to a job that is pure file reading."
- **S16**: "Flow: collects → writes a **redacted** report locally → prints a preview summary → produces the shareable zip only on explicit confirmation."
- **S17**: "Per-turn usage records from session JSONL: model, input/output/cacheRead/cacheWrite/reasoning/totalTokens, `stopReason`, sanitized `errorMessage`, timestamps, gateway `id`/`created` pairs — the exact fields of the 2026-11-10 report (see #34's dataset comment)."
- **S18**: "Package / pi-ai / pi versions and catalog provenance notes (dates, sources)."
- **S19**: "Optional `--window`: official consumption from `GET /v1/usage` for the same period (uses the stored key; stays permission-gated)."
- **S20**: "`cf-ray` of both requests when the anomaly-detection capture above exists — this is what upgrades a future cache report from \"can't reproduce\" to \"here are the rays\"."
- **S21** (Never collects): "Prompt or response content (same exclusion as the 2026-11-10 report — \"no prompt literal por defecto\")."
- **S22**: "File paths / worktree names (MD5-hashed to 12 chars, same anonymization)."
- **S23**: "Credentials of any kind."

## Acceptance criteria

One observable criterion per `S#`, each naming the check that proves it.

| id | S# | Criterion | Check |
| :--- | :--- | :--- | :--- |
| C1 | S1–S12 | Two consecutive streams for the same model that return the same `id` + `created` append one JSONL record to `nan-cache-anomalies.jsonl` containing the model, both `cf-ray` values, both timestamps and the `id`/`created` pair. | `bun test test/issue-35-cache-anomaly-capture.test.ts` exits 0 |
| C2 | S4, S12 | No record is written when `id` or `created` differs, when `created` is absent, or for the first request of a pair; existing stream behavior (message, events, guard/classifier composition) is unchanged. | `bun test test/issue-35-cache-anomaly-capture.test.ts` exits 0 |
| C3 | S10, S21–S23 | The persisted record carries no prompt/response content, no credential and no raw path; it is local-only (no network) and writes never break a stream. | `bun test test/issue-35-cache-anomaly-capture.test.ts` exits 0 |
| C4 | S14 | `/nan-debug [topic] [--window N] [--out file] [--emit]` parses every documented form, rejects malformed values with a usage message, and is registered by the extension. | `bun test test/issue-35-nan-debug-command.test.ts` exits 0 |
| C5 | S16 | A run writes the redacted report files locally, prints the preview summary, and writes the zip only when `--emit` is present. | `bun test test/issue-35-nan-debug-command.test.ts` exits 0 |
| C6 | S17 | Per-turn rows carry model, input/output/cacheRead/cacheWrite/reasoning/totalTokens, `stopReason`, a classified error (never raw text), timestamps and response id; `created` is null when absent from the transcript. | `bun test test/issue-35-debug-report.test.ts` exits 0 |
| C7 | S18 | `metadata.json` carries package, pi-ai and pi versions plus catalog provenance dates and the resolved window/topic. | `bun test test/issue-35-debug-report.test.ts` exits 0 |
| C8 | S19 | With `--window N` the collector requests `GET /v1/usage` for the same window and writes `usage_window.json`; without it no usage request happens. | `bun test test/issue-35-nan-debug-command.test.ts` exits 0 |
| C9 | S20 | `anomalies.jsonl` inside the report carries the `cf-ray` pair captured by the anomaly detection, filtered to the window. | `bun test test/issue-35-debug-report.test.ts` exits 0 |
| C10 | S15, S22, S23 | Two runs over identical inputs produce byte-identical zip output (fixed entry order and timestamps); session and worktree identifiers are MD5 truncated to 12 chars; no path or credential is emitted. | `bun test test/issue-35-debug-report.test.ts` exits 0 |
| C11 | repo AGENTS.md | The full deterministic gate is green. | `bun test` and `bun run typecheck` exit 0 |

## Scope notes (assumptions marked as assumptions)

- **Assumption:** `[topic]` is a free-form report label (1–32 chars of
  `[a-z0-9_-]`) recorded in `metadata.json`; it does not filter sections. The
  issue names the token but never defines its semantics, and the documented
  report shape always contains usage + anomalies.
- **Assumption:** the default window is 7 days (clamped to the API's 90-day
  limit when `--window` is used), because the issue shows a "window: 2d"
  preview but no default.
- The lighter alternative in S11 (log every `cf-ray`) is not shipped: S8–S10
  is the concrete proposal and the one NaN's request maps to; S11 explicitly
  says "either way", so one shape is enough.
- `--window`'s live `GET /v1/usage` stays permission-gated: tests inject the
  fetch, and no live probe is run for this unit.

## Log

- 2026-11-11 — Unit opened from issue #35. Intent resolved `proceed`: fresh
  application, no prior phase state, clean tree at `8711c35`. The repo's
  `docs/` tree was removed in `d91f5a3`; the unit doc and ledgers were cut from
  the issue-34 SPEC shape at `d91f5a3^` (the repo's own last frozen example).
  Ledgers frozen at cut: O1–O10 all `planned`.
- 2026-11-11 — P1 (RED): the three acceptance suites failed with
  `Cannot find module '../src/cache-anomaly.ts'` / `'../src/debug-report.ts'`
  before any implementation existed. The #21/#3/#4 previous-behavior suites
  passed unchanged.
- 2026-11-11 — P2: `src/cache-anomaly.ts` (tracker, header/chunk observation,
  agent-dir JSONL sink) and `src/zip.ts` (store-method deterministic container)
  implemented; `src/debug-report.ts` added the session walker, aggregation,
  redaction, error classifier, metadata and renderer.
- 2026-11-11 — P3: `src/debug-command.ts` wired into `src/index.ts`;
  `withCacheAnomalyCapture` composed outermost in `src/provider-factory.ts`.
  The extension-level command-list pin in `test/compat.test.ts` gained
  `nan-debug` (a new command, not a changed assertion).
- 2026-11-11 — P3 fix: a first working-tree state recorded a false anomaly when
  `created` was absent because the fake message's default `responseId` masked
  the missing chunk id; the fixture was corrected to pass an empty id, and the
  real-adapter test was added to prove the wiring against pi-ai itself.
- 2026-11-11 — Differential check: base `8711c35` vs changed tree over two real
  provider streams (distinct ids, injected fetch) in `/tmp` — identical
  message/usage/stopReason output and no anomaly file (`DIFFERENTIAL CLEAN`).
  Zip output validated with `unzip -l`/`unzip -t` in `/tmp` (5 entries, no
  errors, fixed 1980-01-01 timestamps).
- 2026-11-11 — P4: README/README.es guide sections, CHANGELOG 1.5.4, version
  bump, AGENTS.md verified-facts bullet; obligations closed against
  foreground validator runs.

## Evidence

| date | work | proof | checks |
| :--- | :--- | :--- | :--- |
| 2026-11-11 | RED corpus | before implementation: 3/3 suites failed on missing modules (`0 pass / 3 fail / 3 errors`) | ok |
| 2026-11-11 | O1 + O2 + O3 | `bun test test/issue-35-cache-anomaly-capture.test.ts` → `13 pass, 0 fail, 33 expect() calls` (includes the real pi-ai adapter path) | ok |
| 2026-11-11 | O4 + O5 + O8 | `bun test test/issue-35-nan-debug-command.test.ts` → `11 pass, 0 fail, 41 expect() calls` | ok |
| 2026-11-11 | O6 + O7 + O9 | `bun test test/issue-35-debug-report.test.ts` → `8 pass, 0 fail, 62 expect() calls` | ok |
| 2026-11-11 | O10 previous behavior | `bun test test/issue-21-reasoning-only-stream.test.ts test/issue-3-model-switch-overflow.test.ts test/issue-4-token-usage.test.ts` → `21 pass, 0 fail` | ok |
| 2026-11-11 | O10 full gate | `bun test` → `374 pass, 0 fail, 1653 expect() calls, 35 files`; `bun run typecheck` → exit 0 | ok |
| 2026-11-11 | §6 differential | base-vs-changed provider streams in `/tmp`: identical output, no anomaly file — `DIFFERENTIAL CLEAN`; zip verified with `unzip -t` → `No errors detected` | ok |

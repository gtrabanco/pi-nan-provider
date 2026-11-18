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
| C12 | S1 (apply 2026-11-18) | Every blocker B1–B6 of the 2026-11-18 `EXTERNAL VERIFY` receipt is resolved: the full gate is green and each blocker's reproducer behaves as claimed. | `bun test` exits 0; `bun test test/issue-44-nan-debug-interval.test.ts` exits 0 |
| C13 | S2 (apply 2026-11-18) | The frozen-failure corpus (the B1 layout failure plus one RED test per B2–B5/A3 rule) is recorded failing before any fix lands. | `## Evidence` RED rows dated 2026-11-18 and written before the first P2 row |
| C14 | S3 (apply 2026-11-18) | Differential: a base copy in `mktemp` scratch and the changed tree differ only by the requested behavior — base stays `427 pass / 0 fail`, changed tree green, typecheck clean on both; no unrequested result change in the pre-existing suites. | `bun test` and `bun run typecheck` exit 0 on both copies |
| C15 | S4 (apply 2026-11-18) | The sibling sweep re-run after the batch finds no surviving mention asserting the pre-batch truth (stale "never" claims, `2año` usage example, stale report-contents/redaction prose). | `rg -n "aside from|120 chars|full text is available|The raw text is never emitted" src/debug-report.ts` exits 1; `rg -n -- "--interval" README.md README.es.md` exits 0 |
| C16 | S1, S2 (apply 2026-11-18), #35 S11 | Every stream with a gateway id and a `cf-ray` header appends one `{response_id, cf_ray, model, observed_at}` record to the local sidecar, on success and on failure; local-only, no content/credentials/paths, write failure never breaks the stream. | `bun test test/issue-35-s11-response-rays.test.ts` exits 0 |
| C17 | S1, S2 (apply 2026-11-18), #35 S17 | The report joins the sidecar: turn rows and rendered `turns.jsonl` carry `cf_ray` (ray or `null`), while the anomaly capture and record stay byte-identical to before. | `bun test test/issue-35-s11-response-rays.test.ts` exits 0; `bun test test/issue-35-cache-anomaly-capture.test.ts` exits 0 |
| C18 | S2 (apply 2026-11-18) | Differential: a `7b1fa8b` copy in `mktemp` scratch and the changed tree differ only by the requested corpus — pre-existing suites identical, both gates green, typecheck clean. | `bun test` and `bun run typecheck` exit 0 on both copies |
| C19 | S1, S2 (apply 2026-11-18) | README EN/ES document the sidecar and the `cf_ray` field, CHANGELOG has the 1.5.9 entry, badges match `package.json`. | `bash -c 'rg -q "nan-response-rays" README.md README.es.md && rg -q "1.5.9" package.json CHANGELOG.md'` exits 0 |

## Scope notes (assumptions marked as assumptions)

- **Assumption:** `[topic]` is a free-form report label (1–32 chars of
  `[a-z0-9_-]`) recorded in `metadata.json`; it does not filter sections. The
  issue names the token but never defines its semantics, and the documented
  report shape always contains usage + anomalies.
- **Assumption:** the default window is 7 days (clamped to the API's 90-day
  limit when `--window` is used), because the issue shows a "window: 2d"
  preview but no default.
- ~~The lighter alternative in S11 (log every `cf-ray`) is not shipped: S8–S10
  is the concrete proposal and the one NaN's request maps to; S11 explicitly
  says "either way", so one shape is enough.~~ — **revoked by the owner on
  2026-11-18** ("El cf-ray hay que incluirlo en el reporte de debug, es básico
  para el equipo de soporte de nan.", accepted option "cf-ray de TODAS las
  respuestas"): S11 now ships as the persistent response-ray sidecar
  `<agentDir>/nan-response-rays.jsonl` (`response_id` → `cf_ray`), joined into
  `turns.jsonl`. The S8–S10 anomaly pair capture is unchanged (D-35-03).
- `--window`'s live `GET /v1/usage` stays permission-gated: tests inject the
  fetch, and no live probe is run for this unit.
- **Assumption (PR #44, correction batch 2026-11-18):** the open-left interval
  `- <date>` starts at the default window's start (`rollingWindow(7)` = last 7
  days inclusive), because #44's own comment says "inicio del window hasta 10
  nov" and an interval carries no `--window` to read.
- **Owner amendment (PR #44 §1, correction batch 2026-11-18):** `sessions/`
  embeds raw session transcripts on the owner's explicit request, so the
  "never collect prompt/response content, credentials or raw paths" invariant
  scopes to the root files; `sessions/` carries raw text with only its `cwd`
  header MD5[:12]-hashed. Credentials stay excluded everywhere.

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
- 2026-11-12 — Correction batch opened from the `EXTERNAL VERIFY` receipt in
  `external-verify.md` (0 blockers, 5 advisories; owner instruction: "triage
  and fix those that deserve to fix …"). Triage: A1–A4 fix, A5 `wontfix`
  (D-35-01 — the `MAJOR.MINOR ↔ pi release line` alignment is the stronger
  invariant; npm latest 1.5.2, this branch carries unpublished 1.5.4). Ledgers
  extended with O11–O13 before code; `decisions.md` cut with the
  path-protection `justification` + `approval` records for the protected suite
  edit (the gate's schema line is `path-protection-records@1`).
- 2026-11-12 — P5 (RED): both reproducers failed as recorded —
  `--out --emit` / `--out --window 2` parsed `ok`, and `--out ~/evidence`
  wrote `<cwd>/~/evidence`. The red run therefore created a stray `~/`
  directory inside the repo cwd: disclosed, removed, and absent after the fix.
- 2026-11-12 — P6: `parseDebugArgs` rejects a `--`-prefixed `--out` value with
  the usage message; `src/debug-command.ts` expands a leading `~/` (injectable
  `homedir`) so the README example writes `<home>/evidence`.
- 2026-11-12 — P7: gates green (`376 pass / 0 fail / 1664 expect() calls / 35
  files`, typecheck exit 0); differential against a `369bb56` copy in `mktemp`
  scratch is additive-only (base `374/0/1653/35` + exactly the two new cases,
  zero deletions in the touched suite); sibling sweep clean except
  `README.es.md:439`'s second duplicated `---`, which exists at `origin/main`
  (base defect, reported not folded).
- 2026-11-12 — Concurrent owner commit `d449261 chore(git): .gitignore` landed
  mid-batch, adding `docs/` to `.gitignore`: the new `decisions.md` and
  `external-verify.md` are git-ignored and stay untracked pending the owner's
  decision — not force-added over a fresh owner commit.
- 2026-11-18 — Correction batch opened from the `EXTERNAL VERIFY` receipt in
  `external-verify.md` (2026-11-18: NEEDS-DECISION, 6 blockers B1–B6, 4
  advisories, base `542e707` · head `e045261`; owner: "triage and fix those
  that deserve to fix …"). Triage: all six blockers and all four advisories
  deserve the fix; ledgers extended with O14–O22 and PE-010/PE-011 before any
  code; O6/O7/O9/O10/O13 flipped back to `in-progress` because their validators
  no longer reproduce at `e045261`. PE-010 verified against the pinned pi
  1.5.1 dist (raw args, no quote stripping); npm latest confirmed 1.5.7 for
  the O20 bump target.
- 2026-11-18 — P1 (RED): the frozen-failure corpus landed on
  `test/issue-44-nan-debug-interval.test.ts` → 4 pass / 10 fail / 43 expect
  before any `src/` change; path-protection justification + owner-approval
  records (D-35-02) cut in this unit's `decisions.md` first, and the
  already-recorded 2026-11-11 layout edit was applied to
  `test/issue-35-debug-report.test.ts` (contains checks + `sessions/` entries
  + `sessionsDir`), turning the pre-batch 441/1 gate green at the test layer.
- 2026-11-18 — P2: `src/debug-report.ts` fixes landed (`dadc6bf`, one slice
  with the corpus so the batch never commits a red gate): `--interval` value
  join up to the next `--` flag + quote stripping (PE-010), open-left/open-right
  parsing, explicit 90-day cap message (usage line drops `2año`), day-granular
  `inWindow` (start-date parity), `error_summary` in metadata, `cwd` hashing in
  `sessions/`, scoped never-collected wording (header, classifyErrorMessage
  doc, rendered template, preview suffix), real `days` for relative spans,
  UTC-only `parseRange`. Suite → 456 pass / 0 fail, typecheck exit 0.
- 2026-11-18 — P3/P4: README EN/ES + CHANGELOG + `package.json` 1.5.8 +
  AGENTS bullet (`48577e7`); ledgers frozen (`ed3dbe2`); all 22 obligation
  rows re-run green in the foreground and flipped to `verified`; differential
  vs a fresh `origin/main` copy clean (427/0/2024/36 → 456/0/2134/38,
  typecheck 0 both sides); post-batch sibling sweep clean. Commits:
  `ed3dbe2`, `dadc6bf`, `48577e7` (+ this evidence commit) — not pushed, the
  owner is the external verifier.
- 2026-11-18 — S11 reopened by owner order (S1 + accepted option "cf-ray de
  TODAS las respuestas") on branch `feat/cf-ray-every-response` stacked on
  `7b1fa8b`: the "S11 not shipped" scope note is revoked above, ledgers
  extended with O23–O28 and PE-012 before code, criteria C16–C19 cut, and the
  path-protection justification + approval records (D-35-03, phase P4) cut in
  this unit's `decisions.md`. Stacked delivery keeps the unit ledger and the
  version line linear (1.5.7 → 1.5.8 → 1.5.9).
- 2026-11-18 — P4 (RED) → P5 → P6 → P7: corpus cut (0 pass / 1 error,
  `Cannot find module`), then `src/response-rays.ts` + raySink wiring
  (`f4a951b`) turned it 9 pass / 0 fail; README EN/ES + CHANGELOG 1.5.9 +
  `package.json` 1.5.9 + AGENTS bullet (`b9b61ad`, landed one commit before
  the code commit because two git commands raced on `index.lock` — the failed
  add was re-run sequentially, no history rewritten); ledgers frozen
  (`5336817`). All 28 obligation rows re-run green in the foreground and
  flipped to `verified`; differential vs `7b1fa8b` clean (+9 corpus only).
  Not pushed — the owner is the external verifier.

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
| 2026-11-12 | correction-batch RED (O11, O12) | `bun test test/issue-35-nan-debug-command.test.ts` → `11 pass, 2 fail` — both new reproducers red (`--out --emit` parsed ok; `--out ~/...` wrote `<cwd>/~`) | ok |
| 2026-11-12 | O11 + O12 | `bun test test/issue-35-nan-debug-command.test.ts` → `13 pass, 0 fail, 52 expect() calls` | ok |
| 2026-11-12 | O13 differential | `mktemp` copy of `369bb56`: `bun test` → `374 pass, 0 fail, 1653 expect() calls, 35 files` + `bun run typecheck` exit 0; changed tree → `376 pass, 0 fail, 1664 expect() calls, 35 files` + typecheck exit 0 — delta is exactly the +2/+11 new corpus, zero deletions | ok |
| 2026-11-12 | S4 sibling sweep | `rg` over README EN/ES, AGENTS, CHANGELOG, `src/`: command enumerations, `--out` mentions and tilde examples consistent; remaining `README.es.md:439` duplicated `---` traced to `origin/main:397` (base, reported) | ok |
| 2026-11-18 | correction-batch RED (O14, O15, O16, O17, O21) | `bun test test/issue-44-nan-debug-interval.test.ts` → **4 pass / 10 fail / 43 expect** before any `src/` change; B1's reproducer recorded pre-batch: `bun test` → 441 pass / 1 fail (layout test) at `e045261` | ok |
| 2026-11-18 | O1 + O2 + O3 | `bun test test/issue-35-cache-anomaly-capture.test.ts` → 13 pass / 0 fail / 33 expect | ok |
| 2026-11-18 | O4 + O5 + O8 + O11 + O12 | `bun test test/issue-35-nan-debug-command.test.ts` → 13 pass / 0 fail / 52 expect | ok |
| 2026-11-18 | O6 + O7 + O9 + O13 (B1 restored) | `bun test test/issue-35-debug-report.test.ts` → 8 pass / 0 fail / 69 expect (layout assertion carries `errors.jsonl` + exact window-filtered `sessions/` entries) | ok |
| 2026-11-18 | O14 + O15 + O16 + O17 + O21 | `bun test test/issue-44-nan-debug-interval.test.ts` → 14 pass / 0 fail / 73 expect | ok |
| 2026-11-18 | O10 full gate | `bun test` → 456 pass / 0 fail / 2134 expect / 38 files; `bun run typecheck` → exit 0 | ok |
| 2026-11-18 | O18 + O22 text validators | `rg -n "aside from\|120 chars\|full text is available\|The raw text is never emitted" src/debug-report.ts` → exit 1; `rg -n "\\.getHours\\(\\)\|\\.getMinutes\\(\\)\|\\.getSeconds\\(\\)" src/debug-report.ts` → exit 1 | ok |
| 2026-11-18 | O19 + O20 docs validators | `rg -n -- "--interval" README.md README.es.md` → exit 0; `rg -n "1\\.5\\.8" package.json CHANGELOG.md` → exit 0; EN/ES header lists both 24 lines, identical structure; both badges `version-1.5.8` | ok |
| 2026-11-18 | C14 differential base-vs-change | base copy (`git archive origin/main` in `mktemp`): 427 pass / 0 fail / 2024 expect / 36 files + typecheck exit 0; changed tree: 456 pass / 0 fail / 2134 expect / 38 files + typecheck exit 0 — delta = the 15 #44 feature tests + the 14-test correction corpus, zero base test lost or regressed, no unrequested result change | ok |
| 2026-11-18 | C15 sibling sweep (post-batch) | stale-claim `rg` set all at the expected exits (no `aside from`/`120 chars`/`never emitted`, no absolute "never collected" README line, no advertised `2año`); `errors.jsonl`/`sessions/`/`error_summary` present in README EN+ES; AGENTS #35 bullet extended; rendered template and preview scoped | ok |
| 2026-11-18 | S11 RED corpus (O23, O24, O25) | `bun test test/issue-35-s11-response-rays.test.ts` → **0 pass / 1 fail / 1 error** (`Cannot find module '../src/response-rays.ts'`) before any `src/` change | ok |
| 2026-11-18 | O23 + O24 + O25 | `bun test test/issue-35-s11-response-rays.test.ts` → **9 pass / 0 fail / 23 expect** (capture on success and failure, four-field shape, no-id/no-header skip, 3-line cap keeps newest, unwritable path safe, join + rendered `cf_ray`, missing sidecar nulls, reader resilience) | ok |
| 2026-11-18 | O26 regression pin | anomaly suite → 13 pass / 0 fail / 33 expect; report suite → 8 pass / 0 fail / 69 expect; command suite → 13 pass / 0 fail / 52 expect; interval suite → 14 pass / 0 fail / 73 expect — anomaly record shape and every pre-existing behavior untouched | ok |
| 2026-11-18 | O28 full gate | `bun test` → 465 pass / 0 fail / 2157 expect / 39 files; `bun run typecheck` → exit 0 | ok |
| 2026-11-18 | C18 differential base-vs-change | base copy (`git archive 7b1fa8b` in `mktemp`): 456 pass / 0 fail / 2134 expect / 38 files + typecheck exit 0; changed tree: 465 / 0 / 2157 / 39 + typecheck exit 0 — delta = exactly the 9-test S11 corpus, zero base test lost or regressed | ok |
| 2026-11-18 | O27 docs validators | `bash -c 'rg -q "nan-response-rays" README.md README.es.md && rg -q "1.5.9" package.json CHANGELOG.md'` → exit 0; EN/ES header lists 24/24 lines; both badges `version-1.5.9` | ok |

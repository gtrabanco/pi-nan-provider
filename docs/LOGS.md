# Session Log

Entries are appended at natural stopping points so the next session can pick up
the thread without re-reading git history.

## 2026-11-11 — issue #35: cf-ray cache-anomaly evidence + `/nan-debug`

**Done**

- Applied issue #35 through the owner's inline workflow for the repo's own
  surgery: intent resolution → ledger freeze (`docs/fix/issue-35-cf-ray-cache-evidence/`)
  → RED acceptance corpus → implementation → differential → gates.
- New `src/cache-anomaly.ts`: the provider observes `onResponse` (`cf-ray`) and
  raw `onProviderStreamEvent` chunks (`id`/`created`), compares each completed
  stream per model, and appends one JSONL record to
  `<agentDir>/nan-cache-anomalies.jsonl` when the #17 signature repeats. Bursts
  record the pair once; a write failure never breaks a stream.
- New `src/debug-report.ts` + `src/debug-command.ts`: `/nan-debug [topic]
  [--window N] [--out file] [--emit]` reads session JSONL plus the anomaly
  capture, writes a redacted report (`README.md`, `anonymized_usage.jsonl`,
  `turns.jsonl`, `anomalies.jsonl`, `metadata.json`), prints a preview and
  writes the zip only with `--emit`. `--window` is the only network path and
  stays behind the explicit flag.
- New `src/zip.ts`: store-method, sorted-entry, fixed-timestamp zip writer so
  identical inputs yield byte-identical archives on Bun and Node
  (`Bun.Archive` is Bun-only).
- `src/provider-factory.ts` composes the capture outermost; `src/index.ts`
  registers the command; README/README.es, CHANGELOG 1.5.4, version bump and
  AGENTS.md verified-facts updated.

**Checks**

- `bun test` → 374 pass / 0 fail; `bun run typecheck` → exit 0.
- Base-vs-change differential on real provider streams: identical output, no
  anomaly file. Zip validated with `unzip -t`.

**Next**

- External verifier verdict on the handoff; no open obligation rows.

## 2026-11-12 — issue #35: fold the external-verify advisories (correction batch)

**Done**

- Read the `EXTERNAL VERIFY` receipt (`docs/fix/issue-35-cf-ray-cache-evidence/external-verify.md`,
  2026-11-11: `VERIFIED`, 0 blockers, 5 advisories) and triaged under the
  owner's "triage and fix those that deserve to fix":
  - **A1 fixed** — `parseDebugArgs` now rejects a `--`-prefixed token as the
    `--out` value (usage message), so `--out --emit` can no longer succeed with
    `emit: false` nor `--out --window 2` parse as out=`--window`/topic=`2`.
  - **A2 fixed** — `--out ~/…` (and bare `~`) expands to the home directory
    (injectable `homedir`), so the README/README.es example writes
    `<home>/evidence` instead of a literal `~` dir in the session cwd.
  - **A3 fixed** — `AGENTS.md` command-time `ctx.modelRegistry` list gains
    `/nan-debug`.
  - **A4 fixed** — the duplicated `---` before the new section removed from
    README.md and README.es.md.
  - **A5 `wontfix`** — `MAJOR.MINOR ↔ pi release line` is the stronger
    invariant (npm latest 1.5.2, branch carries unpublished 1.5.4); recorded as
    `D-35-01` in the unit's `decisions.md`.
- Ledgers: `planning-obligations.md` gained O11–O13 (cut `planned`, flipped on
  foreground validators); `decisions.md` created with the
  `path-protection-records@1` justification + approval rows for the protected
  suite edit; SPEC `## Log`/`## Evidence` carry the batch.

**Checks**

- RED first: `bun test test/issue-35-nan-debug-command.test.ts` → 11 pass /
  2 fail (both reproducers), then → 13 pass / 0 fail / 52 expect() calls.
- `bun test` → 376 pass / 0 fail / 1664 expect() calls / 35 files;
  `bun run typecheck` → exit 0.
- Differential vs a `369bb56` copy in `mktemp` scratch: base 374/0/1653/35,
  typecheck 0 → additive-only (+2 tests, +11 expects, zero deletions).

**Disclosures**

- The red run's `--out ~/…` reproducer created a stray `~/` directory inside
  the repo cwd (the very bug under repair): removed, absent after the fix.
- Concurrent owner commit `d449261 chore(git): .gitignore` added `docs/` to
  `.gitignore` mid-batch; the new `decisions.md` / `external-verify.md` are
  git-ignored and remain untracked pending the owner's decision (not
  force-added over a fresh owner commit).
- Out-of-batch base defect reported, not folded: `README.es.md:439` has a
  second duplicated `---` (present at `origin/main:397`).

**Next**

- Owner decision: track or ignore `decisions.md` / `external-verify.md` under
  the new `docs/` ignore rule; then external verdict on the handoff.

## 2026-11-16 — issue #40: `nan-mcp-server` pin `1.3.0 → 1.5.0`

**Done**

- Applied issue #40 on branch `fix/issue-40-nan-mcp-server-1-5-0` (PR #41,
  body `Closes #40`): bumped `DEFAULT_NAN_MEDIA_MCP_VERSION` and carried the
  documented surface and the release line in one patch release `1.5.5`. The
  unit ledger lives in `docs/fix/issue-40-nan-mcp-server-1-5-0/` (local-only
  under the repo's `docs/` ignore rule); SPEC + obligations + evidence are in
  `SPEC.md`, the protected-path records in `decisions.md`.
- Both READMEs: media tool table gains `get_usage` (10 tools), Features row
  count `9 → 10`, `NAN_MEDIA_MCP_VERSION` default `1.5.0`; badges `1.5.5`.
- AGENTS.md verified facts: pin `nan-mcp-server@1.5.0`, 10 tools; upstream
  `1.4.0` `qwen-image-2.1` support needs no package change, `1.5.0` adds
  `get_usage` (real consumption + credit pool) and flags stale `get_quota`
  counters.
- CHANGELOG `1.5.5` entry; `package.json` `1.5.5` (npm latest is `1.5.4`).

**Checks**

- RED first: `bun test test/mcp-media.test.ts` → 7 pass / 1 fail (pin
  reproducer), then 8 pass / 0 fail after the constant change.
- `bun test` → 376 pass / 0 fail / 1662 expect() calls / 35 files;
  `bun run typecheck` → exit 0.
- Differential vs a `d49ba7c` (`git archive main`) copy in `mktemp -d`:
  identical 376/0/1662/35 and typecheck 0.
- Published-surface check: `unpkg.com/nan-mcp-server@1.5.0/server.js` → 10
  tools (`get_usage` the only addition); base-copy `bun run
  check-nan-mcp-server` reproduces issue #40's `breaking: false` verdict.

**Next**

- External verifier verdict on PR #41; merging publishes `1.5.5` through the
  gated workflow.

## 2026-11-16 — issue #40: external-verify advisory corrections (post-verdict)

**Done**

- Triaged the `EXTERNAL VERIFY` receipt for
  `docs/fix/issue-40-nan-mcp-server-1-5-0/` (0 blockers, 2 advisories); both
  advisories deserved a fix and were fixed in the unit ledger (local-only,
  gitignored): O2's validator cell now states the outcomes its commands
  actually print (the checker never emitted a 1.3.0→1.5.0 tool delta — that
  comes from the published-surface diff), and O8's head snapshot
  (`8 files, +74/−14`) was appended as a new evidence row instead of rewriting
  the 7-file receipt.
- Correction Log row + 3 evidence rows added to the unit SPEC; the §5
  freeze exception (validator cell edit) is recorded in the Log row.

**Checks**

- RED first: both reproducer cells mismatched measured output before the edit;
  GREEN after: corrected O2 validators (`curl` surface → 10 names,
  `comm -13` → exactly `get_usage`, `comm -23` → empty, base-copy checker
  `status: update-available breaking: false`) and O8 (`git diff --stat` →
  `8 files changed, 74 insertions(+), 14 deletions(-)`).
- `bun test` → 376 pass / 0 fail / 1662 expect() calls / 35 files;
  `bun run typecheck` → exit 0. Tracked tree otherwise untouched
  (correction is docs-only).
- Sibling sweep: no surviving assertion of the old validator claim; the
  7-file receipt remains only as the historical row, reconciled by the
  appended one.

**Next**

- Owner delta-reverify of this correction batch on PR #41.

## 2026-11-17 — NaN catalog: `qwen4-max` + `hy4-flash`, documented limits

**Done**

- Applied the catalog update through `/aw-local-apply`: ledger frozen at
  `docs/fix/nan-larger-models-2026-11-17/` (topic directory — no issue exists
  for this change), RED acceptance suite first
  (`test/larger-models-2026-11-17.test.ts`, 25 of 28 failing on the untouched
  tree), then implementation.
- `scripts/manual-overrides.ts`: the larger-model block is now `LARGER_MODELS`
  with six entries — the four 2026-11-10 ids plus `qwen4-max` and
  `hy4-flash` — each carrying its documented context/max answer/modalities and
  reasoning behaviour from https://nan.builders/docs/models (checked
  2026-11-17). `reasoningEffortValues` moved out of its own table into each
  override, so the generator no longer keeps a second copy.
- `scripts/generate-models.ts`: dropped `REASONING_EFFORT_VALUES` and the
  `REASONING_EFFORT_VALUES_FROM_DOCS` fallback; one source, the override.
- Catalog corrections the docs pinned down: `glm5.3` **text only** (an image
  answers 400) and `off` → `minimal`; `qwen3.8-max` sends
  `max_completion_tokens` (its `max_tokens` bounds only the answer — issue
  #34's quota failure mode) and maps `off` → `none`; `qwen3.8-flash` maps
  `off` → `none`; `kimi-k3.1-pro` 1,048,576, `deepseek-v4-pro` 393,216,
  `hy4` 65,536, `qwen3.8-max` 131,072 max output; `deepseek-v4-flash` declares
  the documented steering ladder while keeping `off` → `none`.
- README + README.es model and reasoning tables, CHANGELOG 1.5.6, version bump
  (patch: the verified pi baseline is unchanged), AGENTS.md verified facts.

**Checks**

- `bun test` → 409 pass / 0 fail; `bun run typecheck` → exit 0.
- Pinned suites moved to the new documented contract (issue-16, issue-19,
  issue-34, fetch-models, generated-catalog); each edit is recorded in the
  unit's `decisions.md` path-protection rows. No assertion relaxed or skipped.
- Sources re-read before writing: docs/models (S6 HTML), docs/pi,
  docs/opencode (client-budget wording), openapi.json `model` description and
  the live `GET /v1/models` (token-free).

**Next**

- Owner verdict on the handoff. Advisory for a separate decision: pi-ai's
  `getSupportedThinkingLevels` only exposes `xhigh`/`max` when
  `thinkingLevelMap` declares them, so the picker stops at `high` even though
  the docs document the two deeper levels; adding identity entries would change
  every model's level list.

**Extension (same day)** — owner instruction "Metelo dentro de pr #42": pi-ai
only offers `xhigh`/`max` when `thinkingLevelMap` declares them, so the catalog
now carries identity entries on the eight models whose docs declare a ladder up
to `max`; a `max` request used to reach the gateway as `reasoning_effort: "high"`.
`hy4`, `hy4-flash`, `qwen3.8-max` (only their off switch is documented) and
`kimi-k3.1-pro`/`deepseek-v4-pro` (outside the contract) stay at `off`…`high`.
Gate after the extension: 424 tests pass / 0 fail, typecheck exit 0.

## 2026-11-17 — issue #36: revert the `qwen3.8-flash` `max_completion_tokens` bound

**Done**

- NaN support reported the gateway fix deployed and validated, so removed
  `maxTokensField: "max_completion_tokens"` from `MANUAL_OVERRIDES["qwen3.8-flash"]`
  and regenerated the catalog; the entry is back on the classic `max_tokens`.
  `qwen3.8-max` keeps its own override on the 2026-11-17 docs evidence, so
  `SanitizerOptions.preserveMaxCompletionTokens` and the sanitizer wiring stay.
- `test/issue-34-max-completion-tokens.test.ts` now encodes the #36 revert:
  `qwen3.8-flash` catalog/wire on `max_tokens`, `qwen3.8-max` still on
  `max_completion_tokens`, sanitizer default/opt-out both covered.
- README (EN/ES), CHANGELOG 1.5.7, version bump, AGENTS verified facts and the
  qwen3.8-flash provenance note updated; `/nan-usage` needed no code change —
  the "usage" report was the #17 proxy response cache, now disabled upstream.

**Probe (authorized by the maintainer, 3k-token cap)**

- Two identical streaming requests, `max_tokens: 1024`, `include_usage`:
  completions 168 / 165 tokens, ids `chatcmpl-05a8…` / `chatcmpl-1a06…`,
  different `created` → cache off, each response has its own usage.
- One `max_tokens: 64` request: `completion_tokens: 64`,
  `reasoning_tokens: 64`, `finish_reason: "length"`, empty content → the budget
  is honoured. Total probe: 661 tokens.

**Checks**

- `bun test` → 427 pass / 0 fail / 2024 expect() calls / 36 files;
  `bun run typecheck` → exit 0.
- `bun run generate-models` diff: only `qwen3.8-flash` compat field, its note
  and `fetchedAt`.

**Next**

- PR/merge publishes 1.5.7; close #36 with the probe result.

## 2026-11-18 — EV-2026-11-18 correction batch: `/nan-debug` interval + error evidence fixes (PR #44)

**Done**

- Read the `EXTERNAL VERIFY` receipt (2026-11-18, NEEDS-DECISION: 6 blockers
  B1–B6, 4 advisories, base `542e707` · head `e045261`) and folded one
  correction batch under the owner's "triage and fix those that deserve to
  fix …" — all six blockers and all four advisories fixed (D-35-02).
- Ledgers first (§5): O14–O22 + PE-010 (pi passes slash-command args raw,
  verified on the pinned 1.5.1 dist) + PE-011 (date-only `rollingWindow`
  bounds), criteria C12–C15, O6/O7/O9/O10/O13 reopened, path-protection
  justification + owner-approval records cut in the unit `decisions.md`.
- RED corpus on `test/issue-44-nan-debug-interval.test.ts` (4 pass / 10 fail
  before any `src/` change), then the fix in `src/debug-report.ts`:
  `--interval` joins tokens up to the next `--` flag + strips quotes (all
  documented range/open forms now parse), open-left/open-right windows,
  explicit 90-day cap message (usage line drops the unparsable `2año`),
  day-granular `inWindow` (start-date sessions no longer dropped; `5min`/`2h`
  windows no longer empty), `error_summary` in `metadata.json`, `sessions/`
  embeds transcripts with the `cwd` header MD5-hashed (no raw path anywhere),
  never-collected wording scoped in the module header, `classifyErrorMessage`
  doc, rendered template and preview, real `days` for relative spans,
  UTC-only `parseRange`, absolute byte-identity restored in the header.
- The 2026-11-11 record for the protected layout test was finally applied
  (contains checks + `errors.jsonl` + window-filtered `sessions/` entries +
  `sessionsDir`), so the red gate and the stale records resolve together.
- Docs in the same change: README/README.es (`--interval`, report contents,
  scoped redaction, #44 feature row, badge), CHANGELOG 1.5.8,
  `package.json` 1.5.8 (npm latest = 1.5.7; PATCH line per D-35-01), AGENTS
  #35 bullet.

**Checks**

- `bun test` → 456 pass / 0 fail / 2134 expect / 38 files; `bun run typecheck` → exit 0.
- All 22 obligation rows re-run green in the foreground → `verified`.
- Differential: base `origin/main` copy in `mktemp` → 427/0/2024/36 + typecheck 0
  vs changed tree 456/0/2134/38 + typecheck 0 — requested delta only.
- Post-batch sibling sweep clean (stale-claim `rg` set at expected exits;
  EN/ES header structure identical, 24 lines each).

**Next**

- Owner verdict (external verify) on commits `ed3dbe2`, `dadc6bf`, `48577e7`
  + this evidence commit; nothing pushed.

## 2026-11-18 — issue #35 S11 (owner order): cf-ray of every response in the report

**Done**

- Owner: "El cf-ray hay que incluirlo en el reporte de debug, es básico para
  el equipo de soporte de nan." + accepted option "cf-ray de TODAS las
  respuestas" → issue #35's S11 (recorded "not shipped") is ordered after all.
  Scope note revoked (D-35-03), branch `feat/cf-ray-every-response` stacked on
  the #44 correction head `7b1fa8b` (ledger and version line stay linear).
- Ledgers frozen first: O23–O28, PE-012, criteria C16–C19, path-protection
  justification + approval records (P4).
- RED corpus on `test/issue-35-s11-response-rays.test.ts` (0 pass / 1 error,
  `Cannot find module`), then `src/response-rays.ts`: per-response sidecar
  `{response_id, cf_ray, model, observed_at}` (four fields, best-effort,
  newest 50,000 lines kept by deterministic compact) + capture wired into
  `withCacheAnomalyCapture` on success AND failure paths + report join
  (`DebugTurn.cf_ray`, rendered `turns.jsonl`, report README bullet).
- Docs in-change: README EN/ES (sidecar paragraph, contents bullet, feature
  row, badges), CHANGELOG 1.5.9, `package.json` 1.5.9, AGENTS #35 bullet.

**Checks**

- `bun test` → 465 pass / 0 fail / 2157 expect / 39 files; `bun run typecheck` → exit 0.
- All 28 obligation rows re-run green in the foreground → `verified`.
- Differential: base `7b1fa8b` copy in `mktemp` → 456/0/2134/38 + typecheck 0
  vs changed 465/0/2157/39 + typecheck 0 — +9 corpus tests only.
- Anomaly suite (13/0) proves the #17 capture is byte-identical.

**Next**

- Owner verdict (external verify) on commits `5336817`, `b9b61ad`, `f4a951b`
  + this evidence commit, on top of PR #44's branch; nothing pushed.

## 2026-11-21 — issue #45: pi / pi-ai 1.5.1 → 1.6.0 realign

**Done**

- Applied the `sdk-monitor` issue #45 inline. No `chore/pi-sdk-1.6.0` branch
  existed on `origin` (`gh pr list` empty), so the workflow's `prepare-pr` job
  never ran; the bump and its verification were done by hand.
- Ledgers cut first in `docs/fix/issue-45-pi-sdk-1-6-0/SPEC.md` (S1 verbatim,
  O1–O10, PE-001–PE-009, A1–A6) with the upstream surface comparison recorded
  as evidence: pi-ai `index.d.ts` / `compat.d.ts` / `api/openai-completions.d.ts`
  and pi-coding-agent `index.d.ts` are byte-identical to 1.5.1.
- `test/pi-ai-1-6-0-contract.test.ts` pins the four behaviors this package
  cares about across the bump: the `system` role survives the
  `supportsDeveloperRole` default flip (#10741), a flat
  `usage.reasoning_tokens` is counted, no NaN request carries `strict` tool
  schemas, and NaN's mid-stream drop texts are retryable (#12064, #12128).
- `package.json`: devDependencies 1.5.1 → 1.6.0, version 1.5.8 → 1.6.0 (pi
  minor realign), peer range unchanged at `^1.4.0`; `bun.lock` follows.
- Docs in-change: README EN/ES verified-against line + badges, CHANGELOG 1.6.0
  with the compatibility report, AGENTS.md verified-facts bullet + README
  maintenance rule.

**Checks**

- RED: `bun test test/pi-ai-1-6-0-contract.test.ts` on the pinned 1.5.1 →
  `6 pass / 6 fail` (flat reasoning token + all five new retry wordings).
- Green on 1.6.0: same suite → `12 pass / 0 fail / 28 expect`.
- `bun test` → 477 pass / 0 fail / 2185 expect / 40 files;
  `bun run typecheck` → exit 0.
- Differential: canonical payload dump of every catalog model ×
  `off`/`low`/`max` (tool history + thinking blocks) is byte-identical between
  1.5.1 and 1.6.0 — `sha256 7179c57b…` for both dumps. No NaN wire change.

**Next**

- Owner verdict on the two commits; nothing pushed, no GitHub comment posted.
- Pre-existing (not this change): README badges said 1.5.9 while `package.json`
  was 1.5.8 — both now say 1.6.0; `README.es.md:408` starts a prose line with
  `#35`, which `rg '^#{2,4} '` reads as a heading (identical at base).

## 2026-11-23 — issue #47: exported typed model-facts catalog (1.6.1)

**Done**

- Applied issue #47 inline. Intent resolved `proceed` (fresh unit, no prior
  phase state). Base resolved from state, not from `main`: `main` (`b8fcdd9`)
  is two commits behind `origin/chore/pi-sdk-1.6.0` (`6fcc0b1`), and npm
  already carries `1.6.0` published from that head, so the unit branches from it
  and cuts `1.6.1` — publishing from stale `main` would have gone backwards.
- The issue's open question 2 was the one real ambiguity: the 200,000-token
  cold ceiling is endpoint-wide, and the repo's own classifier says it is "NOT a
  model capability". Owner chose **A** (2026-11-23): per-model `"unmeasured"`
  plus `NAN_ENDPOINT_FACTS.coldCacheCeilingTokens` with its date and scope.
  Open questions 1 and 3 were settled by research, not assumption: the docs do
  distinguish "Tool calling (function calling)" from "Tool calling (XML
  format)", and S19/S20 pin `NAN_MODEL_FACTS` + `NanModelFacts` (no JSON
  snapshot — S20's is optional and no consumer pins one).
- Ledgers cut before code (`docs/fix/issue-47-model-facts-catalog/`, gitignored
  like every unit doc here): O1–O14, PE-001–PE-014, C1–C20.
- `src/model-facts-core.ts` owns the value unions, the `NAN_FACT_SOURCES`
  citation table, the builder guards and the deep freezer, and imports no
  catalog, so the generator can validate the entries it just built instead of a
  stale generated file. `scripts/model-facts.ts` holds the 13 declarations on
  the manual-override path; `src/model-facts.ts` builds and freezes the public
  record; `src/index.ts` exports it.
- `scripts/generate-models.ts` now fails the build when a catalog id has no
  declaration, a declaration names a ghost id, a value is outside its documented
  union, or a cell has no provenance id.
- Docs in-change: README EN/ES section + Features row, CHANGELOG 1.6.1,
  `package.json` 1.6.1, both badges, AGENTS bullet.

**Checks**

- RED: `bun test test/issue-47-model-facts.test.ts` → 0 pass / 1 fail / 1 error
  (`Cannot find module '../scripts/model-facts.ts'`) before implementation.
- Green: same suite → 52 pass / 0 fail / 822 expect.
- `bun test` → 529 pass / 0 fail / 3007 expect / 41 files (delta = exactly the
  52 new tests); `bun run typecheck` → exit 0.
- Differential against a `6fcc0b1` copy: `baselineModels` / `toModel` /
  `mergeLiveWithGenerated` capture identical after normalising the package
  version in `X-Pi-Provider` (the only diff, and it is the requested bump); base
  suite 477 pass / 0 fail.
- Scratch `bun run generate-models`: `model-facts catalog validated (13 models)`,
  and with one declaration renamed it exits 1, names both sides and does not
  rewrite the catalog. A real regeneration diff shows only `fetchedAt` and
  models.dev's renamed `extras.family` values — no capability value changed, so
  the committed catalog was left untouched.

**Next**

- Owner is the external verifier: two commits (`6020fbe` code+tests, `b0d4c41`
  docs+version), not pushed.
- Known follow-up surfaced by research, not folded here: `qwen3.8-flash`'s docs
  card still describes the pre-fix `max_tokens` exception (the `measured-36`
  probe contradicts it), and `qwen3.8-max`'s docs still state the same
  exception — worth reporting to NaN when the next docs pass happens.

## 2026-11-23 — issue #47 correction batch: receipt advisories folded (1.6.1)

**Done**

- Owner order (same standing text as the #35 batches): triage the 2026-11-23
  external-verify receipt (0 blockers, 4 advisories) and fix what deserves it.
  All four folded as one batch (D-47-02):
  - A1 `src/model-facts-core.ts` interface comment: dropped the false "NaN does
    not publish rate limits" premise — the docs' Rate limits section exists
    (checked 2026-11-23, 60 rpm/key + per-model concurrency) — and states the
    field's absence as the S18/C15 scope decision, keeping the "future field"
    note. Sibling sweep: the comment was the only surviving false claim;
    frozen S18 text in SPEC.md keeps its premise by its verbatim contract.
  - A2/A3 `planning-evidence.md` PE-001/PE-006 claim wording amended to the
    actual card bullets (deepseek-v4-flash: unqualified `Tool calling`) and
    rows (gemma4/qwen3.6 carry no Billing row; `credit-standard` rests on
    "Paid from your credits like every other chat model" + six larger rows).
    Exported values unchanged — none of the 13 declarations moved.
  - A4 `NAN_FACT_SOURCES` now `Object.freeze`d at declaration, red-first:
    one new corpus case failed alone before the freeze (52/1), passes after.
- Unit `decisions.md` created — it never existed at cut, which is why the
  checkpoint gate blocked the corpus edit: it now carries the required
  `path-protection-records@1` justification+approval rows and D-47-01
  reconstructed from the cut evidence (O13/C20 cited that id; it was dangling).

**Checks**

- RED: `bun test test/issue-47-model-facts.test.ts` → 52 pass / 1 fail (only
  the new frozen-citation case) before implementation.
- GREEN: same suite → 53 pass / 0 fail / 824 expect; `bun test` → 530 pass /
  0 fail / 3009 expect / 41 files (delta = the 1 new test); `bun run
  typecheck` → exit 0.
- Shared-code differential (the freeze lands in a generator import): scratch
  `bun run generate-models` → exit 0, `model-facts catalog validated (13
  models)`, regenerated-vs-committed diff identical in shape to the pre-batch
  scratch run (fetchedAt + models.dev family renames only). Live tree never
  touched by the generator.
- Validators re-run for the ledger: O13 rg pair exit 0, heading diff exit 0,
  C18 exit 0; READMEs/CHANGELOG/package.json untouched by this batch.
- No version move: npm latest is 1.6.0, the branch already carries the
  pending 1.6.1 — the batch rides the same unreleased patch.

**Next**

- Owner is the external verifier for this batch (correction bounds §9: one
  recheck of these four, no new cycle from a new finding).
- Carried follow-ups unchanged: docs still describe the pre-fix qwen3.8-flash /
  qwen3.8-max `max_tokens` exception; frozen S18 wording is stale but
  untouchable until the owner rewords the issue.

## 2026-11-24 — issue #49: per-attempt HTTP evidence for `/nan-debug` + emission-timestamped artifact

**Done**

- Applied issue #49 inline (unit `docs/fix/issue-49-nan-debug-http-attempts/`):
  intent `proceed`, ledgers O1–O22 / PE-001–PE-014 frozen, criteria C1–C26,
  RED corpus first, then implementation.
- New `src/http-attempts.ts`: wraps the provider api and injects
  `StreamOptions.fetch` (pi-ai 1.6.0's `createProvider` has no `fetch` option,
  so S15's premise was corrected). One `attempt` row per fetch — including
  pi-ai's retries and a 429 that never produced a gateway id — with status,
  whitelisted headers, ms timing, `attempt_n`, `payload_bytes`, request
  parameters and process-scoped inflight/60 s counters; one `response` row per
  completed request with `response_id`/`created`. Bounded to 50k lines,
  best-effort, local-only. Wired outermost in `src/provider-factory.ts`.
- `src/debug-report.ts`: `turns.jsonl` gains `created`/`status`/`attempt_n`/
  `request`; `errors.jsonl` gains `status`/`cf_ray`/`attempt_n` and the parsed
  gateway body (no transport or local path text); `http_attempts.jsonl` and
  `metadata.attempt_summary` added.
- Contract change: the default artifact carries no prompt/response/tool
  content; `--include-prompts`, `--include-tools`, `--all` opt in; `topic` is
  hashed; labels are MD5[:16]; `usage_window.json` stays out of the zip unless
  `--all`. Default names carry the emission timestamp UTC
  (`nan-debug-report-YYYY-MM-DDTHH:mm:ss`, zip `T…-…-…`).
- README EN/ES, CHANGELOG 1.6.2, `package.json` 1.6.2, AGENTS.md updated.

**Checks**

- RED before code: 0 pass / 3 fail / 3 errors (missing module).
- `bun test` → 567 pass / 0 fail / 3187 expect / 44 files; typecheck exit 0.
- Differential vs `42c8de1`: base 530/0/3009/41 + typecheck 0; head delta is
  exactly the 37 new tests (plus 2 ordered #35 cases), no base test lost.

**Next**

- Owner is the external verifier: verdict on the handoff. No open obligation
  rows; unit ledgers are on disk (docs/ is gitignored by owner decision).

## 2026-11-24 — issue #49 external verify + correction batch

**Done**

- External verify (read-only) on `feat/49-nan-debug-http-attempts`
  (base `42c8de1` → head `e1a5a81`): NEEDS-DECISION, 1 blocker + 6 advisories;
  receipt persisted in `docs/fix/issue-49-nan-debug-http-attempts/external-verify.md`.
- One §9 correction batch, red-first: the blocker test was added to
  `test/issue-49-debug-report.test.ts` (1 fail at line 445 before any `src/`
  change), then the artifact README claim was scoped at
  `src/debug-report.ts:1249` to "outside the opt-in `sessions/` transcripts"
  (raw by request; `cwd` guarantee kept documented) and C19's wording aligned.
- Advisories fixed in the same batch: stale #44 comment at
  `src/debug-report.ts:476`; vacuous old-path assertion at
  `test/issue-35-nan-debug-command.test.ts:254` re-pointed at
  `debugReportDirName(NOW)`; false base-count annotations corrected in the unit
  ledgers (Evidence O20/O22 rows, `decisions.md` path-protection, PE-011 —
  measured base is 13/52 with identical titles); O22's validator cell repaired
  (documents the `node_modules` symlink) and re-run green; `cwd` guarantee
  re-documented in README EN/ES, AGENTS and the artifact README.
- Not fixed, reported instead: `usage_window.json` default-zip direction vs
  S20 (decision-required, owner); root README absolute credentials claim
  (base-present at `42c8de1`).

**Checks**

- `bun test` → 568 pass / 0 fail / 3190 expect / 44 files; `bun run typecheck`
  → exit 0; O19 rg validators + README EN/ES header diff → exit 0.
- Repaired O22 validator cell verbatim → base copy 530 pass / 0 fail / 3009
  expect / 41 files, exit 0; head − base = +38 tests (37 handoff + 1 blocker).
- Rendered artifact README differential vs pre-fix: exactly the one scoped
  bullet, in both default and `--include-prompts` renders.

**Next**

- Owner delta-verifies the batch (blockers-only recheck); A5 awaits the
  owner's decision on the S20 direction.

## 2026-11-26 — issue #52: the session wedge is a malformed tool-call id, not the token estimate (1.6.4)

**Done**

- Resolved the intent as `mismatch` before touching code: the issue blames
  `estimateRequestTokens()`, but the transcript it cites reports **561,307**
  prompt tokens (`input` 2,075 + `cacheRead` 559,232) against a **1,048,576**
  window on the turn right before the first 400 — 53.5 % of the window. The
  estimator answers 625,484 for the same 2,170,428 payload bytes, i.e. it
  *over*-estimates at 3.867 real bytes/token, so the ÷2.0 correction the issue
  proposes would fabricate 1,085,214 tokens for a request that is nowhere near
  the ceiling. Escalated as one focused question with four concrete options
  instead of guessing; the owner answered "Create the PR", recorded as D-52-01
  (authority to ship the recommended repair).
- Root cause from primary sources: the gateway streamed
  `{"type":"toolCall","id":"","name":"","arguments":{}}`, pi persisted
  `"Tool  not found"` with `toolCallId: ""`, and pi-ai copies both ids verbatim
  into `tool_calls[].id` / `tool_call_id` — so every replay of the history was
  rejected, and only a compaction that dropped the pair recovered the session.
  All five `mimo-v2.6-flash` 400s share the ~2.17 MB payload growing 55–80 bytes
  per turn.
- `src/openai-compat-sanitizer.ts`: new `reconcileToolCalls` pass —
  empty `tool_calls[].id` ← the answering `tool_call_id`, else the deterministic
  `call_<name>_<messageIndex>_<callIndex>` fallback (replaces the process counter,
  so a replay does not invalidate the prefix cache); empty `function.name` →
  `function`; empty `tool_call_id` ← the announced call; a result with nothing to
  bind to is dropped. Real ids, `type !== "function"` grammar calls and every
  unrelated field are untouched.
- The overflow thresholds are deliberately unchanged;
  `src/context-overflow-classifier.ts` is not touched. New
  `test/issue-52-empty-tool-call-ids.test.ts` also pins the measurement so the
  ÷2.0 theory cannot be re-applied unnoticed.
- README EN/ES (sanitizer bullet + Features row + model-switch sentence),
  CHANGELOG 1.6.4, `package.json` 1.6.4, both badges, AGENTS.md bullet.

**Checks**

- `bun test` → 583 pass / 0 fail / 3248 expect / 45 files; `bun run typecheck`
  → exit 0.
- Base `47d09b1` copy (`git archive` in `mktemp`, `node_modules` symlinked) →
  571 pass / 0 fail / 3204 expect / 44 files + typecheck exit 0; delta is exactly
  the 12 new tests; no tracked test edited.
- RED first: the new suite was 6 pass / 6 fail before any `src/` change.
- Payload differential base vs head on four fixtures: only the phantom turn
  differs; healthy replay, content-toolCall and real-id orphan are byte-identical.

**Next**

- Owner verdict on the PR. The other three options from the scope question
  (repair + ÷2.0, issue-as-written, probe-first) remain a cheap re-cut if the
  owner wants them instead.

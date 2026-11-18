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

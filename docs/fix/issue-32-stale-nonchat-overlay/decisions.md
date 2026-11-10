# Issue #32 — Stale models-store.json keeps non-chat ids registered as chat models

https://github.com/gtrabanco/pi-nan-provider/issues/32 — intersection of #15
(non-chat ids filtered at live-merge time) and #19 (stale persisted catalog
corrected at read time): the read-time overlay corrects capabilities but never
drops non-chat ids, so a `models-store.json` written by a pre-#15 package
version keeps `kokoro`, `whisper`, `rerank`, `qwen3-embedding`, `flux-2-klein`,
`qwen-image-2.1` and `minimax-h3` registered as chat models, and a
`pi update --models` refresh does not clear them.

## Frozen request (verbatim)

- **S1**: "Apply to this repository: issue #32" — where issue #32 demands
  (verbatim): "Proposed fix: Drop `NON_CHAT_MODEL_IDS` in the read-time overlay
  (`withStaleCatalogOverlay`), the same place #19 already corrects stale
  capabilities, with a regression test that restores a stored `kokoro` entry
  and asserts it is absent from `getModels()`."
- **S1a** (quoted defect): "Non-chat ids (`kokoro`, `whisper`, `rerank`,
  `qwen3-embedding`, `flux-2-klein`, `qwen-image-2.1`, `minimax-h3`) still show
  up as chat models in pi when `models-store.json` was written by an older
  package version that predates #15. A model-catalog refresh does not clear
  them."
- **Assumption (marked as such)**: the issue's root-cause analysis is accurate —
  verified against current code before implementing (see PE-001); one addition
  the issue text does not state: `flux-2-klein` / `qwen-image-2.1` are
  legitimate **image** models, so the drop is limited to **chat-type** entries.

## Root cause (verified in code this session)

`withStaleCatalogOverlay` (`src/provider-factory.ts`) wraps `getModels()` /
`getAllModels()` with `applyOverlay` only. A pi-ai cache-only restore of a
pre-#15 store surfaces stored chat entries for non-chat ids verbatim: `kokoro`
has no overlay entry, so `applyOverlay` returns it unchanged and it registers
as a chat model. `mergeLiveWithGenerated` (#15) is bypassed by the restore.

## Planning evidence

| id | authority-kind | claim | source | freshness | affected-decision-or-obligation |
|---|---|---|---|---|---|
| PE-001 | code-read | `withStaleCatalogOverlay` maps but never filters; stored chat entries for non-chat ids pass through | `src/provider-factory.ts` (read this session) | current (main @ e37308c) | O1, O2 |
| PE-002 | pinned-contract | pi-ai 1.5.1 cache-only restore surfaces `context.stored.models` verbatim into read paths | `test/issue-19-stale-catalog-overlay.test.ts` (suite passes on pi-ai 1.5.1) | current (devDeps pi-ai 1.5.1) | O1 |
| PE-003 | code-read | `NON_CHAT_MODEL_IDS` holds exactly the seven non-chat ids and is the single runtime source of truth | `src/fetch-models.ts` (`NON_CHAT_MODEL_IDS`) | current | O2, O3 |
| PE-004 | code-read | `flux-2-klein` / `qwen-image-2.1` are baseline image models (`type: "image"`) registered via `baselineImageModels` | `src/fetch-models.ts` (`buildOverlayMap`, image branch) + `src/images.ts` | current | O3 |
| PE-005 | owner-workflow | unknown whether `pi update --models` should also rewrite the store (issue's open question) — not needed for this fix; the read-time drop wins regardless | issue #32 (reporter left it uninvestigated) | unknown | none — explicitly out of scope |

## Obligations

| obligation-id | authority-source | affected-use-case-or-invariant | phase | task | implementation-owner | validator | required-evidence | status |
|---|---|---|---|---|---|---|---|---|
| O1 | S1 (issue fix text) | A stored chat entry for `kokoro` (pre-#15 store) is absent from `getModels()` | P1 | RED regression test reproducing the restore of a stored `kokoro` chat entry | provider-factory maintainer | `bun test test/issue-32-stale-nonchat-overlay.test.ts` exits 0 with the kokoro-absence assertion | test run output in `## Evidence` | verified |
| O2 | S1a | All seven non-chat ids (`kokoro`, `whisper`, `rerank`, `qwen3-embedding`, `flux-2-klein`, `qwen-image-2.1`, `minimax-h3`) are dropped as **chat** entries on read paths | P1 | Filter non-chat chat-type entries in `withStaleCatalogOverlay` | provider-factory maintainer | `bun test test/issue-32-stale-nonchat-overlay.test.ts` exits 0 (all-seven assertion) | test run output in `## Evidence` | verified |
| O3 | PE-004 | Image models with non-chat ids remain registered (`type: "image"` entries are never dropped) | P1 | Filter keyed on chat-type only; assert image survival | provider-factory maintainer | `bun test test/issue-32-stale-nonchat-overlay.test.ts` exits 0 (image-survival assertion) | test run output in `## Evidence` | verified |
| O4 | #19 contract (store decides ids, catalog decides capabilities) | Ghost/uncatalogued stored chat ids still pass through; catalogued ids still get overlaid capabilities | P1 | Differential: existing overlay behavior unchanged | provider-factory maintainer | `bun test test/issue-19-stale-catalog-overlay.test.ts` exits 0 | test run output in `## Evidence` | verified |
| O5 | #15 contract | Generated baseline/live merge still excludes non-chat ids from the chat catalog | P1 | Differential: live-merge path unchanged | provider-factory maintainer | `bun test test/issue-15-non-chat-live-ids.test.ts` exits 0 | test run output in `## Evidence` | verified |
| O6 | repo gate (AGENTS.md) | Full suite + typecheck green; version bumped per policy | P2 | Gates + release bookkeeping (package 1.5.2, CHANGELOG) | maintainer | `bun test` exits 0 (322+ passing); `bun run typecheck` exits 0 | command outputs in `## Evidence` | verified |

## Acceptance criteria

- **AC-1 (S1/S1b)**: restoring a stored `kokoro` **chat** entry and calling
  `getModels()` yields no `kokoro` entry — proved by the regression test in
  `test/issue-32-stale-nonchat-overlay.test.ts`.
- **AC-2 (S1a)**: none of the seven `NON_CHAT_MODEL_IDS` appear as chat models
  after a stale-store restore — same test file.
- **AC-3 (assumption in S1)**: `flux-2-klein` / `qwen-image-2.1` survive as
  image models (`type: "image"`) — same test file.
- **AC-4 (no regressions)**: `bun test` and `bun run typecheck` exit 0 with the
  change applied, including the #15/#19 differential suites.

## Evidence

| id | obligation/criterion | command | observed result | date |
|---|---|---|---|---|
| E1 | O1/AC-1 (RED first) | `bun test test/issue-32-stale-nonchat-overlay.test.ts` (before implementation) | 2 fail / 1 pass — stored `kokoro` and the seven-id assertion reproduce the defect; image-survival pin already green | 2026-11-10 |
| E2 | O1, O2, O3 | `bun test test/issue-32-stale-nonchat-overlay.test.ts` | 3 pass / 0 fail after the read-path drop | 2026-11-10 |
| E3 | O4 | `bun test test/issue-19-stale-catalog-overlay.test.ts` | pass / 0 fail — overlay contract intact (one transient red mid-implementation was the inversion bug below, fixed, not deferred) | 2026-11-10 |
| E4 | O5 | `bun test test/issue-15-non-chat-live-ids.test.ts` | pass / 0 fail | 2026-11-10 |
| E5 | O6 | `bun test` | 336 pass / 0 fail, 1491 expect() calls, 31 files | 2026-11-10 |
| E6 | O6 | `bun run typecheck` | exits 0 (`bunx tsc --noEmit`, no output) | 2026-11-10 |
| E7 | O6 | version bump + CHANGELOG | `package.json` 1.5.1 → 1.5.2; `## [1.5.2]` entry added | 2026-11-10 |

## Log

- E1: unit dir created; ledgers frozen before first line of code.
- E2: RED corpus written and observed failing (2 fail / 1 pass) before implementation.
- E3: first implementation inverted the filter predicate semantics (`Array.filter` keeps truthy, the helper's `true` means "drop") — caught by the differential suites (#19 went 17-red); corrected to `.filter((m) => !isStoredNonChatChatEntry(m))`. The differential check did its job.
- E4: all gates green; obligations O1–O6 flipped to `verified` on foreground runs (E2–E7).

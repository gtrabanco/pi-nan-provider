# Session Log

Entries are appended at natural stopping points so the next session can pick up
the thread without re-reading git history.

## 2026-11-10 — issue #32: stale non-chat ids in models-store.json

**Done**

- Applied issue #32 through the owner's inline workflow (no lane machinery on
  the repo's own surgery): ledger freeze → RED corpus → differential
  implementation → gates.
- `withStaleCatalogOverlay` (`src/provider-factory.ts`) now drops chat-type
  entries whose id is in `NON_CHAT_MODEL_IDS` from `getModels()` /
  `getAllModels()`, so a pre-#15 `models-store.json` no longer registers
  `kokoro`, `whisper`, `rerank`, `qwen3-embedding`, `flux-2-klein`,
  `qwen-image-2.1`, `minimax-h3` as chat models. `type: "image"` entries are
  never dropped (flux-2-klein / qwen-image-2.1 stay image models).
- Regression suite `test/issue-32-stale-nonchat-overlay.test.ts` (RED observed
  before implementation); differential suites #15/#19 green.
- Release bookkeeping: package 1.5.1 → 1.5.2, CHANGELOG entry.

**Files touched**

- `src/provider-factory.ts` (the fix)
- `test/issue-32-stale-nonchat-overlay.test.ts` (new)
- `docs/fix/issue-32-stale-nonchat-overlay/decisions.md` (unit doc + ledgers)
- `package.json`, `CHANGELOG.md` (1.5.2)
- `docs/LOGS.md` (this entry)

**Decisions**

- Drop is keyed on the runtime source of truth (`NON_CHAT_MODEL_IDS`) and
  limited to chat-type entries — the issue's fix text did not call out that
  `flux-2-klein`/`qwen-image-2.1` are legitimate image models.
- The issue's open question (why `pi update --models` did not rewrite the
  store) stays out of scope: the read-time drop wins regardless.

**Next step**

- Owner review of the diff (external verifier); push/publish decision after
  the verdict.

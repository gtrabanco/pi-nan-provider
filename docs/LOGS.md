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

## 2026-11-11 — issue #34: qwen3.8-flash reasoning is unbounded by max_tokens

**Done**

- Applied issue #34 through the owner's inline workflow (no lane machinery on
  the repo's own surgery): ledger freeze → RED corpus → differential
  implementation → gates.
- NaN confirmed (2026-11-11) that on `qwen3.8-flash` `max_tokens` does not
  bound the reasoning phase and the excess bills the quota, while
  `max_completion_tokens` IS respected. The generated catalog now declares
  `compat.maxTokensField: "max_completion_tokens"` for that model only
  (ManualModelOverride gained the field; generator applies it in
  `buildCompat`), with a provenance note tracing to NaN's reply and the
  revert plan.
- `sanitizeOpenAICompatPayload` keeps its `max_completion_tokens → max_tokens`
  rename by default but exempts models whose effective compat asks for
  `max_completion_tokens` (new `preserveMaxCompletionTokens` option, wired
  from `model.compat.maxTokensField` in `wrapApiForStrictSanitization`).
- Acceptance suite `test/issue-34-max-completion-tokens.test.ts` (RED observed
  before implementation): wire test through the real provider against a mock
  gateway pins `max_completion_tokens` on qwen3.8-flash and `max_tokens` on
  the deepseek-v4-flash control; the catalog pin doubles as the revert
  tripwire. Differential: base-vs-changed sanitizer battery clean except the
  two intended opt-in cases.
- Release bookkeeping: package 1.5.2 → 1.5.3, CHANGELOG entry, README +
  README.es note updated.

**Files touched**

- `scripts/manual-overrides.ts`, `scripts/generate-models.ts`,
  `scripts/models.generated.ts` (catalog override + regeneration)
- `src/openai-compat-sanitizer.ts`, `src/provider-factory.ts` (rename gate)
- `test/issue-34-max-completion-tokens.test.ts` (new),
  `test/generated-catalog.test.ts` (compat-scoped override assertions)
- `README.md`, `README.es.md` (reasoning/maxTokens note)
- `package.json`, `CHANGELOG.md` (1.5.3)
- `docs/fix/issue-34-max-completion-tokens/SPEC.md`,
  `docs/fix/issue-34-max-completion-tokens/decisions.md` (unit doc + ledgers)
- `docs/LOGS.md` (this entry)

**Next step**

- Owner review of the branch `fix/34-qwen38-flash-max-completion-tokens`
  (single logical change, based on origin/main at #33). When NaN ships their
  gateway fix, remove the qwen3.8-flash `maxTokensField` override — the
  acceptance test will fail on purpose until then (revert is a docs-provenance
  refresh, not a code change).

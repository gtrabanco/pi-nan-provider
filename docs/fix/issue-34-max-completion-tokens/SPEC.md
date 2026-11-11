# Issue #34 — `qwen3.8-flash`: send `max_completion_tokens` as the interim reasoning bound

https://github.com/gtrabanco/pi-nan-provider/issues/34

NaN's maintainer-side reply (received **2026-11-11**, quoted verbatim in the issue):

> qwen3.8-flash: confirmado, `max_tokens` no limita el razonamiento y el exceso
> cuenta en la cuota. Ya tenemos el arreglo preparado; mientras llega, usa
> `max_completion_tokens`, que sí se respeta (ojo, el razonamiento puede
> gastárselo entero y dejar el content vacío).

`max_tokens` is inert on the reasoning path for `qwen3.8-flash` and the excess
bills against the quota (this explains the 796M tokens `qwen3.8-flash` showed
against its 500M cap in the `/v1/usage` survey of 2026-09-27). The catalog today
sends `maxTokensField: "max_tokens"` for every model (issue #20 caps at 32,768
for flash models), so the declared cap never bounds `qwen3.8-flash`'s reasoning.
The fix: `compat.maxTokensField: "max_completion_tokens"` for that one model,
with the sanitizer's `max_completion_tokens → max_tokens` rename gated per model
so the new field survives to the wire.

## Verbatim request (frozen)

- **S1**: "Apply to this repository: issue #34"
- **S2** (issue Proposal, sentence 1): "Send `max_completion_tokens` instead of
  `max_tokens` for `qwen3.8-flash` (at minimum) until NaN's fix lands."
- **S3** (issue Scope): "Conservative default: `qwen3.8-flash` only, extended if
  NaN's fix note says the bug is model-wide. Accepting `max_completion_tokens`
  on the other flash models is **unverified live** (permission-gated probe
  needed before extending)."
- **S4** (issue Mechanism): "Mechanism: per-model `maxTokensField` override in
  the generated catalog + a sanitizer/provider-factory rename, with provenance
  note dated 2026-11-11 (NaN maintainer confirmation). The no-fabrication rule
  applies: the value traces to NaN's reply, not to a docs URL."
- **S5** (issue Revert plan): "Revert plan: once NaN ships their fix, this
  override should be removed — note it in the entry so the revert is not
  forgotten."
- **S6** (issue Already covered): "The caveat NaN adds ("el razonamiento puede
  gastárselo entero y dejar el content vacío") is the exact signature the #21
  `reasoning-only-stream-guard` handles … No new work needed there."

## Acceptance criteria

One observable criterion per `S#`, each naming the check that proves it.

| id | S# | Criterion | Check |
| :--- | :--- | :--- | :--- |
| C1 | S1, S2 | A wire turn on `qwen3.8-flash` with an output cap sends `max_completion_tokens: 32768` and no `max_tokens`. | `bun test test/issue-34-max-completion-tokens.test.ts` exits 0 |
| C2 | S3 | Every other generated-catalog model keeps `maxTokensField: "max_tokens"` — the scope stays the one model NaN named; the wire test proves the previous `max_tokens` behavior holds on a control model. | `bun test test/issue-34-max-completion-tokens.test.ts` exits 0 |
| C3 | S4 | `scripts/manual-overrides.ts` declares `maxTokensField: "max_completion_tokens"` for `qwen3.8-flash` and it lands on the generated entry through regeneration, with a provenance note dated 2026-11-11 citing NaN's reply. | `bun test test/generated-catalog.test.ts` exits 0 |
| C4 | S5 | The entry's provenance note names the revert condition (remove the override once NaN ships their fix). | `bun test test/issue-34-max-completion-tokens.test.ts` exits 0 |
| C5 | S6 | No behavioral change is shipped for the reasoning-only-stream path (#21 stays untouched); the pre-existing #21 tests pass unchanged. | `bun test test/issue-21-reasoning-only-stream.test.ts` exits 0 |
| C6 | — | The full deterministic gate is green. | `bun test` and `bun run typecheck` exit 0 |

### Planning evidence

| id | authority-kind | claim | source | freshness | affected-decision-or-obligation |
| :--- | :--- | :--- | :--- | :--- | :--- |
| PE-001 | code-of-record | pi-ai's `openai-completions` buildRequest sends `params.max_tokens` when `compat.maxTokensField === "max_tokens"` and `params.max_completion_tokens` otherwise; `maxTokensField` is a real `OpenAICompletionsCompat` field in the pinned devDependency. | `node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js` (`if (compat.maxTokensField === "max_tokens")`) and `dist/providers/compat-schema.d.ts:69` — read in this checkout, devDependencies pins `@earendil-works/pi-ai` 1.5.1 | 2026-11-11 (this checkout) | O2, O5 |
| PE-002 | provider confirmation | `max_tokens` does not bound reasoning on `qwen3.8-flash`, the excess bills the quota, and `max_completion_tokens` IS respected as the interim bound. | NaN maintainer reply received 2026-11-11, quoted verbatim in issue #34 | 2026-11-11 | O1, O2, O3 |
| PE-003 | code-of-record | The sanitizer currently renames `max_completion_tokens` → `max_tokens` unconditionally (NaN's published schema documents only `max_tokens`); without gating it would undo the catalog change at the provider boundary. | `src/openai-compat-sanitizer.ts` comment "NaN documents `max_tokens`, not `max_completion_tokens`." + the rename block | 2026-11-11 (this checkout) | O4, O5 |
| PE-004 | measured (1 sample per case, 2026-11-11, maintainer-authorized live probe) | qwen3.6: `max_tokens=64` DOES bound the completion (completion=64, reasoning≤64) and `max_completion_tokens=64` is accepted (HTTP 200) and equally effective — no failure to fix there, the catalog's `max_tokens` stays correct. On `qwen3.8-flash` `max_tokens=64` left the completion unbounded (completion=790, reasoning=724 — live reproduction of the issue) while `max_completion_tokens=64` was honored (completion=64) and reproduced NaN's caveat: reasoning consumed the entire budget and content came back EMPTY (the #21 `reasoning_only_stream` signature). Remaining models not yet probed. | live gateway probe `/v1/chat/completions` (streaming, include_usage), matrix: {no param, max_tokens=64, max_completion_tokens=64} × {qwen3.8-flash, qwen3.6}, reasoning_effort low | 2026-11-11 | O3 (scope confirmed minimal: qwen3.6 needs no change) |
| PE-005 | code-of-record | GitHub issue evolved beyond the published schema: also `GET /v1/models` listed ids before docs (see repo history). The NaN reply counts as confirmation authority for a gateway behavior the published schema does not document, under the no-fabrication rule. | repo AGENTS.md "Every context-window, max-token … must trace to a source" + issue #34 | 2026-11-11 | O1 provenance note |

### Obligations

| obligation-id | authority-source | affected-use-case-or-invariant | phase | task | implementation-owner | validator | required-evidence | status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| O1 | S2, S4, PE-002 | qwen3.8-flash catalog entry: `compat.maxTokensField: "max_completion_tokens"`, provenance note dated 2026-11-11 citing NaN's reply, revert note (S5) present | P2 | override field in `ManualModelOverride`, generator compat merge, regenerate `scripts/models.generated.ts` | pi-nan-provider maintainers | `bun test test/generated-catalog.test.ts test/issue-34-max-completion-tokens.test.ts` exits 0 | test output lines in `## Evidence` | verified |
| O2 | S2, PE-001, PE-002 | wire request for qwen3.8-flash carries `max_completion_tokens` and no `max_tokens` (RED first: fails against the pre-change catalog) | P1 (RED) → P3 | end-to-end wire test through the real provider/Sanitizer path | pi-nan-provider maintainers | `bun test test/issue-34-max-completion-tokens.test.ts` exits 0 | test output lines in `## Evidence` | verified |
| O3 | S3, PE-004 | every other catalog model keeps `maxTokensField: "max_tokens"`; previous wire behavior (`max_tokens`) on a control model still holds; sanitizer default (no option) still renames unnamed-model payloads | P1/P2 | assertions in the new test + existing suite stays green | pi-nan-provider maintainers | `bun test test/openai-compat-sanitizer.test.ts test/issue-34-max-completion-tokens.test.ts` exits 0 | test output lines in `## Evidence` | verified |
| O4 | PE-003 | sanitizeOpenAICompatPayload WITHOUT the per-model option keeps the documented rename (backward compat for hand-built payloads and non-overridden models) | P3 | default-off option in the sanitizer; existing rename test untouched | pi-nan-provider maintainers | `bun test test/openai-compat-sanitizer.test.ts` exits 0 | test output lines in `## Evidence` | verified |
| O5 | S4, PE-001, PE-003 | provider-factory passes the model's effective `compat.maxTokensField` to the sanitizer so a `max_completion_tokens` model keeps the field after sanitization (including models.json overrides and the #19 overlay path, which re-derives compat from the generated catalog) | P3 | new `preserveMaxCompletionTokens` option wired from `model.compat.maxTokensField` in `wrapApiForStrictSanitization` | pi-nan-provider maintainers | `bun test test/issue-34-max-completion-tokens.test.ts test/issue-19-stale-catalog-overlay.test.ts` exits 0 | test output lines in `## Evidence` | verified |
| O6 | repo AGENTS.md verify-before-done | full suite and typecheck green on the changed tree | P4 | run both gates | pi-nan-provider maintainers | `bun test` exits 0; `bun run typecheck` exits 0 | command outputs in the handoff verification block | verified |

## Log

- 2026-11-11 — unit opened from issue #34; intent resolved `proceed` (fresh application; no prior phase state). Ledgers frozen at cut: obligations O1–O6 all `planned`.
- 2026-11-11 — P1: RED corpus `test/issue-34-max-completion-tokens.test.ts` observed failing 3/6 (catalog pin, wire contract, sanitizer opt-in); the 3 previous-behavior pins passed before any implementation change.
- 2026-11-11 — P2: `maxTokensField` override threaded through `ManualModelOverride` → `buildCompat` → regenerated `scripts/models.generated.ts`; regeneration diff touches only the qwen3.8-flash compat field, its note and the fetchedAt stamp (models.dev data unchanged).
- 2026-11-11 — P3: sanitizer `preserveMaxCompletionTokens` option (default off = old rename) + `modelSendsMaxCompletionTokens` wiring in `wrapApiForStrictSanitization`. A missed edit left the helper undefined and 5 issue-16 regression tests red for one working-tree state; caught by the full-suite gate before any commit — fixed in the same slice, never committed.
- 2026-11-11 — Differential check: base-commit sanitizer vs changed sanitizer over a 7-payload battery in `/tmp/diffsan` (scratch, removed afterwards) — identical everywhere except the two intended opt-in cases (`DIFFERENTIAL CLEAN`).
- 2026-11-11 — P4: README/README.es note updated, CHANGELOG 1.5.3, version bump, ledgers closed; all validators run in the foreground (see Evidence).
- 2026-11-11 — Live probe (maintainer-authorized in chat): the qwen3.8-flash failure reproduced with max_tokens=64 (completion=790 over a 64 cap, all reasoning) and bounded with max_completion_tokens=64 (completion=64, content empty — #21 signature). qwen3.6 measured: max_tokens works (completion=64) and max_completion_tokens is accepted (200) and equally effective — scope confirmed minimal, PE-004 updated.

## Evidence

| date | work | proof | checks |
| :--- | :--- | :--- | :--- |
| 2026-11-11 | RED corpus | `bun test test/issue-34-max-completion-tokens.test.ts` before implementation: `3 pass / 3 fail` — the 3 failures are the new contracts (catalog pin, qwen3.8-flash wire, sanitizer opt-in); the 3 passes are the previous-behavior pins (max_tokens control model, default rename) | ok |
| 2026-11-11 | O1 + O2 | `bun test test/generated-catalog.test.ts test/issue-34-max-completion-tokens.test.ts` → `Ran 26 tests across 2 files`, `0 fail` | ok |
| 2026-11-11 | O3 + O4 | `bun test test/openai-compat-sanitizer.test.ts test/issue-34-max-completion-tokens.test.ts` → `Ran 27 tests across 2 files`, `0 fail` | ok |
| 2026-11-11 | O5 | `bun test test/issue-34-max-completion-tokens.test.ts test/issue-19-stale-catalog-overlay.test.ts` → `Ran 21 tests across 2 files`, `0 fail` | ok |
| 2026-11-11 | C5 (#21 untouched) | `bun test test/issue-21-reasoning-only-stream.test.ts` → `Ran 13 tests across 1 file`, `0 fail` | ok |
| 2026-11-11 | O6 full gate | `bun test` → `342 pass, 0 fail, 1517 expect() calls, 32 files`; `bun run typecheck` → exit 0 | ok |
| 2026-11-11 | §6 differential | base-vs-changed sanitizer battery in `/tmp/diffsan`: 7 payloads, identical everywhere except the two intended opt-in cases — `DIFFERENTIAL CLEAN` | ok |

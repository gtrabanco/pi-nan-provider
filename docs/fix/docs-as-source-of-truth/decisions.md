# Docs as source of truth: catalog realignment + pi 1.2.0 upgrade — decisions

Issue #23 (auto-created by the weekly PI SDK version check) plus a
maintainer instruction that settles the catalog authority order.

## Authority order (maintainer instruction, 2026-10-14)

```text
1. Manual override, as long as the docs have not changed since it was written
2. https://nan.builders/docs/models        (the source of truth)
3. https://models.dev/api.json (provider "nan")
```

When the docs change and the manual override predates the change, the docs win
— but the override must be re-verified against the live gateway before it is
dropped, because a measured override usually encodes a real failure mode that
the docs may not describe.

models.dev is a downstream mirror: a human updates it later than the docs or a
Discord announcement, so a divergence is not by itself evidence the docs are
wrong.

## What changed

### 1. PI SDK devDependencies 1.0.0 → 1.2.0

Drop-in. `@earendil-works/pi-ai@1.2.0`'s `index.d.ts` is byte-identical to
1.0.0; additions are `KnownProvider` gaining `"azure"`, a new
`"openai-decisions"` classifier API, the `SamplingParams` /
`SamplingParamsByThinkingLevel` aliases, and an optional
`RefreshModelsContext.baseUrl`. `ThinkingLevelMap`, `ImageModel`, `ImageApi`,
`OpenAICompletionsCompat`, `createProvider`, `envApiKeyAuth`, and the MCP /
virtual-model registration methods are unchanged, and the `thinkingLevelMap.off`
branch still fires at `api/openai-completions.js` ~line 719. The peer range
`">=0.99.0 <2"` already covers 1.2.0, so it stays. Package version
`1.0.2 → 1.2.0` (MINOR realigns with the pi release line, per AGENTS.md).

### 2. Context windows follow the docs

The docs state "1M token context" for `deepseek-v4-flash`, `glm5.3-flash` and
`qwen3.8-flash`; models.dev lists the rounded 1,000,000 for the first two and
the stale 262,144 for `qwen3.8-flash`. Per the authority order the docs win, so
all three carry `contextWindow: 1_048_576` via `MANUAL_OVERRIDES`.

`qwen3.8-flash` was the only genuine value conflict: the docs explicitly write
"1M token context (1,048,576 tokens)" and "Max answer 131K tokens"
(https://nan.builders/docs/models, checked 2026-10-14). Its earlier override had
been withdrawn on 2026-09-07 because the docs then read "262K token context, the
model's native window" — the docs now say 1M, so the override is restored.

### 3. `glm5.3` gets documented capabilities on the live path

`glm5.3` stays out of the static baseline (premium-tier: a non-premium key must
never see a model it cannot call). It was previously registered live with the
blind `UNKNOWN_MODEL_LIMITS` placeholder (128K / 4K, text-only, no reasoning),
which contradicted the docs (1M context, multimodal text·image·audio·video,
reasoning). A new `LIVE_ONLY_MODEL_DATA` table in `src/fetch-models.ts` supplies
the documented values — applied both by `mergeLiveWithGenerated` (live `/models`
discovery) and by `buildOverlayMap` (stored-entry overlay). The store still
decides which ids exist; the table only decides their capabilities, so issue
#19's invariant is intact.

`thinkingLevelMap { off: "low" }` uses the docs' shallowest listed level.
`glm5.3` itself was never measured; `glm5.3-flash`'s measurement ("minimal") does
not transfer, and the docs list low as the floor for both.

### 4. `deepseek-v4-flash` reasoning: docs contradict a measurement

The docs (2026-10-14) document `reasoning_effort` for this model as "any value
(no effect) — the model decides per request how much to reason". Issue #16's
2026-09-27 measurement found the opposite at one end: `none` reproducibly gave
0 reasoning tokens and a full answer, while every other value (and omission)
left 13-14K reasoning tokens and `finish_reason: "length"` with no answer.

Per the authority order the docs would win, but this override is a measured
failure-mode fix: dropping it re-opens the issue #16 wedge. It is therefore kept
and the contradiction is recorded on the entry, pending a live re-probe. No
guessed value was introduced.

## Path-protection records

```text
path-protection-records@1
kind | paths | phase | date | authority | justification
justification | test/fetch-models.test.ts | P1 | 2026-10-14 | execute-phase | Assertions pinned the pre-realignment values (deepseek-v4-flash contextWindow 1_000_000) and used glm5.3 as the "unknown live id" example. Updated to the documented 1_048_576 and moved the unknown-path example to synthetic uncatalogued ids; a new test asserts the live-only documented path. No assertion weakened or deleted.
justification | test/generated-catalog.test.ts | P1 | 2026-10-14 | execute-phase | Two tests pinned the withdrawn qwen3.8-flash 262K override and the "no glm5.3-flash contextWindow override" state. Rewritten to assert the documented 1,048,576 plus the new provenance note; assertions are stricter (note content is now checked), not weaker.
justification | test/issue-19-stale-catalog-overlay.test.ts | P1 | 2026-10-14 | execute-phase | The "stored glm5.3 passes through as-is" test encoded the pre-live-only-data contract. Rewritten to assert the documented capabilities are overlaid onto a stale store entry; the issue #19 invariant (the store decides which ids exist) is unchanged and still covered by the neighbouring ghost-id test.
justification | test/issue-20-max-tokens-ceiling.test.ts | P1 | 2026-10-14 | execute-phase | contextWindow expectations 1_000_000 → 1_048_576 in two assertions; the maxTokens ceiling under test is untouched.
justification | test/issue-16-thinking-level-map.test.ts | P1 | 2026-10-14 | execute-phase | Added one test asserting the live-verified mimo-v2.6-flash thinkingLevelMap {off:"none"} (none 0 / low 22 / omitted 17 reasoning tokens, probed 2026-10-14). No existing assertion changed.
```

## Live probe (2026-10-14)

Ran to settle the `deepseek-v4-flash` contradiction between the docs ("any value
(no effect)") and issue #16's 2026-09-27 measurement. Short prompt,
`max_tokens: 2048`, streaming with `include_usage`; reasoning tokens from the
usage chunk, reasoning chars from `delta.reasoning_content`.

| model | `none` | `low` | omitted |
| :--- | :--- | :--- | :--- |
| `deepseek-v4-flash` | **0** r-tokens, 134-char answer | 57 r-tokens | 63 r-tokens |
| `mimo-v2.6-flash` | **0** | 22 | 17 |
| `qwen3.6` | **0** | 951 | 905 |

A follow-up single sample gave `deepseek-v4-flash` + `minimal` = 109 reasoning
tokens, so only `none` suppresses. The three-model agreement settles it: `none`
disables reasoning, every other value leaves it on. The docs are stale on this
point and the measurement wins (maintainer instruction), so the catalog keeps
`deepseek-v4-flash` / `thinkingLevelMap { off: "none" }` and gains
`mimo-v2.6-flash` / `thinkingLevelMap { off: "none" }`.

Total spend: 10 short requests, well under 50k tokens, mostly cached input.


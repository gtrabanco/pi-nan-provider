# Issue #16 — thinkingLevelMap for reasoning suppression (gap closure)

The 0.10.2 fix declared `thinkingLevelMap` for `deepseek-v4-flash` and
`glm5.3-flash` only. The NaN docs contract (https://nan.builders/docs/models
#controlling-reasoning, checked 2026-10-01) is explicit that `qwen3.6` and
`gemma4` reason by default (16,384-token budget) when no `reasoning_effort` is
sent, while `none`/`minimal` skip the reasoning phase entirely. pi maps
`thinking: "off"` to `reasoningEffort: undefined`, so those two models reasoned
even with thinking off — the same class of bug issue #16 fixes. This unit adds
`thinkingLevelMap: { off: "none" }` for both.

## Path-protection records

Append-only rows the checkpoint gate verifies. See the `path-protection-records@1`
grammar in the turn contract.

```text
path-protection-records@1
kind | paths | phase | date | authority | justification
justification | test/issue-16-thinking-level-map.test.ts | P1 | 2026-10-01 | execute-phase | The prior test pinned qwen3.6 as having NO thinkingLevelMap and sending no reasoning_effort when off — that is the gap, not the contract. Replace it with qwen3.8-flash (depth genuinely not adjustable) and add wire tests asserting qwen3.6/gemma4 send reasoning_effort:"none" when off. The change corrects a wrong expectation; it does not weaken an assertion.
justification | test/generated-catalog.test.ts | P2 | 2026-10-01 | execute-phase | Add catalog-contract assertions that qwen3.6 and gemma4 carry thinkingLevelMap.off="none" with the docs provenance note; the existing "every declared override lands on the generated entry" loop also now covers both.
justification | scripts/manual-overrides.ts | P3 | 2026-10-01 | execute-phase | Add the two MANUAL_OVERRIDES entries (qwen3.6, gemma4) with the docs-cited provenance note; required source of truth for the generated catalog.
justification | scripts/models.generated.ts | P4 | 2026-10-01 | execute-phase | Regenerated output of `bun run generate-models` after the override change; only the two thinkingLevelMap blocks, their notes, and the fetchedAt stamp differ.
```

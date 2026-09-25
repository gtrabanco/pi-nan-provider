# mimo-v2.6-flash catalog entry — decisions

NaN serves `mimo-v2.6-flash` (https://nan.builders/docs/models#mimo-v2-6-flash,
checked 2026-09-25) but models.dev's `nan` provider does not list it, so the
generated static catalog omits it and the live `/models` merge hands the model
`UNKNOWN_MODEL_LIMITS` (128,000 / 4,096, `reasoning: false`, text-only input)
— reported by the maintainer as "contexto de 128k".

## Path-protection records

Append-only rows the checkpoint gate verifies. See the `path-protection-records@1`
grammar in the turn contract.

```text
path-protection-records@1
kind | paths | phase | date | authority | justification
justification | test/generated-catalog.test.ts | P1 | 2026-09-25 | execute-phase | Extend the catalog contract for the official NaN chat model mimo-v2.6-flash: seven static ids, MANUAL_ONLY_MODELS entry values + provenance, absence-recorded fallback
justification | test/nan-usage-command.test.ts | P1 | 2026-09-25 | execute-phase | Assert the documented 1.0B monthly quota row for mimo-v2.6-flash in /nan-usage
justification | test/fetch-models.test.ts | P1 | 2026-09-25 | execute-phase | Regression: live /models ids for mimo-v2.6-flash must resolve to catalog capabilities, never the 128K unknown placeholder
```

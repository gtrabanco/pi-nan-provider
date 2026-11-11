# Issue #34 — decisions and path-protection records

Append-only rows the checkpoint gate verifies.

```text
path-protection-records@1
kind | paths | phase | date | authority | justification
justification | test/generated-catalog.test.ts | P2 | 2026-11-11 | execute-phase | The generic "every declared override lands on the generated entry" loop asserts `entry[field]` at the entry's top level; `maxTokensField` lives on `entry.compat`, so the loop gains a special case for compat-scoped fields. The assertion set is extended, not weakened.
justification | src/openai-compat-sanitizer.ts | P3 | 2026-11-11 | execute-phase | The unconditional `max_completion_tokens → max_tokens` rename (SanitizerOptions comment "NaN documents `max_tokens`, not `max_completion_tokens`") becomes opt-out per model via a new SanitizerOptions flag defaulted to the old behavior. Existing rename tests are untouched and must keep passing.
justification | test/issue-16-thinking-level-map.test.ts | P1 | 2026-11-11 | execute-phase | Not modified — cited as the test-fixture precedent (capturing mock gateway through the real provider). issue #34's RED test reuses the same pattern verbatim rather than diverging.
```

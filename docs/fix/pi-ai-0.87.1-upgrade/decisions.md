# pi-ai 0.87.1 upgrade — path-protection justifications (issue #13)

## Task: adapt test files for the new `TranscriptContext` stream API (0.84.4 → 0.87.1)

```text
path-protection-records@1
kind | paths | phase | date | authority | justification
justification | test/issue-2-truncated-stream.test.ts | P1 | 2026-09-29 | execute-phase | Adapt to pi-ai 0.87.1: replace raw Context literal with normalizeContext() wrapper in two stream() calls; no behavioral assertions changed
justification | test/issue-3-model-switch-overflow.test.ts | P1 | 2026-09-29 | execute-phase | Adapt to pi-ai 0.87.1: wrap raw Context in normalizeContext() inside runTurn() helper; no assertions changed
justification | test/issue-4-token-usage.test.ts | P1 | 2026-09-29 | execute-phase | Adapt to pi-ai 0.87.1: wrap raw Context in normalizeContext() inside runTurn() helper; no assertions changed
justification | test/issue-7-streaming-usage-default.test.ts | P1 | 2026-09-29 | execute-phase | Adapt to pi-ai 0.87.1: wrap raw Context in normalizeContext() inside runTurn() helper; no assertions changed
justification | test/openai-compat-sanitizer.test.ts | P1 | 2026-09-29 | execute-phase | Adapt to pi-ai 0.87.1: wrap raw Context in normalizeContext() inside captureRequest() helper; no assertions changed
justification | test/context-overflow-classifier.test.ts | P1 | 2026-09-29 | execute-phase | Add new test pinning estimateRequestTokens behavior against the new TranscriptContext shape produced by normalizeContext(); import normalizeContext from @earendil-works/pi-ai
```
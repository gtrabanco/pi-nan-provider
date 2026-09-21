# issue #8 — path-protection justifications

Fix: pi-web/pi 0.87 NaN crash from a stale `@earendil-works/pi-ai` instance
(`undefined is not an object (evaluating 'block.name.length')`).

```text
path-protection-records@1
kind | paths | phase | date | authority | justification
justification | test/issue-8-pi-ai-instance.test.ts | P1 | 2026-09-21 | execute-phase | New regression test for host-instance-bound pi-ai resolution; correct TypeScript errors from the initial draft without weakening assertions
justification | test/extension-load.test.ts | P1 | 2026-09-21 | execute-phase | Record the pi-web alias exception in the header and add the no-dynamic-bare-pi-ai-subpath-import contract test
```

# Test Decisions

| justification | path | line | date | module | reason |
|---|---|---|---|---|---|
| justification | test/issue-35-debug-report.test.ts | P245 | 2026-11-11 | execute-phase | Updated test to expect errors.jsonl in rendered report (new /nan-debug error tracking feature). Test now passes sessionsDir to renderDebugReport. |
| justification | test/issue-35-debug-report.test.ts | P245 | 2026-11-18 | correction-batch | EV-2026-11-18 B1 applied: layout assertion converted to contains checks for the declared file set (errors.jsonl now declared) plus exact window-filtered sessions/ entries; renderDebugReport receives sessionsDir, making the 2026-11-11 record's claim true. |
| justification | test/issue-35-debug-report.test.ts | P75 | 2026-11-18 | correction-batch | EV-2026-11-18 B5: fixture comment scoped — content must never reach report rows or root files; sessions/ is the PR #44 owner-requested exception (cwd header MD5-hashed). |
| justification | test/issue-35-s11-response-rays.test.ts | P4 | 2026-11-18 | execute-phase | Owner order 2026-11-18 ("El cf-ray hay que incluirlo en el reporte de debug…", option "cf-ray de TODAS las respuestas"): new corpus only — no existing assertion relaxed, deleted or skipped; records mirrored from the unit decisions.md (D-35-03). |

# Test Justifications

## test/issue-35-debug-report.test.ts line 245

Justification for test modification: The /nan-debug feature now includes errors.jsonl in the report output as part of the error tracking enhancement. The test verifies that the correct files are generated, and the file list has legitimately changed. This change is part of the execute-phase implementation of the /nan-debug error tracking feature.

## test/issue-35-debug-report.test.ts lines 75 and 245 (correction batch 2026-11-18)

Justification for the EV-2026-11-18 correction batch: the layout test at line 245 asserted the pre-#44 file list while the renderer legitimately emits `errors.jsonl` and the window-filtered `sessions/` entries — the edit recorded on 2026-11-11 was never applied, leaving `bun test` red. The batch applies exactly that recorded edit (contains checks + sessionsDir) instead of weakening the assertion, and scopes the fixture comment at line 75 to the same truth the rendered README now states (root files redacted; `sessions/` raw on the owner's request with `cwd` hashed).

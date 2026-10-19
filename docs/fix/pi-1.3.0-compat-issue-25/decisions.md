# pi 1.3.0 compat + SDK version-check automation (issue #25)

https://github.com/gtrabanco/pi-nan-provider/issues/25 — weekly PI SDK version
check found `@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` 1.3.0
(devDependencies were on 1.2.0). Compat verified 2026-10-15; see AGENTS.md
"pi 1.3.0 / pi-ai 1.3.0 compat" for the full fact list.

## Decisions

| decision | rationale |
| --- | --- |
| devDeps → 1.3.0; peer range stays `>=0.99.0 <2` | pi-ai 1.3.0 `compat.d.ts` and `api/openai-completions.d.ts` are byte-identical to 1.2.0; only the unused `utils/assistant-message-frame` re-export disappeared. Package version realigns to 1.3.0 (pi-line policy). |
| Cross-model thinking guard becomes VERSION-GATED (registers only while host pi-ai < 1.3.0) | pi-ai 1.3.0 ships the upstream fix for issue #3 (`transformMessages` drops cross-model thinking). Redundant code must not linger: the guard is marked DEPRECATED and is to be REMOVED in the next release after 1.3.0, whatever it is. Users on pi < 1.3.0 are advised to update pi. Unknown host version keeps the guard on (conservative older-pi default). |
| New `src/pi-ai-version.ts` resolves the host's pi-ai version | Reuses the host-anchored `resolvePiAiSpecifier` strategy from `src/pi-ai-loader.ts` (issue #8): an extension-relative resolve can return a stale copy. Name-checked walk-up to the package.json; fails soft to `undefined`. |
| New `test/pi-ai-contract.test.ts` pins upstream behaviors the package relies on | transformMessages cross-model drop (incl. signed/redacted) and the #10926 same-chunk reasoning+content ordering. Focused, well-messaged contract tests beat diagnosing upstream drift via unrelated acceptance failures. |
| Weekly SDK check now prepares a PR automatically | `scripts/prepare-sdk-update-pr.mjs` bumps devDeps and writes the PR body; the workflow runs `bun install && bun test && bun run typecheck`, attaches the type-surface diff, and opens the PR idempotently. Turns issue #25's manual "next steps" into review-a-PR. |

## Path-protection records

path-protection-records@1
kind | paths | phase | date | authority | justification
justification | test/pi-ai-version.test.ts | P1 | 2026-10-15 | execute-phase | New contract test for the runtime pi-ai version detection (src/pi-ai-version.ts) the version-gated cross-model guard depends on; authored in this same unit.
justification | test/pi-ai-contract.test.ts | P1 | 2026-10-15 | execute-phase | New contract test pinning the pi-ai 1.3.0 behaviors this package relies on (transformMessages cross-model drop, #10926 same-chunk ordering); authored in this same unit.
justification | test/cross-model-thinking-guard.test.ts | P1 | 2026-10-15 | execute-phase | Extended with the version-gate coverage (crossModelThinkingGuardCovers, gated registration) required by the guard's new pi-ai < 1.3.0 registration policy.
justification | test/issue-3-model-switch-overflow.test.ts | P1 | 2026-10-15 | execute-phase | Re-pointed to the pi-ai 1.3.0 upstream reality: thinking scenario pins pi-ai's own drop; the opaque-400 reclassification contract now exercised via oversized user content; applyGuard pins piAiVersion 1.2.0.
```


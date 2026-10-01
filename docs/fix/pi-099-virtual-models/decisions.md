# pi 0.99 virtual models — cross-model guard exemption

pi 0.99 adds virtual models: a selectable catalog entry (api `pi-virtual`) whose
`route()` picks a physical model per request. Inside the extension `context`
hook, `ctx.model` is the **selection** (the virtual entry), never the routed
physical model — pi's own comment says "The selection stays in agent state;
only this request uses the routed model" (`core/virtual-models.js`,
`agent-session.js`). This package's cross-model thinking guard compares each
assistant message's `provider`/`api`/`model` against `ctx.model`; with a virtual
target the `api` (`pi-virtual`) never matches a physical message's
`openai-completions`, so every replayed thinking block was stripped — including
same-physical-model reasoning on a continuation, defeating the guard's
same-model promise and losing prompt-cache/thinking continuity. Fix: skip the
guard when the selected target is virtual (the routed physical target is not
exposed to the hook).

## Path-protection records

Append-only rows the checkpoint gate verifies. See the `path-protection-records@1`
grammar in the turn contract.

```text
path-protection-records@1
kind | paths | phase | date | authority | justification
justification | src/cross-model-thinking-guard.ts | P1 | 2026-10-01 | execute-phase | Exempt virtual-model selections from the guard; the hook cannot see the routed physical model, and comparing against the virtual entry stripped every reasoning block.
justification | test/cross-model-thinking-guard.test.ts | P2 | 2026-10-01 | execute-phase | Add unit tests: a virtual target returns the same array (no stripping) and the extension wiring does not rewrite context for a virtual nan selection. Existing physical-target assertions unchanged.
```

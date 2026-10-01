# Issue #18 — Large cold prompts → HTTP 524 `origin_response_timeout` wedge

https://github.com/gtrabanco/pi-nan-provider/issues/18 — triage, code-level
verification on pi 1.0.0 / pi-ai 1.0.0, and fix. The live measurements below
come from the issue itself (deterministic curl repro by the reporter,
2026-10-01); no additional live probes were run for the fix.

## Verdict

**Real endpoint behavior, not an outage**: a COLD prompt (unique filler, no
prompt cache) above roughly 208k tokens (~1 MB request body) does not produce a
first byte within Cloudflare's 120 s Proxy Read Timeout and the edge answers
`524 origin_response_timeout` (JSON body, or a Cloudflare HTML page for even
larger bodies). Measured: cold 208,036 tokens (~960 KB) → 200, TTFT 12.9 s;
~220k and ~286k tokens → 524 at ~126 s; identical sizes warm → 200 in ~10 s.

On pi 1.0.0 the wedge still exists: pi-ai lists `524` in
`RETRYABLE_PROVIDER_ERROR_PATTERN` (retrying an identical cold payload always
fails), `isContextOverflow()` matches nothing, and pi's compaction is a single
pass with no hard-truncation fallback.

## Fix

`src/context-overflow-classifier.ts` now has **two independent thresholds**:

- 400 branch (issue #3): rewrite when estimated input tokens > the model's
  `contextWindow` (conservative; a 400 may be schema-related).
- 524 branch: rewrite when estimated input tokens >
  `NAN_COLD_CACHE_CEILING_TOKENS` = **200,000** — the ceiling only, NOT the
  model window. A first implementation put a global
  `estimated <= contextWindow` early return before both branches, which made
  the 524 branch unreachable for the affected models (`deepseek-v4-flash`,
  `glm5.3-flash` declare 1,000,000): the issue's real case (675k tokens) sat
  under the window but over the ceiling. Spec correction documented in
  `test/issue-18-cold-cache-524.test.ts`; no assertion was weakened — two
  tests that codified the wrong premise were inverted.

The ceiling is deliberately conservative (5,964 tokens below the last-working
cold measurement) so the working path is unaffected; a 524 on a smaller request
stays a genuine transient retryable error. The declared catalog context windows
are NOT reduced — this is an endpoint behavior, not a model capability. The
rewrite message matches pi-ai's LiteLLM-style overflow pattern while stating
the truth (ceiling + declared window + original error preserved).

## Known limits

Compaction is a single pass: sessions that one compaction can bring under the
ceiling are rescued; sessions far above it still wedge (the compaction request
itself hits the same 524) — the same limitation as the #3 path. Upstream
hard-truncation fallback or a compact-with-different-model hook would be needed
for those; out of scope here.

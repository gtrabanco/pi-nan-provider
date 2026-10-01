# Decisions: Issue #14 — Stored Credential Resolution

## Test file path-protection justifications

justification | test/mcp-search.test.ts | P1 | 2026-09-30 | execute-phase | Update mockPi() to remove modelRegistry (index.ts no longer uses registry at registration time). Add test for stored credential from auth.json. Justification: the factory-time ExtensionAPI has no modelRegistry; stored credentials are resolved via readStoredCredential("nan"). Tests must verify auth.json-based registration.

justification | test/mcp-media.test.ts | P2 | 2026-09-30 | execute-phase | No structural change needed; existing tests already use env-based key which still works. Justification: media server now rejects empty keys — existing tests that set NAN_API_KEY still pass; new tests cover the stored-credential path and the no-key warn path (spy console.warn).

justification | test/nan-mcp-command.test.ts | P3 | 2026-09-30 | execute-phase | Extend fake commandCtx to include modelRegistry (used by the command handler). Fix statusMessage to thread ctx through and add missing await. Justification: /nan-mcp status must use ctx.modelRegistry (not pi.modelRegistry) and fix [object Promise] output. New tests verify stored-credential + enable truthfulness.

## Final verification

Justification | docs/fix/issue-14-stored-credential/decisions.md | P4 | 2026-09-30 | execute-phase | Path-protection justification for the stored-credential fix. All changes trace to the verified fact: ExtensionAPI has no modelRegistry at factory time; stored credentials must be resolved via readStoredCredential("nan").

justification | test/mcp-media.test.ts | P5 | 2026-09-30 | execute-phase | Add regression tests for stored-credential auth and no-key warn behavior (console.warn spy). Justification: issue #14 gap-closing; media server now rejects empty keys, tests must cover auth.json path and warn-on-empty path.

justification | test/mcp-search.test.ts | P6 | 2026-09-30 | execute-phase | Add console.warn spy assertion to 'does NOT register when key missing' test. Justification: issue #14 gap-closing; web-search server warns when no key resolves.

justification | src/index.ts | P7 | 2026-09-30 | execute-phase | Remove dead code (void didWebSearch/didMedia) in registerMcpServersNative. Justification: issue #14 gap-closing; unused variables from assigning results of registerWebSearchMcpServer/registerMediaMcpServer.

## Verified Facts

- **Factory-time ExtensionAPI has NO modelRegistry** (verified pi 0.99.1): The ExtensionAPI interface (line 1138 in types.d.ts) does not include modelRegistry; it exists only on ExtensionContext (line 225) which is the ctx passed to command/event handlers.
- **readStoredCredential("nan") reads auth.json**: Public export of @earendil-works/pi-coding-agent. Signature: readStoredCredential(providerId: string, authPath?: string): Credential | undefined. Uses getAgentDir() by default (respects PI_CODING_AGENT_DIR).
- **Credential type**: union of ApiKeyCredential { type: "api_key", key?: string, env?: ProviderEnv } | OAuthCredential { type: "oauth", ... }. Guard: only use when type === "api_key" and key is a non-empty string.
- **Stored credential precedence**: stored credential first, then env fallback. This matches the existing resolveNanApiKey contract and pi's documented auth order (/login nan → auth.json before env var).
- **Existing resolveNanApiKey(registryKey) unchanged**: Used by /nan-usage and /nan-mcp command handler which has ctx.modelRegistry. The load-time path is separate (readStoredCredential at factory time).
- **No live network probes**: Tests use temp auth.json files in PI_CODING_AGENT_DIR. bunfig.toml preloads network-guard.ts.
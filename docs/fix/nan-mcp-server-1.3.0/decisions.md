# nan-mcp-server pin bump 1.1.2 → 1.3.0 — decisions

Issue #22 (auto-created by `scripts/check-nan-mcp-server.ts`): pinned `1.1.2`,
latest on npm `1.3.0`, verdict "safe to bump (non-breaking)".

## What changed upstream (verified 2026-10-12)

Extracted the tool surface from the published tarballs
(`npm pack nan-mcp-server@<v>` → `grep registerTool server.js`):

| Version | Tools |
| :--- | :--- |
| `1.1.2` | `generate_image`, `edit_image`, `text_to_speech`, `list_voices`, `speech_to_text`, `list_models`, `embed_text`, `rerank_documents` (8) |
| `1.3.0` | the eight above **plus** `get_quota` (9) |

Every bridged tool is still present; the only delta is the new `get_quota`
tool (read-only, free, third-party dashboard route `/api/usage/quota`).
Upstream changes between the pins: `chore(deps)` bumps (ip-address
10.4.0 → 10.7.2, minor-and-patch group), 1.1.3, 1.1.4 (lock advisories),
1.2.0, 1.3.0 ("start without a key so inspectors can read the catalog",
"add get_quota").

## Decisions

1. Bump `DEFAULT_NAN_MEDIA_MCP_VERSION` to `1.3.0` in
   `src/mcp/media-server.ts`. Because the bridge registers the whole
   `nan-media` server with `exposure: "direct"`, **every** upstream tool is
   exposed automatically — `get_quota` needs no bridging code, only a
   README/AGENTS row.
2. The issue's "To bump" step names `src/mcp/nan-media.ts`, which does not
   exist; the real constant lives in `src/mcp/media-server.ts`. The
   `renderIssueBody` hint in `scripts/check-nan-mcp-server.ts` is stale and
   fixed to the correct path.
3. Version `1.0.1 → 1.0.2` (PATCH): dependency pin bump + docs, no provider
   catalog or API-surface change.
4. No live gateway probe: the tool surface is read from the published source,
   and `get_quota` is free/read-only so nothing here spends quota on NaN.

## Path-protection records

```text
path-protection-records@1
kind | paths | phase | date | authority | justification
justification | test/mcp-media.test.ts | P1 | 2026-10-12 | execute-phase | Pin assertion follows the bumped DEFAULT_NAN_MEDIA_MCP_VERSION (1.1.2 → 1.3.0) inside the pre-existing default-registration test; no assertion weakened, only the expected pinned version updated to match the new constant
```

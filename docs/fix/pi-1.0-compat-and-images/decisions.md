# Decisions: pi 1.0.0 compatibility + native NaN image models

Unit: apply the pi 1.0.0 compatibility changes (peer range `>=0.99.0 <2`,
devDependencies 1.0.0, MCP tool-id documentation, MCP server `description`)
and add NaN's native image models (`flux-2-klein`, `qwen-image-2.1`) to the
provider, reachable from codemode `models.generateImages()` and from
extensions through `ctx.modelRegistry.generateImages()`.

## Test file path-protection records

```text
path-protection-records@1
kind | paths | phase | date | authority | justification
justification | test/nan-images.test.ts | P1 | 2026-10-01 | execute-phase | New test file authored first against the image-model contract (request shape for /images/generations and /images/edits, MIME sniffing, missing key, 403, abort, unsupported image input, empty input, empty payload, never-throws). Post-review correction: the authored file carried a stale @ts-expect-error on the src/images.ts import (the module now exists, so the directive became a compile error) and asserted the wrong display name for qwen-image-2.1 ("Qwen Image 2.1" instead of the models.dev name "Qwen-Image-2.1", checked 2026-10-01). Removing the obsolete directive and correcting the expected name keep every assertion intact; no expectation was weakened or deleted.
```

## Verified facts behind the change

- **pi-ai 1.0.0 is type-identical to 0.99.1** for this package: `dist/index.d.ts`,
  `dist/compat.d.ts` and `dist/types.d.ts` are byte-equal. The release only adds
  the `./models` subpath, Anthropic federation env constants, and a z.ai CN
  overflow pattern. The 254-test suite plus `bun run typecheck` pass against
  1.0.0 without source changes (verified 2026-10-01).
- **pi 1.0 image generation path**: `createProvider({ images })` sets
  `provider.generateImages`; pi's `composeModelProvider` delegates
  `base.generateImages` and uses `base.getAllModels()` (which includes
  `type: "image"` entries) while `getModels()` stays chat-only. pi-ai never
  applies `filterModels` to non-chat models (`getAllAvailable` line 331-332),
  so image availability is not tier-filtered by the live `/models` list; the
  gateway's 403 is the tier signal.
- **MCP tool-id sanitization**: since pi 0.99.2 `createMcpToolName` replaces
  every character except `[A-Za-z0-9_]` with `_`, so the tools are
  `mcp__nan_search__web_search` and `mcp__nan_media__*` (pi 0.99.0-0.99.1 kept
  the hyphens).
- **MCP `description`**: accepted by pi 0.99.2+/1.0; `validateMcpServerConfig`
  in 0.99.0-0.99.1 ignores unknown keys, so passing it stays compatible with
  the widened peer range.

# Contributing to @gtrabanco/pi-nan-provider

Thanks for contributing! Read [`AGENTS.md`](AGENTS.md) first — it contains the binding rules for this repo (the One Rule, no fabricated model metadata, one shared provider implementation, verified pi API facts, and the versioning policy). This document covers the mechanics.

## Setup

```bash
bun install
bun test          # all tests must pass
bunx tsc --noEmit # typecheck must be clean
```

The upstream contracts this package must follow live in pi's own docs (`docs/custom-provider.md`, `docs/packages.md` shipped with `@earendil-works/pi-coding-agent`) and in NaN's OpenAPI spec (`https://nan.builders/openapi.json`). Verify API surfaces against the installed `@earendil-works/pi-ai`/`pi-coding-agent` versions — doc snippets can be stale (see `AGENTS.md` for known corrections).

## Making changes

1. **Write/adjust tests first** for the behavior you are adding or fixing. Every source file has a matching test file — keep that true.
2. Implement the change; keep `nan` (and any future provider) behind the single shared factory in `src/provider-factory.ts`. A second provider-specific file is a smell.
3. Run the full gate before considering any task done:
   ```bash
   bun test && bunx tsc --noEmit
   ```
4. If you touched `scripts/generate-models.ts` or catalog-related logic, regenerate and commit the catalog:
   ```bash
   bun run generate-models
   ```
5. Never fabricate model metadata. Every context-window/max-token/modality/cost/compat value must trace to models.dev or an explicit `notes` entry stating where it was confirmed (URL + date).

## Versioning and releases (strict semver)

Every PR that changes code **must** bump `package.json`'s version in the same PR; CI only publishes when the version changed. The policy lives in `AGENTS.md`; the short version:

| Change | Bump |
|---|---|
| Docs, comments, catalog regeneration with identical values | PATCH |
| New feature (new provider, new MCP tool, new env var, new config option) | MINOR |
| Breaking change (renamed config, changed env var semantics, removed model/field/behavior) | MINOR while `0.x` (announced in the PR), MAJOR from `1.0.0` |
| Fixes | PATCH |

## Pull requests

- One logical change per PR; include tests and the version bump.
- CI (`publish.yml`) runs on merges to `main` touching `src/**`, `scripts/**`, `test/**`, or `package.json`: it regenerates the catalog, runs tests + typecheck, and publishes **only if the version differs from npm**. Docs-only merges never publish.
- Set the `NPM_TOKEN` repository secret before the first release (npm automation token with publish rights for `@gtrabanco`).

## Reporting issues

Include: pi version (`pi --version`), the extension version, what you expected vs what happened, and — for model data issues — the exact value in question plus its source. Model-data corrections should come with a source link so they can be encoded as provenance notes.
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.2] — 2026-09-07

### Changed

- **Catalog re-verified against NaN docs** (https://nan.builders/docs/models + openapi.json, 2026-09-07): `qwen3.8-flash` contextWindow reverted from 1M back to 262,144 (docs still say "262K token context, the model's native window"; models.dev agrees). Withdrawal recorded with full provenance note.
- `deepseek-v4-flash` override note strengthened — now cites both [NaN docs](https://nan.builders/docs/models) and the vision content-parts in [openapi.json](https://nan.builders/openapi.json).
- README tables updated: removed stale `glm5.2` row, corrected `qwen3.8-flash` to 262K, documented premium `glm5.3` placeholder behavior (EN + ES).

### Added

- **Provider-removed model guard**: `PROVIDER_REMOVED_MODEL_IDS` in the generator prevents regeneration from resurrecting models NaN removed (e.g. `glm5.2` — still listed by models.dev but absent from the official API model list).
- Premium `glm5.3` flagged as **unemittable** in catalog metadata — absent from models.dev and no source documents its max output tokens (no-fabrication rule). Premium keys still get it live via the `/models` refresh with conservative placeholders (128K context / 4K output).

### Fixed

- Catalog now matches the [official chat model list](https://nan.builders/openapi.json) (`model` parameter description): deepseek-v4-flash, mimo-v2.5, qwen3.8-flash, glm5.3-flash, qwen3.6, gemma4 (community) + glm5.3 (premium, unemittable).
- Test contract: catalog set, exclusion guards, and note provenance pinned to verified facts.

## [0.5.1] — 2026-09-05

### Changed

- Removed `glm5.2` from catalog (provider-removed).

## [0.5.0] — 2026-09-05

### Added

- Manual capability overrides via `MANUAL_OVERRIDES` with mandatory provenance notes (`scripts/manual-overrides.ts`).
- Support for pi >= 0.83 (forks using 0.83).
- New test: `extension-load.test.ts` — regression guard for the pi-ai aliasing failure.

### Fixed

- **Extension load failure under pi's pi-ai aliasing**: bare-root `@earendil-works/pi-ai` import + dynamic `resolveOpenAICompletionsApi` — works in bundled CLI, Node-mode jiti aliases, and compiled-binary virtualModules.

## [0.4.0] — 2026-09-04

- Initial public release of the nan provider package for pi.

[Unreleased]: https://github.com/gtrabanco/pi-nan-provider/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/gtrabanco/pi-nan-provider/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/gtrabanco/pi-nan-provider/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/gtrabanco/pi-nan-provider/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/gtrabanco/pi-nan-provider/releases/tag/v0.4.0
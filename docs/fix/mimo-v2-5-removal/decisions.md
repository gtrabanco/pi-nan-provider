# mimo-v2.5 removal + docs as the model-set authority — decisions

The `Publish` workflow failed at `bun run generate-models` (exit 1):

```text
generate-models: required models missing from models.dev provider "nan": mimo-v2.5
```

## What changed upstream (checked 2026-09-29)

| Source | `mimo-v2.5` | `mimo-v2.6-flash` | new non-chat entry |
| :--- | :--- | :--- | :--- |
| https://nan.builders/docs/models | 0 mentions | listed (1M / 1.0B monthly quota) | `qwen-image-2.1` (image generation) |
| https://nan.builders/openapi.json (`model` list) | 0 mentions | listed | `qwen-image-2.1` |
| https://models.dev/api.json provider `nan` | dropped | **listed** (1,048,576 / 131,072, text+image+audio) | `qwen-image-2.1` (`limit.output: 0`) |

`mimo-v2.6-flash` replaced `mimo-v2.5` (the docs no longer say "same limits as
mimo-v2.5"), and models.dev now documents `mimo-v2.6-flash` itself.

## Decisions

1. **The docs decide which ids exist** (maintainer instruction: "La fuente de
   verdad debe ser https://nan.builders/docs/models"); models.dev supplies the
   numeric limits. Recorded in `AGENTS.md` and in the `generate-models.ts`
   header.
2. `mimo-v2.5` → `PROVIDER_REMOVED_MODEL_IDS` (provenance note), dropped from
   `REQUIRED_MODEL_IDS`. No live gateway probe was run: the docs are the
   authority the maintainer named, and a probe would spend quota.
3. `REQUIRED_MODEL_IDS` is now the docs' community chat set
   (`qwen3.6`, `gemma4`, `deepseek-v4-flash`, `mimo-v2.6-flash`) and is checked
   against what reaches the catalog by *any* path, so a models.dev outage for
   one id can be covered by a manual-only entry instead of failing outright.
4. The manual-only loop now skips an id models.dev already provides and attaches
   the manual note to that entry — otherwise `mimo-v2.6-flash` would have been
   emitted twice (the generator had no dedup).
5. `qwen-image-2.1` → `NON_CHAT_MODEL_IDS`: an image-generation model with
   `limit.output: 0` must not be reported as "needs manual verification" on
   every regeneration.
6. `/nan-usage` loses the `mimo-v2.5` quota row: its only source was the docs,
   which no longer document the model.
7. Version `0.8.1 → 0.9.0` (MINOR, not PATCH): PATCH is reserved for catalog
   regenerations with *identical* values, and dropping a model changes the
   shipped catalog surface.

## Path-protection records

```text
path-protection-records@1
kind | paths | phase | date | authority | justification
justification | test/generated-catalog.test.ts | P1 | 2026-09-29 | execute-phase | Contract follows the docs: six static ids instead of seven (mimo-v2.5 removed by NaN, zero mentions in docs + openapi.json, checked 2026-09-29) and a NEW pin asserting mimo-v2.5 stays excluded with its provider-removed note (mirrors the glm5.2 pin)
justification | test/fetch-models.test.ts | P1 | 2026-09-29 | execute-phase | Founding-model limits now pin mimo-v2.6-flash (models.dev since 2026-09-29) instead of the removed mimo-v2.5, plus a NEW assertion that the baseline does not advertise mimo-v2.5
justification | test/nan-usage-command.test.ts | P1 | 2026-09-29 | execute-phase | Quota table drops mimo-v2.5 (docs no longer document it): the contains() assertion becomes a not.toContain() pin with the provenance comment
```

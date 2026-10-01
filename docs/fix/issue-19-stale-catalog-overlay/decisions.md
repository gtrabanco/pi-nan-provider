# Issue #19 — Stale persisted catalog shadows new capability data

https://github.com/gtrabanco/pi-nan-provider/issues/19 — triage, code-level
verification on pi 1.0.0 / pi-ai 1.0.0, and fix. The reporter's diagnosis was
reproduced at the code level; no live probes were needed.

## Verdict

**Real, and still present on pi 1.0.0.** pi-ai's `createProvider`-built
`refreshModels` restores `context.stored.models` verbatim in the cache-only
phase (`dynamicModels = restored` — a closure variable unreachable from
outside) and `currentModels()` lets a dynamic entry REPLACE the static baseline
entry with the same id+type. `ModelsStoreEntry` carries no version/staleness
signal, so a `~/.pi/agent/models-store.json` entry written by an older package
version (e.g. without `thinkingLevelMap`) keeps shadowing the newer generated
capability data for as long as its `checkedAt` is fresh — the #16 fix never
reached the registered model after upgrades.

pi's `ModelsImpl` resolves models exclusively via the provider object's
`getModels()` / `getAllModels()` (`model-runtime.js` → `this.models.getModels()`).

## Fix

Option (b) of the reporter, implementable fully provider-side:

- `src/fetch-models.ts` exports the overlay primitives: the generated chat
  catalog (chat ids) and the image baseline (image ids) are compiled ONCE into
  a lookup map (`buildOverlayMap`); `applyOverlay` replaces a model with its
  catalog entry when the id is known, in O(1) per read.
- `src/provider-factory.ts` wraps `getModels` AND `getAllModels`
  (`withStaleCatalogOverlay`) so every read path — including image models,
  which are only visible through `getAllModels` — sees catalog capability data.

Contract: **the persisted store decides which ids exist; the generated catalog
decides capability data.** Ids outside the catalog pass through untouched
(live-only premium `glm5.3`, ghost ids from old versions). `refreshModels` is
NOT overridden: the network phase already fetches and persists correct merged
data, and the overlay must not corrupt what pi persists. Option (a)
(version-stamping persisted entries) is not implementable provider-side: the
store write path belongs to pi-ai.

Result: upgrading the package takes effect immediately, without deleting the
persisted `nan` entry from `models-store.json`.

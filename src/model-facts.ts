/**
 * The public model-facts catalog (issue #47).
 *
 * A frozen, typed record keyed by model id: one entry per billed chat model,
 * facts only — what the model *is* (limits, modalities, cost rates, reasoning
 * contract, tool protocol, `max_tokens` semantics, thinking budget, cache mode,
 * billing class), never how a consumer should batch or route work.
 *
 * Derivation, and why the two-layer contract holds: the record is built from
 * the shipped generated catalog plus the manual facts layer, both of which are
 * baked at publish time. Reading it performs no network call, and it never
 * feeds back into provider registration — the read-time overlay
 * (`withStaleCatalogOverlay`, issue #19) stays the only thing that shapes the
 * pi models a session sees.
 *
 * Every cell is paired with a provenance id; `NAN_MODEL_FACTS_META.sources`
 * resolves it to a citation. The cold-prompt ceiling is the one number that is
 * not per-model by measurement, so it ships as `NAN_ENDPOINT_FACTS` instead.
 */

import { GENERATED_CATALOG_META, NAN_GENERATED_MODELS } from "../scripts/models.generated.ts";
import { MANUAL_OVERRIDES } from "../scripts/manual-overrides.ts";
import { MODEL_FACTS } from "../scripts/model-facts.ts";
import {
	buildModelFacts,
	freezeModelFacts,
	NAN_FACT_SOURCES,
	overrideFieldKeys,
	type ModelFactsBuildMeta,
	type NanEndpointFacts,
	type NanModelFacts,
	type NanModelFactsMeta,
} from "./model-facts-core.ts";

const BUILD_META: ModelFactsBuildMeta = {
	source: GENERATED_CATALOG_META.source,
	modelsDevProvider: GENERATED_CATALOG_META.modelsDevProvider,
	fetchedAt: GENERATED_CATALOG_META.fetchedAt,
	modelCount: GENERATED_CATALOG_META.modelCount,
};

/**
 * One entry per billed chat model, keyed by model id, deep-frozen.
 *
 * ```ts
 * import { NAN_MODEL_FACTS } from "@gtrabanco/pi-nan-provider";
 * const facts = NAN_MODEL_FACTS["deepseek-v4-flash"];
 * facts.contextWindow;     // 1048576
 * facts.toolCalling;       // "openai-tools"
 * facts.maxTokensSemantics // "bounds-total"
 * ```
 */
export const NAN_MODEL_FACTS: Readonly<Record<string, NanModelFacts>> = freezeModelFacts(
	buildModelFacts(NAN_GENERATED_MODELS, MODEL_FACTS, overrideFieldKeys(MANUAL_OVERRIDES), BUILD_META),
);

/**
 * The measured cold-prompt ceiling, which is endpoint-wide rather than a model
 * capability: Cloudflare's 120 s proxy read timeout answers HTTP 524 past it,
 * whatever model is called. Use it to size a first cold request; do not read it
 * as a per-model limit (every `coldCeilingTokens` cell stays `"unmeasured"`).
 */
export const NAN_ENDPOINT_FACTS: NanEndpointFacts = Object.freeze({
	coldCacheCeilingTokens: 200_000,
	coldCeilingMeasuredAt: "2026-10-01",
	coldCeilingScope:
		"endpoint-wide practical ceiling for cold (uncached) prompts — Cloudflare's 120 s proxy read timeout answers HTTP 524 past it, regardless of model; it is NOT a model capability, so no per-model coldCeilingTokens value is claimed",
	coldCeilingSources:
		"measured 2026-10-01 (issue #18): a cold 208,036-token prompt answered in 12.9 s; ~220,000 and ~286,000 tokens returned HTTP 524 origin_response_timeout at ~126 s. The shipped ceiling is the conservative 200,000 midpoint, not a measured boundary.",
});

/** Build stamp (models.dev fetch date) plus the provenance citation table. */
export const NAN_MODEL_FACTS_META: NanModelFactsMeta = Object.freeze({
	...BUILD_META,
	sources: NAN_FACT_SOURCES,
});

export { NAN_FACT_SOURCES };
export {
	CARRIED_FACT_CELLS,
	FACT_CELLS,
	NEW_FACT_CELLS,
	type ModelFactsBuildMeta,
	type ModelFactsDeclaration,
	type ModelFactsDeclarations,
	type NanBillingClass,
	type NanCacheMode,
	type NanEndpointFacts,
	type NanFactCell,
	type NanFactSource,
	type NanMaxTokensSemantics,
	type NanModelCostFact,
	type NanModelFacts,
	type NanModelFactsMeta,
	type NanThinkingBudget,
	type NanToolCalling,
	type NanTriState,
} from "./model-facts-core.ts";

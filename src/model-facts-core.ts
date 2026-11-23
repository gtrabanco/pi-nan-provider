/**
 * NaN model-facts schema, provenance table and builder (issue #47).
 *
 * The provider already knows the fleet's limits, but they live in prose and in
 * pi-only capability data. This module turns them into one typed record that a
 * consumer can read: facts only (what a model *is*), never policy (how a
 * consumer should batch or route work), and every cell carrying a provenance id
 * from the closed set below.
 *
 * Why a separate module from `src/model-facts.ts`: this file must stay free of
 * catalog imports so `scripts/generate-models.ts` can validate the freshly
 * generated entries before they are written. The public frozen record lives in
 * `src/model-facts.ts`, which imports the generated catalog and this builder.
 *
 * Provenance model: a cell's value is always paired with a `NanFactSource` id.
 * `NAN_FACT_SOURCES` resolves each id to its citation (URL and check date, or a
 * dated measurement already recorded in the repo). Three ids point into the
 * entry's own `notes` — `override`, `compat` and `catalog-cost` — because the
 * generated catalog already records those provenance notes there; duplicating
 * them per cell would fork the same truth into two places.
 */

import type { OpenAICompletionsCompat, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { GeneratedModelEntry } from "./fetch-models.ts";

// ── Documented value sets (membership-pinned) ───────────────────────────────

/** Tool protocol the model's tool calling rides on (docs `capabilities`). */
export type NanToolCalling = "openai-tools" | "xml" | "unmeasured";
export const NAN_TOOL_CALLING_VALUES: readonly NanToolCalling[] = ["openai-tools", "xml", "unmeasured"];

/** Whether `max_tokens` caps reasoning + answer, or only the visible answer. */
export type NanMaxTokensSemantics = "bounds-total" | "bounds-visible-answer" | "unmeasured";
export const NAN_MAX_TOKENS_SEMANTICS_VALUES: readonly NanMaxTokensSemantics[] = [
	"bounds-total",
	"bounds-visible-answer",
	"unmeasured",
];

/** Whether the gateway honours a `thinking_budget` on the model. */
export type NanThinkingBudget = "honoured" | "ignored" | "unmeasured";
export const NAN_THINKING_BUDGET_VALUES: readonly NanThinkingBudget[] = [
	"honoured",
	"ignored",
	"unmeasured",
];

/** Whether the prompt cache engages automatically or needs an opt-in. */
export type NanCacheMode = "automatic" | "opt-in" | "unsupported" | "unmeasured";
export const NAN_CACHE_MODE_VALUES: readonly NanCacheMode[] = [
	"automatic",
	"opt-in",
	"unsupported",
	"unmeasured",
];

/** How NaN bills the model: credits standard, credits faster (larger), or quota. */
export type NanBillingClass = "quota-only" | "credit-standard" | "credit-larger";
export const NAN_BILLING_CLASS_VALUES: readonly NanBillingClass[] = [
	"quota-only",
	"credit-standard",
	"credit-larger",
];

/** A tri-state capability fact: measured true, measured false, or not measured. */
export type NanTriState = boolean | "unmeasured";

// ── Provenance ──────────────────────────────────────────────────────────────

/**
 * Closed set of provenance ids. Every exported cell names one of these, and
 * `NAN_MODEL_FACTS_META.sources` resolves it for a consumer. Adding a fact
 * means adding a citation here first; a cell cannot be sourced from nowhere.
 */
export const NAN_FACT_SOURCES = Object.freeze({
	"models.dev":
		"https://models.dev/api.json, provider \"nan\" — the numeric limits, modalities and reasoning flag come from the generated catalog (fetch date in NAN_MODEL_FACTS_META.fetchedAt)",
	override:
		"scripts/manual-overrides.ts MANUAL_OVERRIDES — the value is a recorded override, and the entry's notes carry its per-model provenance note (source URL and date)",
	compat:
		"the shared NAN_COMPAT constant in scripts/generate-models.ts — the compat note in the entry's notes carries its provenance (2026-09-04 config, 2026-09-13 stream close, 2026-09-16 streaming usage)",
	"catalog-cost":
		"the shared NAN_CATALOG_COST constant in scripts/generate-models.ts — the cost note in the entry's notes records the credit-pool decision (NaN bills credits, not per-token USD)",
	docs: "https://nan.builders/docs/models (checked 2026-11-23)",
	"docs-reasoning": "https://nan.builders/docs/models#controlling-reasoning (checked 2026-11-23)",
	"docs-cross-model":
		"https://nan.builders/docs/models (checked 2026-11-23) — stated on the deepseek-v4-flash model card, which names the GLM models, qwen3.6 and gemma4",
	"model-guide": "https://nan.builders/model-guide (NaN community model guide, November 2026)",
	"measured-18":
		"issue #18 cold-prompt probe, 2026-10-01 — endpoint-wide (Cloudflare 120 s proxy read timeout), not a model capability",
	"measured-36":
		"issue #36 closing probe, 2026-11-18 — qwen3.8-flash with max_tokens=64 returned completion_tokens=64 (reasoning_tokens=64, empty content), so max_tokens bounds the total again",
	none: "no source: the cell is the \"unmeasured\" sentinel or a field the catalog does not declare; the entry's notes explain why",
} as const);

/** Provenance id of a single exported cell. */
export type NanFactSource = keyof typeof NAN_FACT_SOURCES;

// ── Cells ───────────────────────────────────────────────────────────────────

/** Cells the generated catalog already carried (issue #47, "already carried"). */
export const CARRIED_FACT_CELLS = [
	"contextWindow",
	"maxTokens",
	"input",
	"cost",
	"reasoning",
	"reasoningEffortValues",
	"thinkingLevelMap",
	"compat",
] as const;

/** Cells this issue promotes out of README prose into data. */
export const NEW_FACT_CELLS = [
	"toolCalling",
	"maxTokensSemantics",
	"thinkingBudget",
	"coldCeilingTokens",
	"cacheMode",
	"billingClass",
	"parallelToolCalls",
	"structuredOutput",
] as const;

/** Every exported fact cell. A record row carries one provenance id per entry. */
export const FACT_CELLS = [...CARRIED_FACT_CELLS, ...NEW_FACT_CELLS] as const;
export type NanCarriedFactCell = (typeof CARRIED_FACT_CELLS)[number];
export type NanNewFactCell = (typeof NEW_FACT_CELLS)[number];
export type NanFactCell = (typeof FACT_CELLS)[number];

// ── The exported record ─────────────────────────────────────────────────────

/** Cost rates the catalog carries (all pinned to 0 by the credit-pool decision). */
export interface NanModelCostFact {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * One model's facts. Plain data only: no pi Model object, no `api`/`baseUrl`,
 * no policy (batching, routing ladders), no rate limits — deliberately out of
 * scope per issue #47 (S18/C15): the docs publish rpm/concurrency figures
 * (checked 2026-11-23), so their absence here is the frozen scope decision,
 * and adding the field is a future owner decision.
 */
export interface NanModelFacts {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	input: readonly ("text" | "image")[];
	cost: Readonly<NanModelCostFact>;
	reasoning: boolean;
	/** Empty array = the effort parameter is accepted but depth is model-managed. */
	reasoningEffortValues: readonly string[];
	/** Empty map = no thinking level is mapped for this model. */
	thinkingLevelMap: Readonly<ThinkingLevelMap>;
	compat: Readonly<OpenAICompletionsCompat>;
	toolCalling: NanToolCalling;
	maxTokensSemantics: NanMaxTokensSemantics;
	thinkingBudget: NanThinkingBudget;
	/**
	 * Per-model cold-prompt ceiling. Always `"unmeasured"` today: the only
	 * measurement is endpoint-wide, so it ships as `NAN_ENDPOINT_FACTS` rather
	 * than as a per-model claim.
	 */
	coldCeilingTokens: number | "unmeasured";
	cacheMode: NanCacheMode;
	billingClass: NanBillingClass;
	parallelToolCalls: NanTriState;
	structuredOutput: NanTriState;
	/** One provenance id per exported cell. */
	provenance: Readonly<Record<NanFactCell, NanFactSource>>;
	/** The generated catalog's provenance notes (they carry the override/compat/cost citations). */
	notes: readonly string[];
}

/** Build-time metadata every facts record is stamped with. */
export interface ModelFactsBuildMeta {
	source: string;
	modelsDevProvider: string;
	fetchedAt: string;
	modelCount: number;
}

/** Public metadata: the build stamp plus the citation table. */
export interface NanModelFactsMeta extends ModelFactsBuildMeta {
	sources: typeof NAN_FACT_SOURCES;
}

/** The measured, endpoint-wide cold-prompt ceiling (not a model capability). */
export interface NanEndpointFacts {
	/** Conservative ceiling below the last working cold measurement (208,036 tokens). */
	coldCacheCeilingTokens: number;
	/** Date the cold probes ran. */
	coldCeilingMeasuredAt: string;
	/** What the number describes — never a per-model capability. */
	coldCeilingScope: string;
	/** The measurement itself, as recorded in the repo. */
	coldCeilingSources: string;
}

// ── The manual declaration a model must ship ────────────────────────────────

/**
 * The eight new facts plus one provenance id per fact. Declared per model in
 * `scripts/model-facts.ts` (the manual-override path), validated at generation
 * time and again when the public record is built.
 */
export interface ModelFactsDeclaration {
	toolCalling: NanToolCalling;
	maxTokensSemantics: NanMaxTokensSemantics;
	thinkingBudget: NanThinkingBudget;
	coldCeilingTokens: number | "unmeasured";
	cacheMode: NanCacheMode;
	billingClass: NanBillingClass;
	parallelToolCalls: NanTriState;
	structuredOutput: NanTriState;
	sources: Readonly<Record<NanNewFactCell, NanFactSource>>;
}

/** Declarations keyed by model id. */
export type ModelFactsDeclarations = Readonly<Record<string, ModelFactsDeclaration>>;

// ── Builder ─────────────────────────────────────────────────────────────────

/** The fields of an override entry that change a carried cell's provenance. */
const CARRIED_OVERRIDE_FIELDS = [
	"contextWindow",
	"maxTokens",
	"input",
	"reasoning",
	"cost",
	"reasoningEffortValues",
	"thinkingLevelMap",
	"maxTokensField",
] as const;

/**
 * Reduce an override map to the field names each model declares. Keeping this
 * as a key list (instead of the override objects) keeps this module free of a
 * runtime import from `scripts/`, so the generator can use it safely.
 */
export function overrideFieldKeys(
	overrides: Readonly<Record<string, object>>,
): Readonly<Record<string, readonly string[]>> {
	const keys: Record<string, readonly string[]> = {};
	for (const [id, override] of Object.entries(overrides)) {
		keys[id] = Object.keys(override);
	}
	return keys;
}

const VALUED_NEW_FACTS: Record<string, readonly unknown[]> = {
	toolCalling: NAN_TOOL_CALLING_VALUES,
	maxTokensSemantics: NAN_MAX_TOKENS_SEMANTICS_VALUES,
	thinkingBudget: NAN_THINKING_BUDGET_VALUES,
	cacheMode: NAN_CACHE_MODE_VALUES,
	billingClass: NAN_BILLING_CLASS_VALUES,
	parallelToolCalls: [true, false, "unmeasured"],
	structuredOutput: [true, false, "unmeasured"],
};

function validateDeclaration(
	id: string,
	declaration: ModelFactsDeclaration,
	problems: string[],
): void {
	for (const [cell, allowed] of Object.entries(VALUED_NEW_FACTS)) {
		const value = (declaration as unknown as Record<string, unknown>)[cell];
		if (!allowed.includes(value)) {
			problems.push(
				`model-facts: ${id}: ${cell} value ${JSON.stringify(value)} is not one of ${allowed
					.map((v) => JSON.stringify(v))
					.join(", ")}`,
			);
		}
	}
	const cold = declaration.coldCeilingTokens;
	if (cold !== "unmeasured" && !(typeof cold === "number" && Number.isFinite(cold) && cold > 0)) {
		problems.push(
			`model-facts: ${id}: coldCeilingTokens must be a positive number or "unmeasured" (got ${JSON.stringify(cold)})`,
		);
	}
	const sources = declaration.sources as Readonly<Record<string, unknown>> | undefined;
	for (const cell of NEW_FACT_CELLS) {
		const source = sources?.[cell];
		if (typeof source !== "string" || !Object.hasOwn(NAN_FACT_SOURCES, source)) {
			problems.push(
				`model-facts: ${id}: ${cell} has no provenance source (expected one of ${Object.keys(
					NAN_FACT_SOURCES,
				).join(", ")}, got ${JSON.stringify(source)})`,
			);
		}
	}
}

function carriedSource(
	declaredFields: readonly string[],
	field: (typeof CARRIED_OVERRIDE_FIELDS)[number],
	fallback: NanFactSource,
): NanFactSource {
	return declaredFields.includes(field) ? "override" : fallback;
}

/**
 * Build the per-model facts record from generated catalog entries plus the
 * manual declarations. Throws (aggregating every problem) when the catalog and
 * the declarations disagree, when a documented value is outside its union, or
 * when a cell has no provenance — the generator turns that throw into a
 * non-zero exit, so a published catalog can never carry an unsourced cell.
 */
export function buildModelFacts(
	entries: readonly GeneratedModelEntry[],
	declarations: ModelFactsDeclarations,
	overrideKeys: Readonly<Record<string, readonly string[]>>,
	meta: ModelFactsBuildMeta,
): Record<string, NanModelFacts> {
	const problems: string[] = [];
	const entryIds = new Set(entries.map((entry) => entry.id));

	for (const id of entryIds) {
		if (!Object.hasOwn(declarations, id)) {
			problems.push(`model-facts: ${id}: catalog model has no facts declaration in scripts/model-facts.ts`);
		}
	}
	for (const id of Object.keys(declarations)) {
		if (!entryIds.has(id)) {
			problems.push(`model-facts: ${id}: declared in scripts/model-facts.ts but absent from the catalog`);
		}
	}

	const record: Record<string, NanModelFacts> = {};
	for (const entry of [...entries].sort((a, b) => a.id.localeCompare(b.id))) {
		const declaration = declarations[entry.id];
		if (!declaration) continue; // already reported above
		validateDeclaration(entry.id, declaration, problems);

		const declaredFields = overrideKeys[entry.id] ?? [];
		const provenance: Record<NanFactCell, NanFactSource> = {
			contextWindow: carriedSource(declaredFields, "contextWindow", "models.dev"),
			maxTokens: carriedSource(declaredFields, "maxTokens", "models.dev"),
			input: carriedSource(declaredFields, "input", "models.dev"),
			reasoning: carriedSource(declaredFields, "reasoning", "models.dev"),
			cost: carriedSource(declaredFields, "cost", "catalog-cost"),
			compat: carriedSource(declaredFields, "maxTokensField", entry.compat ? "compat" : "none"),
			reasoningEffortValues: declaredFields.includes("reasoningEffortValues") ? "override" : "none",
			thinkingLevelMap: declaredFields.includes("thinkingLevelMap") ? "override" : "none",
			toolCalling: declaration.sources.toolCalling,
			maxTokensSemantics: declaration.sources.maxTokensSemantics,
			thinkingBudget: declaration.sources.thinkingBudget,
			coldCeilingTokens: declaration.sources.coldCeilingTokens,
			cacheMode: declaration.sources.cacheMode,
			billingClass: declaration.sources.billingClass,
			parallelToolCalls: declaration.sources.parallelToolCalls,
			structuredOutput: declaration.sources.structuredOutput,
		};

		// An `unmeasured` new-fact cell means "no claim". Sourcing it from a
		// document would read as a claim that the document says so.
		for (const cell of NEW_FACT_CELLS) {
			const value = declaration[cell];
			if (value === "unmeasured" && provenance[cell] !== "none") {
				problems.push(
					`model-facts: ${entry.id}: ${cell} is "unmeasured" but is sourced as ${JSON.stringify(
						provenance[cell],
					)} — an unmeasured cell carries no source`,
				);
			}
		}

		record[entry.id] = {
			id: entry.id,
			name: entry.name,
			contextWindow: entry.contextWindow,
			maxTokens: entry.maxTokens,
			input: [...entry.input],
			cost: { ...entry.cost },
			reasoning: entry.reasoning,
			reasoningEffortValues: [...(entry.reasoningEffortValues ?? [])],
			thinkingLevelMap: { ...(entry.thinkingLevelMap ?? {}) },
			compat: { ...(entry.compat ?? {}) },
			toolCalling: declaration.toolCalling,
			maxTokensSemantics: declaration.maxTokensSemantics,
			thinkingBudget: declaration.thinkingBudget,
			coldCeilingTokens: declaration.coldCeilingTokens,
			cacheMode: declaration.cacheMode,
			billingClass: declaration.billingClass,
			parallelToolCalls: declaration.parallelToolCalls,
			structuredOutput: declaration.structuredOutput,
			provenance,
			notes: [...(entry.notes ?? [])],
		};
	}

	if (problems.length > 0) {
		throw new Error(problems.join("\n"));
	}
	if (Object.keys(record).length !== meta.modelCount) {
		throw new Error(
			`model-facts: built ${Object.keys(record).length} entries but the catalog reports ${meta.modelCount}`,
		);
	}
	return record;
}

/** Deep-freeze the built record so a consumer cannot mutate another's view. */
export function freezeModelFacts(
	facts: Record<string, NanModelFacts>,
): Readonly<Record<string, NanModelFacts>> {
	for (const entry of Object.values(facts)) {
		Object.freeze(entry.cost);
		Object.freeze(entry.compat);
		Object.freeze(entry.input);
		Object.freeze(entry.reasoningEffortValues);
		Object.freeze(entry.thinkingLevelMap);
		Object.freeze(entry.provenance);
		Object.freeze(entry.notes);
		Object.freeze(entry);
	}
	return Object.freeze(facts);
}

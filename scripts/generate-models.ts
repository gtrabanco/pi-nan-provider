#!/usr/bin/env bun
/**
 * Build-time generation of the NaN-compatible fallback model catalog.
 *
 * Pulls base capability data (context window, max output tokens, modalities,
 * reasoning support, cost) from models.dev for the provider "nan" and emits
 * `scripts/models.generated.ts`, which is committed and bundled into the npm
 * package. Run before publishing (`bun run generate-models`, wired into
 * `prepublishOnly`).
 *
 * Provenance rules (enforced, not decorative):
 * - Every emitted number must come from models.dev or an explicit
 *   MANUAL_OVERRIDES note recording where it was confirmed. Nothing invented.
 * - The founding models (qwen3.6, gemma4, deepseek-v4-flash, mimo-v2.5) MUST
 *   exist on models.dev with complete limits, or this script exits non-zero.
 * - Any other models.dev entry missing `limit.context`/`limit.output` is
 *   skipped and flagged "needs manual verification" — never guessed.
 * - models.dev modalities are intersected with pi's supported input set
 *   ("text" | "image"); e.g. mimo-v2.5's audio input is not representable in
 *   pi's Model type and is dropped from `input` (noted on the entry).
 */

import type { GeneratedModelEntry } from "../src/fetch-models.ts";
import type { ManualModelOverride } from "./manual-overrides.ts";
import {
	MANUAL_OVERRIDES,
	MANUAL_ONLY_MODEL_IDS,
	REASONING_EFFORT_VALUES,
} from "./manual-overrides.ts";

/**
 * Reasoning effort values sourced from the NaN docs (https://nan.builders/docs/models
 * #controlling-reasoning, checked 2026-09-25). models.dev has no reasoning_effort_values
 * field — only reasoning_options which is [{type:"toggle"}] or [] — so the actual
 * effort levels must be hand-maintained from the docs. An empty array means the
 * parameter is accepted but depth is not adjustable by the user.
 */
const REASONING_EFFORT_VALUES_FROM_DOCS: Record<string, string[]> = {
	...REASONING_EFFORT_VALUES,
	// deepseek-v4-flash: any value (no effect) — model decides per request
	"deepseek-v4-flash": [],
	// qwen3.8-flash, mimo-v2.5: accepted, depth not adjustable
	"qwen3.8-flash": [],
	"mimo-v2.5": [],
};

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const SOURCE_PROVIDER_ID = "nan";
const FETCH_TIMEOUT_MS = 15_000;

/** Models the founding prompt requires in the catalog; absence is fatal. */
const REQUIRED_MODEL_IDS = ["qwen3.6", "gemma4", "deepseek-v4-flash", "mimo-v2.5"] as const;

/** pi's Model.input only supports these values. */
const PI_SUPPORTED_INPUT = new Set(["text", "image"]);

/**
 * Manual corrections over models.dev live in scripts/manual-overrides.ts
 * (shared with test/generated-catalog.test.ts, which pins that every
 * override lands on the generated entry with its provenance note).
 * Capability divergences from models.dev are recorded there, never here.
 * MANUAL_NOTES adds provenance-only notes to otherwise-untouched entries.
 */
const MANUAL_NOTES: Record<string, string> = {
	"qwen3.8-flash":
		"contextWindow 262,144: the earlier 1,000,000 override (maintainer-confirmed 2026-09-05) was withdrawn 2026-09-07 — the updated https://nan.builders/docs/models still states '262K token context, the model's native window' and models.dev agrees at 262,144; NaN docs are treated as the most reliable source (maintainer instruction, 2026-09-07).",
};

/**
 * Models the provider has removed but that models.dev may still list.
 * Excluded at generation time with the recorded reason — a regeneration must
 * never resurrect an entry the gateway no longer serves (this happened with
 * glm5.2: hand-removed 2026-09-05, models.dev re-listed it by 2026-09-07).
 */
const PROVIDER_REMOVED_MODEL_IDS: Record<string, string> = {
	"glm5.2":
		"removed by NaN (2026-09-05); absent from the official chat model list in https://nan.builders/openapi.json and https://nan.builders/docs/models (checked 2026-09-07) while models.dev provider nan still listed it — excluded so regeneration does not resurrect it",
};

/**
 * Premium/tier-gated models that models.dev documents but that are deliberately
 * kept OUT of the static fallback catalog. The static baseline is what pi
 * registers with zero network, and it must not advertise a premium model to a
 * key that cannot call it: NaN's live `/models` response is the tier
 * authority, so premium keys still receive these models through the live
 * refresh with conservative placeholder limits (UNKNOWN_MODEL_LIMITS).
 * Excluded at generation time with the recorded reason so a regeneration
 * cannot resurrect them into the baseline.
 */
const LIVE_ONLY_MODEL_IDS: Record<string, string> = {
	"glm5.3":
		"premium-tier model (models.dev now documents it with 1M context / 131,072 max output; NaN docs https://nan.builders/docs/models + https://nan.builders/openapi.json, checked 2026-09-13) kept live-only so a non-premium key never sees a model it cannot call when the live /models fetch is unavailable; premium keys still get it via the /models refresh with conservative placeholder limits",
};

/**
 * LiteLLM compat confirmed against the live api.nan.builders gateway by the
 * maintainer's working ~/.pi/agent/models.json config (2026-09-04) — the
 * config this package replaces. NaN's docs example instead sets only
 * `supportsDeveloperRole: true`, but the battle-tested config uses `false`
 * ("system" role; these open models sit behind vLLM/SGLang via LiteLLM, not
 * OpenAI's developer role), plus reasoning_effort forwarding, the classic
 * `max_tokens` field, and usage in streaming.
 */
const NAN_COMPAT = {
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	// NaN's published schema is silent about `stream_options`, but the live
	// gateway honors it (issue #7, measured 2026-09-16 on five chat models:
	// 0 usage chunks without the flag, exactly 1 with it). pi-ai only sends
	// `stream_options: { include_usage: true }` when this is not false, and the
	// sanitizer forwards it when the model declares true, so chat models opt in
	// by default and pi reports real token counts instead of zeros (issue #4).
	// A model that does not report streaming usage can still opt out per model
	// with a models.json compat override (`supportsUsageInStreaming: false`);
	// the sanitizer then strips `stream_options` and the payload stays strict.
	supportsUsageInStreaming: true,
	// The NaN/LiteLLM gateway intermittently closes SSE streams before emitting
	// `finish_reason`. With true, pi-ai raises "Stream ended without
	// finish_reason", which its retryable-provider pattern ("ended without")
	// matches, so the turn is retried automatically. With false, pi-ai
	// silently synthesizes stop/toolUse and the turn stalls mid-answer
	// (observed 2026-09-13 on glm5.3-flash; issue #2).
	supportsFinishReason: true,
	maxTokensField: "max_tokens" as const,
};

const NAN_COMPAT_NOTE =
	"compat matches the maintainer's working ~/.pi/agent/models.json LiteLLM config for api.nan.builders (2026-09-04): supportsDeveloperRole false, supportsReasoningEffort true, maxTokensField max_tokens. NaN's docs example sets only supportsDeveloperRole: true and is not battle-tested. supportsFinishReason true (2026-09-13, issue #2): the LiteLLM gateway intermittently closes SSE streams before emitting finish_reason; with true pi-ai raises 'Stream ended without finish_reason', which matches pi-ai's retryable-provider pattern ('ended without') and is retried automatically, whereas false silently synthesized stop/toolUse and stalled the turn mid-answer. supportsUsageInStreaming true (2026-09-16, issue #7): NaN's published schema is silent about stream_options, but the live gateway honors it — two identical streaming calls per model, differing only in stream_options: { include_usage: true }, returned 0 usage chunks without it and exactly 1 with it (prompt/completion/reasoning/cached token counts) on deepseek-v4-flash, glm5.3-flash, qwen3.6, mimo-v2.5 and gemma4, and a real pi session then recorded token counts where it recorded zeros. pi-ai only sends stream_options when this is not false, and the sanitizer forwards it when the model declares true, so chat models opt in by default and usage is reported (issue #4). A model that does not report streaming usage can still opt out per model with a models.json compat override (supportsUsageInStreaming: false); the sanitizer then strips stream_options and the payload stays strict.";

interface ModelsDevModel {
	id?: string;
	name?: string;
	reasoning?: boolean;
	modalities?: { input?: string[]; output?: string[] };
	limit?: { context?: number; output?: number };
	cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

interface ModelsDevProvider {
	models?: Record<string, ModelsDevModel>;
}

type ModelsDevCatalog = Record<string, ModelsDevProvider>;

interface GeneratedModel {
	entry: GeneratedModelEntry;
}

function fail(message: string): never {
	console.error(`generate-models: ${message}`);
	process.exit(1);
}

async function fetchModelsDevCatalog(): Promise<ModelsDevCatalog> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(MODELS_DEV_API_URL, {
			headers: { Accept: "application/json" },
			signal: controller.signal,
		});
		if (!response.ok) fail(`models.dev returned ${response.status} ${response.statusText}`);
		return (await response.json()) as ModelsDevCatalog;
	} catch (error) {
		fail(
			`failed to fetch ${MODELS_DEV_API_URL}: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		clearTimeout(timeoutId);
	}
}

function normalizeInput(modalitiesInput: string[] | undefined, modelId: string): ("text" | "image")[] {
	const input = (modalitiesInput ?? ["text"]).filter((value): value is "text" | "image" =>
		PI_SUPPORTED_INPUT.has(value),
	);
	if (!input.includes("text")) input.unshift("text");
	if (input.length === 0) fail(`model ${modelId}: modalities.input has no pi-representable values`);
	return input;
}

/**
 * Build a GeneratedModelEntry for a model that is not yet on models.dev
 * (MANUAL_ONLY_MODEL_IDS). Uses conservative but accurate defaults from the
 * NaN docs so that the live /models refresh does not hand them
 * UNKNOWN_MODEL_LIMITS.
 */
function buildManualOnlyModelEntry(
	modelId: string,
	detail: string,
	override: ManualModelOverride | undefined,
): GeneratedModel {
	const reasoningEffortValues =
		override?.reasoningEffortValues ??
		REASONING_EFFORT_VALUES_FROM_DOCS[modelId] ??
		undefined;

	return {
		entry: {
			id: modelId,
			name: override?.name ?? modelId,
			reasoning: override?.reasoning ?? true,
			input: override?.input ?? ["text", "image"],
			cost: override?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: override?.contextWindow ?? 1_048_576,
			maxTokens: override?.maxTokens ?? 131_072,
			reasoningEffortValues,
			compat: { ...NAN_COMPAT },
			notes: [
				NAN_COMPAT_NOTE,
				`manual-only: "${modelId}" not yet on models.dev provider nan (${detail}).`,
				...(override ? [override.note] : []),
			],
			extras: {},
		},
	};
}

function convertModel(modelId: string, m: ModelsDevModel): GeneratedModel | { skip: string } {
	const removedReason = PROVIDER_REMOVED_MODEL_IDS[modelId];
	if (removedReason) {
		return { skip: `provider-removed: "${modelId}" excluded from the catalog (${removedReason})` };
	}
	const liveOnlyReason = LIVE_ONLY_MODEL_IDS[modelId];
	if (liveOnlyReason) {
		return { skip: `live-only: "${modelId}" kept out of the static catalog (${liveOnlyReason})` };
	}
	const contextWindow = m.limit?.context;
	const maxTokens = m.limit?.output;
	if (typeof contextWindow !== "number" || contextWindow <= 0) {
		return { skip: `needs manual verification: models.dev has no limit.context for "${modelId}"` };
	}
	if (typeof maxTokens !== "number" || maxTokens <= 0) {
		return { skip: `needs manual verification: models.dev has no limit.output for "${modelId}"` };
	}

	const override = MANUAL_OVERRIDES[modelId];
	const input = override?.input ?? normalizeInput(m.modalities?.input, modelId);

	if (override) {
		const overridden = Object.keys(override).filter((key) => key !== "note");
		console.log(`generate-models: manual override for "${modelId}" (${overridden.join(", ")})`);
	}

	// Reasoning effort values sourced from the NaN docs (models.dev does not
	// expose them — only reasoning_options: [{type:"toggle"}] or []).
	// An empty array means the parameter is accepted but depth is not
	// adjustable by the user; the model manages its own reasoning depth.
	const reasoningEffortValues =
		override?.reasoningEffortValues ?? REASONING_EFFORT_VALUES_FROM_DOCS[modelId] ?? undefined;

	return {
		entry: {
			id: modelId,
			name: override?.name ?? m.name ?? modelId,
			reasoning: override?.reasoning ?? m.reasoning === true,
			input,
			cost: override?.cost ?? {
				input: m.cost?.input ?? 0,
				output: m.cost?.output ?? 0,
				cacheRead: m.cost?.cache_read ?? 0,
				cacheWrite: m.cost?.cache_write ?? 0,
			},
			contextWindow: override?.contextWindow ?? contextWindow,
			maxTokens: override?.maxTokens ?? maxTokens,
			reasoningEffortValues,
			compat: { ...NAN_COMPAT },
			notes: [
				NAN_COMPAT_NOTE,
				...(override ? [override.note] : []),
				...(MANUAL_NOTES[modelId] ? [MANUAL_NOTES[modelId]!] : []),
			],
			// Preserve every property models.dev documents for this model verbatim
			// (tier, quotas, release dates, reasoning options, attachments...).
			// Extras keep the UN-overridden models.dev data: they are the provenance
			// record of what models.dev says, not a capability claim.
			extras: m as unknown as Record<string, unknown>,
		},
	};
}

async function main(): Promise<void> {
	console.log(`Fetching models from ${MODELS_DEV_API_URL}...`);
	const catalog = await fetchModelsDevCatalog();
	const sourceProvider = catalog[SOURCE_PROVIDER_ID];
	if (!sourceProvider?.models) {
		fail(`models.dev has no provider "${SOURCE_PROVIDER_ID}" — cannot generate the catalog`);
	}

	const rawModels = Object.entries(sourceProvider.models);
	const entries: GeneratedModelEntry[] = [];
	const skipped: string[] = [];

	for (const [modelId, m] of rawModels) {
		const result = convertModel(modelId, m);
		if ("skip" in result) {
			skipped.push(result.skip);
			console.warn(`generate-models: skipped ${result.skip}`);
		} else {
			entries.push(result.entry);
		}
	}

	// Add manual-only models (not yet on models.dev).
	for (const [modelId, detail] of Object.entries(MANUAL_ONLY_MODEL_IDS)) {
		const override = MANUAL_OVERRIDES[modelId];
		if (override) {
			console.log(`generate-models: manual override for "${modelId}" (${Object.keys(override).filter((k) => k !== "note").join(", ")})`);
		}
		const result = buildManualOnlyModelEntry(modelId, detail, MANUAL_OVERRIDES[modelId]);
		entries.push(result.entry);
		console.log(`generate-models: added manual-only model "${modelId}"`);
	}

	entries.sort((a, b) => a.id.localeCompare(b.id));

	const entryIds = new Set(entries.map((entry) => entry.id));
	const missingRequired = REQUIRED_MODEL_IDS.filter((id) => !entryIds.has(id));
	if (missingRequired.length > 0) {
		fail(
			`required models missing from models.dev provider "${SOURCE_PROVIDER_ID}": ${missingRequired.join(", ")} — ` +
				"do NOT invent their data; confirm and add them via MANUAL_OVERRIDES with a source note.",
		);
	}

	const fetchedAt = new Date().toISOString();
	const allNotes = [
		...new Set([
			...skipped,
			// Record every exclusion unconditionally (not only when models.dev
			// still lists the id) so a regeneration can never drop the reason a
			// model is absent from the catalog.
			...Object.entries(PROVIDER_REMOVED_MODEL_IDS).map(
				([id, reason]) => `provider-removed: "${id}" excluded from the catalog (${reason})`,
			),
			...Object.entries(LIVE_ONLY_MODEL_IDS).map(
				([id, reason]) => `live-only: "${id}" kept out of the static catalog (${reason})`,
			),
			...entries.flatMap((entry) => entry.notes ?? []),
		]),
	];

	const generated = `// This file is auto-generated by scripts/generate-models.ts
// Do not edit manually — run \`bun run generate-models\` to update.
//
// Source: ${MODELS_DEV_API_URL} (provider "${SOURCE_PROVIDER_ID}"), fetched ${fetchedAt}
// Provenance: every contextWindow/maxTokens/input/cost value traces to
// models.dev or to the per-entry notes below. Nothing is invented; entries
// models.dev documents incompletely are omitted and flagged instead.
//
// NaN serves these via LiteLLM behind an OpenAI-compatible API; pricing is
// membership-quota based, which models.dev reports as zero per-token cost.

import type { GeneratedModelEntry } from "../src/fetch-models.ts";

export const NAN_GENERATED_MODELS: readonly GeneratedModelEntry[] = ${JSON.stringify(entries, null, "\t")};

export const GENERATED_CATALOG_META = {
	source: "${MODELS_DEV_API_URL}",
	modelsDevProvider: "${SOURCE_PROVIDER_ID}",
	fetchedAt: "${fetchedAt}",
	modelCount: ${entries.length},
	models: ${JSON.stringify(entries.map((entry) => entry.id))},
	notes: ${JSON.stringify(allNotes, null, "\t")},
} as const;
`;

	const outputPath = new URL("./models.generated.ts", import.meta.url).pathname;
	await Bun.write(outputPath, generated);
	console.log(`Wrote ${outputPath} (${entries.length} models: ${entries.map((e) => e.id).join(", ")})`);
	if (allNotes.length > 0) {
		console.log("Notes recorded in the generated file:");
		for (const note of allNotes) console.log(`  - ${note}`);
	}
}

await main();

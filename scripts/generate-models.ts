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
import { MANUAL_OVERRIDES } from "./manual-overrides.ts";

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
 * Capabilities diverging from models.dev are recorded there, never here.
 */
const MANUAL_NOTES: Record<string, string> = {};

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
	supportsUsageInStreaming: true,
	maxTokensField: "max_tokens" as const,
};

const NAN_COMPAT_NOTE =
	"compat matches the maintainer's working ~/.pi/agent/models.json LiteLLM config for api.nan.builders (2026-09-04): supportsDeveloperRole false, supportsReasoningEffort true, supportsUsageInStreaming true, maxTokensField max_tokens. NaN's docs example sets only supportsDeveloperRole: true and is not battle-tested.";

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

function convertModel(modelId: string, m: ModelsDevModel): GeneratedModel | { skip: string } {
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
		...skipped,
		...new Set(entries.flatMap((entry) => entry.notes ?? [])),
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

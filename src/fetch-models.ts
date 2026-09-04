/**
 * Runtime model catalog for NaN-compatible providers.
 *
 * Two layers, never either alone:
 *
 *  1. Build-time generated fallback — `scripts/models.generated.ts`, committed
 *     to the repo and regenerated pre-publish by `scripts/generate-models.ts`
 *     from models.dev. Every capability number in it traces to its source.
 *
 *  2. Runtime fetch of the provider's own `/models` endpoint. NaN runs
 *     LiteLLM behind an OpenAI-compatible facade, so the response carries
 *     only model `id`s — no capability fields. It is used solely to confirm
 *     which model IDs are currently live.
 *
 * Merge: live IDs × generated capability data. A live ID with no generated
 * match is kept with conservative placeholder limits (the same defaults used
 * in custom-provider.md's dynamic-discovery example) and no reasoning
 * support — capabilities stay "unknown", nothing is fabricated. On fetch
 * failure, timeout, or an unusable response, callers fall back to the
 * generated catalog so startup is never blocked.
 */

import type { Model, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { GENERATED_CATALOG_META, NAN_GENERATED_MODELS } from "../scripts/models.generated.ts";

export type { Model };

/**
 * Serializable model definition in the generated fallback catalog
 * (scripts/models.generated.ts). Lives here so the generator (scripts/) and
 * the runtime share one definition without a circular type alias.
 */
export interface GeneratedModelEntry {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	/** Compat applied to every NaN-compatible model (LiteLLM-confirmed, see scripts/generate-models.ts). */
	compat?: OpenAICompletionsCompat;
	/** Provenance notes for values overriding models.dev or needing manual confirmation. */
	notes?: string[];
}

/** pi-ai streaming API used for every NaN-compatible provider. */
export const NAN_COMPAT_API = "openai-completions" as const;

/**
 * Conservative limits for live IDs with no generated capability match.
 * Mirrors the `?? 128000` / `?? 4096` defaults in custom-provider.md's
 * dynamic-discovery example: a safe request envelope, not a capability claim.
 */
export const UNKNOWN_MODEL_LIMITS = { contextWindow: 128_000, maxTokens: 4_096 } as const;

/** Timeout for the live /models fetch; matches the pi-synthetic-provider precedent (~3s). */
export const DEFAULT_MODELS_TIMEOUT_MS = 3_000;

export interface CatalogSource {
	/** Provider id as registered in pi, e.g. "nan". */
	providerId: string;
	/** OpenAI-compatible base URL including version path, e.g. "https://api.nan.builders/v1". */
	baseUrl: string;
}

/** Convert a generated catalog entry into a pi-ai Model for the given provider. */
export function toModel(entry: GeneratedModelEntry, source: CatalogSource): Model<"openai-completions"> {
	return {
		id: entry.id,
		name: entry.name,
		api: NAN_COMPAT_API,
		provider: source.providerId,
		baseUrl: source.baseUrl,
		reasoning: entry.reasoning,
		input: [...entry.input],
		cost: { ...entry.cost },
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
		...(entry.compat ? { compat: { ...entry.compat } } : {}),
	};
}

/** The generated fallback catalog as pi-ai Models for the given provider. */
export function baselineModels(source: CatalogSource): Model<"openai-completions">[] {
	return NAN_GENERATED_MODELS.map((entry) => toModel(entry, source));
}

export interface LiveModelListOptions {
	baseUrl: string;
	/** Optional bearer key. NaN's /models returns 401 without one. */
	apiKey?: string;
	timeoutMs?: number;
	/** Injectable for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch;
}

/**
 * Fetch live model IDs from `{baseUrl}/models`.
 *
 * Returns `undefined` on any failure — non-OK status, timeout, malformed or
 * empty body — so callers fall back to the generated catalog instead of
 * failing startup. IDs are trimmed, de-duplicated, and order-preserving.
 */
export async function listLiveModelIds(options: LiveModelListOptions): Promise<string[] | undefined> {
	const { baseUrl, apiKey, timeoutMs = DEFAULT_MODELS_TIMEOUT_MS, fetchImpl = fetch } = options;

	const url = `${baseUrl.replace(/\/+$/, "")}/models`;
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(url, { headers, signal: controller.signal });
		if (!response.ok) return undefined;

		const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
		const rows = payload?.data;
		if (!Array.isArray(rows)) return undefined;

		const ids = rows
			.map((row) => (typeof row?.id === "string" ? row.id.trim() : ""))
			.filter((id) => id.length > 0);
		// An empty live list is indistinguishable from "endpoint unusable":
		// prefer the generated catalog over an empty registration.
		return ids.length > 0 ? [...new Set(ids)] : undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeoutId);
	}
}

export interface MergedCatalog {
	models: Model<"openai-completions">[];
	/** Live IDs resolved against generated capability data. */
	matched: string[];
	/** Live IDs kept with unknown capabilities (conservative limits). */
	unknown: string[];
}

/**
 * Merge live model IDs with the generated capability catalog.
 * Known IDs get generated data; unknown IDs get conservative placeholder
 * limits, `reasoning: false`, and zero cost — documented defaults, not
 * invented capabilities.
 */
export function mergeLiveWithGenerated(
	liveIds: readonly string[],
	source: CatalogSource,
	generated: readonly GeneratedModelEntry[] = NAN_GENERATED_MODELS,
): MergedCatalog {
	const byId = new Map(generated.map((entry) => [entry.id, entry]));
	const models: Model<"openai-completions">[] = [];
	const matched: string[] = [];
	const unknown: string[] = [];

	for (const id of liveIds) {
		const entry = byId.get(id);
		if (entry) {
			models.push(toModel(entry, source));
			matched.push(id);
		} else {
			models.push({
				id,
				name: id,
				api: NAN_COMPAT_API,
				provider: source.providerId,
				baseUrl: source.baseUrl,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: UNKNOWN_MODEL_LIMITS.contextWindow,
				maxTokens: UNKNOWN_MODEL_LIMITS.maxTokens,
			});
			unknown.push(id);
		}
	}

	return { models, matched, unknown };
}

export interface FetchModelsOptions {
	/** Bearer key for the live fetch, when one is already resolved. */
	apiKey?: string;
	timeoutMs?: number;
	/** Injectable for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch;
}

/**
 * `fetchModels` implementation handed to pi-ai's `createProvider`: live IDs ×
 * generated capability data, falling back to the generated catalog whenever
 * the live endpoint is unreachable, slow, non-OK, malformed, or empty —
 * startup is never blocked by the catalog fetch.
 */
export async function fetchNanCompatibleModels(
	source: CatalogSource,
	options: FetchModelsOptions = {},
): Promise<readonly Model<"openai-completions">[]> {
	const baseline = baselineModels(source);
	try {
		const liveIds = await listLiveModelIds({
			baseUrl: source.baseUrl,
			apiKey: options.apiKey,
			timeoutMs: options.timeoutMs,
			fetchImpl: options.fetchImpl,
		});
		if (!liveIds) return baseline;
		return mergeLiveWithGenerated(liveIds, source).models;
	} catch {
		return baseline;
	}
}

/** Metadata of the generated fallback catalog, for diagnostics and docs. */
export function generatedCatalogMeta() {
	return GENERATED_CATALOG_META;
}

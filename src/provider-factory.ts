/**
 * Shared factory for OpenAI-compatible providers registered from this package.
 *
 * One implementation, N provider configs. A second provider-specific source
 * file is a smell — add a config entry (see src/providers.ts) and, if needed,
 * catalog data, never a parallel implementation.
 *
 * The resulting provider follows pi-ai's built-in provider shape (see
 * `deepseekProvider()` in pi-ai): `createProvider` + `envApiKeyAuth` + the
 * openai-completions streaming API, with a `fetchModels` overlay that merges
 * the live /models listing with the generated fallback catalog.
 *
 * pi-ai import rule (see test/extension-load.test.ts): extensions must
 * statically import ONLY the bare `@earendil-works/pi-ai` root. pi's
 * extension loader maps that specifier to the compat entrypoint on every
 * supported runtime (bundled CLI, Node-mode aliases, compiled-binary
 * virtualModules; pi 0.83 through 0.87.1 alike), and compat re-exports every
 * lazy API factory. Subpath specifiers (`@earendil-works/pi-ai/api/...`) get the
 * alias applied as a prefix and resolve to `<compat.js>/api/...`, which does
 * not exist — the extension then fails to load entirely.
 *
 * Streaming API resolution: bare root under pi's compat alias is the instance
 * anchor; otherwise a file URL from import.meta.resolve; never a bare subpath
 * (loud failure — issue #8). Full logic in src/pi-ai-loader.ts.
 *
 * The provider also exposes NaN image models (flux-2-klein, qwen-image-2.1)
 * through an image API ("nan-images"): `baselineImageModels` are added to the
 * model set and a `ProviderImages` implementation is wired via
 * `createNanImagesApi`, so pi's model registry can route
 * `generateImages()` calls through it.
 */

import * as piAi from "@earendil-works/pi-ai";
import type {
	Provider,
	ProviderStreams,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { withContextOverflowClassification } from "./context-overflow-classifier.ts";
import { withReasoningOnlyStreamGuard } from "./reasoning-only-stream-guard.ts";
import { NAN_IMAGE_API, baselineImageModels, createNanImagesApi } from "./images.ts";
import {
	baselineModels,
	DEFAULT_MODELS_TIMEOUT_MS,
	resolveCatalog,
	type CatalogSource,
	overlayGeneratedCapabilities,
	buildOverlayMap,
	applyOverlay,
	type OverlayEntry,
	NAN_GENERATED_MODELS,
} from "./fetch-models.ts";
import { resolveOpenAICompletionsApi } from "./pi-ai-loader.ts";
import { sanitizeOpenAICompatPayload } from "./openai-compat-sanitizer.ts";

export interface OpenAICompatibleProviderConfig {
	/** Provider id as registered in pi, e.g. "nan". */
	id: string;
	/** Display name shown in /login and the model selector, e.g. "NaN". */
	name: string;
	/** OpenAI-compatible base URL including version path, e.g. "https://api.nan.builders/v1". */
	baseUrl: string;
	/** Env vars consulted (in order) when no credential is stored, e.g. ["NAN_API_KEY"]. */
	envVars: readonly string[];
}

export interface NanCompatibleProviderOptions {
	/** Timeout for the live /models fetch. Default: 3000ms. */
	timeoutMs?: number;
	/** Injectable for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch;
}

/**
 * Wrap an api so every outgoing `/chat/completions` payload is made conformant
 * to the strict OpenAI Chat Completions schema NaN enforces (see
 * ./openai-compat-sanitizer.ts). NaN returns HTTP 400 `Invalid request. Check
 * your request parameters.` for any payload that violates it — including a
 * replayed assistant message with a `toolCall` block inside `content`, a
 * `reasoning_details` field, or the undocumented top-level `store` field.
 * Sanitizing via the `onPayload` hook works regardless of
 * which pi-ai version the runtime bundles, so the fix is not tied to a
 * specific upstream build.
 *
 * `stream_options` is the one field whose removal is conditional: when the
 * model's effective `compat.supportsUsageInStreaming` is true (the catalog
 * default for chat models since issue #7, or a user `models.json` override),
 * pi-ai requested usage and the gateway will return it — stripping the field
 * would silently zero `message.usage` (issue #4). Every other model keeps the
 * strict payload.
 *
 * Any caller-supplied `onPayload` (e.g. pi's own debug/passthrough hook) is
 * preserved and chained AFTER sanitization, so the final payload is always
 * schema-valid.
 *
 * Note (pi-ai ≥ 0.86): this wrapper forwards the `TranscriptContext` parameter
 * unchanged and only rewrites `options.onPayload` — the `TranscriptContext`
 * migration (branded `TranscriptContext = { messages: Message[] }` replacing
 * `Context`) does not affect this function's behavior.
 */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Whether the model's effective compat asks pi-ai for streaming usage. pi-ai
 * emits `stream_options: { include_usage: true }` when this is not false, and
 * `models.json` overrides compose above the registered catalog, so this reads
 * the user's confirmed value rather than the generated default.
 */
function modelSupportsUsageInStreaming(model: unknown): boolean {
	if (!isObject(model)) return false;
	const compat = model.compat;
	return isObject(compat) && compat.supportsUsageInStreaming === true;
}

export function wrapApiForStrictSanitization(api: ProviderStreams): ProviderStreams {
	const withSanitizer = <TOptions extends object | undefined>(options: TOptions): TOptions => {
		const userOnPayload = isObject(options) ? (options.onPayload as unknown) : undefined;
		return {
			...((options ?? {}) as Record<string, unknown>),
			onPayload: async (payload: unknown, model: unknown) => {
				const sanitized = sanitizeOpenAICompatPayload(payload, {
					preserveStreamOptions: modelSupportsUsageInStreaming(model),
				});
				if (typeof userOnPayload === "function") {
					const userResult = await (userOnPayload as (p: unknown, m: unknown) => unknown)(sanitized, model);
					return userResult ?? sanitized;
				}
				return sanitized;
			},
		} as TOptions;
	};

	return {
		...api,
		stream: (model, context, options) => api.stream(model, context, withSanitizer(options)),
		streamSimple: (model, context, options) => api.streamSimple(model, context, withSanitizer(options)),
	};
}

/**
 * Stale-catalog overlay (issue #19): pi-ai's `createProvider` builds an
 * internal `refreshModels` where phase 1 restores `context.stored.models`
 * verbatim and phase 2 calls the input `fetchModels` + persists. The
 * `dynamicModels` list is a closure variable — external code cannot assign
 * it. When pi restores a persisted store entry written by an older version
 * of this package (e.g. without `thinkingLevelMap`), that stale copy is
 * used as-is and never refreshed (because `checkedAt` is recent).
 *
 * `currentModels()` merges static `input.models` with `dynamicModels` and a
 * dynamic entry REPLACES the baseline entry with the same id+type (the
 * shadowing mechanism). The `ModelsImpl` in pi resolves models exclusively
 * via `getModels()` / `getAllModels()` on the provider object — it never
 * inspects the internal dynamicModels list.
 *
 * The fix: wrap `getModels` and `getAllModels` on the returned provider so
 * every call re-checks the generated catalog and applies capability data
 * when the id exists there. The store decides which ids exist; the
 * generated catalog decides capability data. Read-time overlay is the only
 * provider-side hook that wins over the stale restore.
 *
 * `overlayMap` is prebuilt once at factory time from BOTH the generated
 * chat catalog AND `baselineImageModels(source)`. Both `getModels`
 * and `getAllModels` use `applyOverlay` for O(1) per-model lookup (GAP 2).
 * This also covers image models: pi-ai's image models are only visible
 * through `getAllModels()`, so a stale stored IMAGE entry would otherwise
 * replace the baseline image entry with no overlay (GAP 1).
 *
 * We do NOT override `refreshModels` — the built-in phases stay intact. The
 * overlay only affects read paths.
 */
function withStaleCatalogOverlay(
	provider: Provider<"openai-completions">,
	overlayMap: Map<string, OverlayEntry>,
): Provider<"openai-completions"> {
	return {
		...provider,
		getModels: () => {
			const models = provider.getModels();
			return models.map((m) => applyOverlay(m, overlayMap)) as typeof models;
		},
		getAllModels: () => {
			const all = provider.getAllModels?.();
			if (!all) return [];
			return all.map((m) => applyOverlay(m, overlayMap));
		},
	};
}

/**
 * Build a complete pi-ai Provider for an OpenAI-compatible endpoint:
 *
 * - auth: stored credential key wins, then the first set env var resolves;
 *   `/login <id>` prompts for the key (pi's `envApiKeyAuth` semantics — the
 *   same precedence the built-in providers use). No prompt is needed when the
 *   env var is set.
 * - models: the generated chat-model fallback catalog plus NaN image models
 *   (flux-2-klein, qwen-image-2.1) as static baseline, so all models are
 *   available with zero network.
 * - fetchModels: live `/models` IDs × generated capability data; falls back
 *   to the baseline when the endpoint is unreachable. pi's Models runtime
 *   drives refreshes (startup/periodic) and persists the overlay.
 * - images: a `ProviderImages` implementation for NaN's OpenAI-compatible
 *   image endpoints, so `generateImages()` calls are routed through pi's
 *   model registry.
 * - api: the openai-completions streaming implementation resolved via
 *   `resolveOpenAICompletionsApi` (bare root under pi's compat alias as
 *   the instance anchor; otherwise a file URL from import.meta.resolve;
 *   never a bare subpath — loud failure if unresolved). Issue #8.
 */
export async function createNanCompatibleProvider(
	config: OpenAICompatibleProviderConfig,
	options: NanCompatibleProviderOptions = {},
): Promise<Provider<"openai-completions">> {
	const apiFactory = await resolveOpenAICompletionsApi();
	const source: CatalogSource = { providerId: config.id, baseUrl: config.baseUrl };

	// Last successful live /models result, shared between fetchModels (writes)
	// and filterModels (reads). When set it is authoritative for what your key
	// can use — tier detection: NaN lists exactly the models your membership
	// can call, so models absent from the live list are filtered out of
	// `available` (e.g. premium-tier models you are not subscribed to).
	let liveIds: Set<string> | undefined;

	const imageModels = baselineImageModels(source);
	const overlayMap = buildOverlayMap(source, NAN_GENERATED_MODELS, imageModels);

	return withStaleCatalogOverlay(
		piAi.createProvider({
			id: config.id,
			name: config.name,
			baseUrl: config.baseUrl,
			auth: { apiKey: piAi.envApiKeyAuth(`${config.name} API key`, config.envVars) },
			models: [...baselineModels(source), ...baselineImageModels(source)],
			images: { [NAN_IMAGE_API]: createNanImagesApi({ fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs }) },
			fetchModels: async (context: RefreshModelsContext) => {
				const credential = context.credential;
				const resolved = await resolveCatalog(source, {
					apiKey: credential?.type === "api_key" ? credential.key : undefined,
					timeoutMs: options.timeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS,
					fetchImpl: options.fetchImpl,
				});
				liveIds = resolved.liveIds;
				return resolved.models;
			},
			filterModels: (models) => {
				// Snapshot: TS can't prove `liveIds` unchanged across the closure boundary.
				const current = liveIds;
				return current ? models.filter((model) => current.has(model.id)) : models;
			},
			// Sanitize the payload for NaN's strict schema, then wrap a guard that
			// detects NaN's reasoning-only stream closure marker and rewrites the
			// terminal message so pi-ai retries it as a retryable error (issue #21).
			// Finally, classify an opaque generic 400 as a context overflow when
			// the request we just sent was over the model's window (issue #3).
			//
			// Composition order: outermost → classifier (error rewrites),
			// middle → guard (marker detection), innermost → sanitizer (payload).
			// The guard's onProviderStreamEvent hook sees the raw response chunks
			// (NOT onPayload, which only receives the outgoing request params).
			api: withContextOverflowClassification(
				withReasoningOnlyStreamGuard(wrapApiForStrictSanitization(apiFactory())),
			),
		}),
		overlayMap,
	);
}

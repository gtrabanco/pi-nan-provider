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
 * virtualModules; pi 0.83 and 0.84 alike), and compat re-exports every lazy
 * API factory. Subpath specifiers (`@earendil-works/pi-ai/api/...`) get the
 * alias applied as a prefix and resolve to `<compat.js>/api/...`, which does
 * not exist — the extension then fails to load entirely.
 */

import * as piAi from "@earendil-works/pi-ai";
import type {
	Provider,
	ProviderStreams,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { withContextOverflowClassification } from "./context-overflow-classifier.ts";
import {
	baselineModels,
	DEFAULT_MODELS_TIMEOUT_MS,
	resolveCatalog,
	type CatalogSource,
} from "./fetch-models.ts";
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
 * Resolve the openai-completions streaming implementation at runtime.
 *
 * Under pi, the bare-root namespace is pi's compat entrypoint, which
 * re-exports `openAICompletionsApi` on both pi-ai 0.83 and 0.84 — so the
 * first branch always wins and no pi-ai subpath is ever resolved there.
 * Outside pi (plain node/bun: tests and direct consumers) the real root
 * does not export the lazy factory; the dynamic subpath import below uses
 * the package's normal `./api/*` export. It is never reached under pi, so
 * the alias-prefix pitfall cannot bite at runtime.
 */
type OpenAICompletionsApiFactory = () => ProviderStreams;

let cachedApiFactory: OpenAICompletionsApiFactory | undefined;

export async function resolveOpenAICompletionsApi(): Promise<OpenAICompletionsApiFactory> {
	if (cachedApiFactory) return cachedApiFactory;
	const fromRoot = (
		piAi as unknown as Partial<Record<"openAICompletionsApi", OpenAICompletionsApiFactory>>
	).openAICompletionsApi;
	if (typeof fromRoot === "function") {
		cachedApiFactory = fromRoot;
		return cachedApiFactory;
	}
	cachedApiFactory = (await import("@earendil-works/pi-ai/api/openai-completions.lazy"))
		.openAICompletionsApi;
	return cachedApiFactory;
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
 * Build a complete pi-ai Provider for an OpenAI-compatible endpoint:
 *
 * - auth: stored credential key wins, then the first set env var resolves;
 *   `/login <id>` prompts for the key (pi's `envApiKeyAuth` semantics — the
 *   same precedence the built-in providers use). No prompt is needed when the
 *   env var is set.
 * - models: the generated fallback catalog as static baseline, so models are
 *   available with zero network.
 * - fetchModels: live `/models` IDs × generated capability data; falls back
 *   to the baseline when the endpoint is unreachable. pi's Models runtime
 *   drives refreshes (startup/periodic) and persists the overlay.
 * - api: the openai-completions streaming implementation (see
 *   `resolveOpenAICompletionsApi` for why this is resolved dynamically).
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

	return piAi.createProvider({
		id: config.id,
		name: config.name,
		baseUrl: config.baseUrl,
		auth: { apiKey: piAi.envApiKeyAuth(`${config.name} API key`, config.envVars) },
		models: baselineModels(source),
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
		// Sanitize the payload for NaN's strict schema, then classify an opaque
		// generic 400 as a context overflow when the request we just sent was over
		// the model's window. The second layer keeps a replayed cross-model
		// reasoning trace (or any other over-window request the context-hook guard
		// cannot reach, e.g. NAN_THINKING_GUARD=0) recoverable instead of wedging
		// the session — see src/context-overflow-classifier.ts.
		api: withContextOverflowClassification(wrapApiForStrictSanitization(apiFactory())),
	});
}

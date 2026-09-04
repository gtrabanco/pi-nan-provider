/**
 * Shared factory for OpenAI-compatible providers registered from this package.
 *
 * One implementation, N provider configs. A second provider-specific source
 * file is a smell — add a config entry (see src/providers.ts) and, if needed,
 * catalog data, never a parallel implementation.
 *
 * The resulting provider follows pi-ai's built-in provider shape (see
 * `deepseekProvider()` in pi-ai): `createProvider` + `envApiKeyAuth` +
 * `openAICompletionsApi`, with a `fetchModels` overlay that merges the live
 * /models listing with the generated fallback catalog.
 */

import {
	createProvider,
	envApiKeyAuth,
	type Provider,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
	baselineModels,
	DEFAULT_MODELS_TIMEOUT_MS,
	fetchNanCompatibleModels,
	type CatalogSource,
} from "./fetch-models.ts";

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
 * - api: `openAICompletionsApi()` (lazy-loaded streaming implementation).
 */
export function createNanCompatibleProvider(
	config: OpenAICompatibleProviderConfig,
	options: NanCompatibleProviderOptions = {},
): Provider<"openai-completions"> {
	const source: CatalogSource = { providerId: config.id, baseUrl: config.baseUrl };

	return createProvider({
		id: config.id,
		name: config.name,
		baseUrl: config.baseUrl,
		auth: { apiKey: envApiKeyAuth(`${config.name} API key`, config.envVars) },
		models: baselineModels(source),
		fetchModels: async (context: RefreshModelsContext) => {
			const credential = context.credential;
			return fetchNanCompatibleModels(source, {
				apiKey: credential?.type === "api_key" ? credential.key : undefined,
				timeoutMs: options.timeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS,
				fetchImpl: options.fetchImpl,
			});
		},
		api: openAICompletionsApi(),
	});
}

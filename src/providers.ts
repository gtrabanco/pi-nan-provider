/**
 * Provider registry for this package. Each entry is registered through the
 * shared factory in src/provider-factory.ts — adding a provider is one entry
 * here (plus catalog data), never a second implementation file.
 */

import type { OpenAICompatibleProviderConfig } from "./provider-factory.ts";

/**
 * NaN Builders — https://nan.builders — community LiteLLM gateway.
 *
 * Base URL and env var confirmed by models.dev (provider "nan") and NaN's own
 * getting-started docs; `openai-completions` + `supportsDeveloperRole: true`
 * per NaN's published .pi/agent/models.json example.
 */
export const NAN_PROVIDER: OpenAICompatibleProviderConfig = {
	id: "nan",
	name: "NaN",
	baseUrl: "https://api.nan.builders/v1",
	envVars: ["NAN_API_KEY"],
};

/**
 * `helmcode` is intentionally NOT registered in v0.1.0. The founding prompt
 * references it (shared factory + HELLMCODE_API_KEY), but no confirmed base
 * URL or capability source exists — it is absent from models.dev and from
 * NaN's docs, and fabricating either is against this repo's rules.
 *
 * When an endpoint and catalog source are confirmed: add an entry here (same
 * shape as NAN_PROVIDER) and a models.dev/generator source if available. The
 * shared factory covers it with zero new code — see the factory test that
 * registers a second provider through the same code path.
 */
export const PROVIDERS: readonly OpenAICompatibleProviderConfig[] = [NAN_PROVIDER];

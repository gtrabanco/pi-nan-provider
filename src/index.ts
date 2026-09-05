/**
 * @gtrabanco/pi-nan-provider — NaN Builders provider + MCP bridges for pi.
 *
 * What this extension registers:
 *
 *  1. Providers: every entry in PROVIDERS via the shared OpenAI-compatible
 *     factory. The generated fallback catalog is available immediately at
 *     startup; pi's Models runtime calls fetchModels (live /models ×
 *     generated catalog) on network refreshes, and filterModels prunes the
 *     models your key cannot actually use (tier detection). On pi versions
 *     without the native Provider overload, registration falls back to the
 *     legacy (name, config) form with the same baseline catalog.
 *
 *     The entrypoint is async: pi awaits extension factories (0.83 and
 *     0.84 alike), and the openai-completions streaming implementation is
 *     resolved dynamically — see provider-factory.ts for why.
 *
 *  2. MCP tools over pi's registerTool (pi intentionally has no MCP client):
 *     - `nan_web_search` via NaN's official remote MCP server
 *       (https://api.nan.builders/mcp) — on by default, NAN_MCP_TOOLS=0 to
 *       disable.
 *     - Media tools bridging the optional community `nan-mcp-server`
 *       (stdio, spawned per call) — on by default, NAN_MEDIA_MCP=0 to
 *       disable. The server spawns per tool call, so nothing runs unless
 *       audio/image/transcription is actually invoked.
 */

import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { registerNanMcpCommand } from "./commands.ts";
import { baselineModels } from "./fetch-models.ts";
import { createNanWebSearchTool, webSearchBridgeEnabled, NAN_API_KEY_ENV } from "./mcp/nan-search.ts";
import { createNanMediaTools, mediaMcpEnabled } from "./mcp/nan-media.ts";
import { createNanCompatibleProvider, type OpenAICompatibleProviderConfig } from "./provider-factory.ts";
import { PROVIDERS } from "./providers.ts";

/**
 * Register a provider on any pi version: the native full-Provider overload
 * where supported, else the documented legacy (name, config) form with
 * env-var auth. The fallback loses stored-credential auth (env only) — a
 * documented limitation of the legacy path, never a silent auth invention.
 */
async function registerProviderCompat(
	pi: ExtensionAPI,
	config: OpenAICompatibleProviderConfig,
): Promise<void> {
	let native: Provider<"openai-completions"> | undefined;
	try {
		native = await createNanCompatibleProvider(config);
		pi.registerProvider(native);
		return;
	} catch (error) {
		console.warn(
			`[pi-nan-provider] native provider path failed (${error instanceof Error ? error.message : String(error)}); ` +
				"falling back to legacy config form (env-var auth only).",
		);
	}
	const legacy: ProviderConfig = {
		name: config.name,
		baseUrl: config.baseUrl,
		// Legacy config syntax: one env-var reference; first configured var wins.
		...(config.envVars.length > 0 ? { apiKey: `$${config.envVars[0]}` } : {}),
		api: "openai-completions",
		models: baselineModels({ providerId: config.id, baseUrl: config.baseUrl }).map((model) => ({
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			input: [...model.input],
			cost: { ...model.cost },
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			...(model.compat ? { compat: { ...model.compat } } : {}),
		})),
	};
	pi.registerProvider(config.id, legacy);
}

/**
 * Register MCP-bridged tools when the runtime supports them. Both bridges
 * are enabled by default and lazy (nothing runs until a tool is invoked);
 * `/nan-mcp` (and the NAN_MCP_TOOLS / NAN_MEDIA_MCP env vars) toggle them.
 * Old pi versions without registerTool/registerCommand skip gracefully.
 *
 * Registration is tracked in `registeredToolNames` so `/nan-mcp enable` can
 * add tools mid-session without double-registering.
 */
function registerMcpToolsCompat(pi: ExtensionAPI): void {
	if (typeof pi.registerTool !== "function") return;
	const registeredToolNames = new Set<string>();
	const registerSearchTool = () => {
		const search = createNanWebSearchTool();
		if (registeredToolNames.has(search.name)) return;
		registeredToolNames.add(search.name);
		pi.registerTool(search);
	};
	const registerMediaTools = () => {
		for (const tool of createNanMediaTools()) {
			if (registeredToolNames.has(tool.name)) continue;
			registeredToolNames.add(tool.name);
			pi.registerTool(tool);
		}
	};

	if (webSearchBridgeEnabled()) registerSearchTool();
	if (mediaMcpEnabled()) registerMediaTools();
	if (typeof pi.registerCommand === "function") {
		registerNanMcpCommand(pi, { registerWebSearchTools: registerSearchTool, registerMediaTools });
	}
}

export default async function nanProviderExtension(pi: ExtensionAPI): Promise<void> {
	for (const config of PROVIDERS) {
		await registerProviderCompat(pi, config);
	}
	registerMcpToolsCompat(pi);
}

/** Exposed for tests: the env var this package uses for every NaN surface. */
export { NAN_API_KEY_ENV };

/** Exposed for advanced consumers that want the typed provider factory directly. */
export { createNanCompatibleProvider, type OpenAICompatibleProviderConfig } from "./provider-factory.ts";
export { PROVIDERS, NAN_PROVIDER } from "./providers.ts";
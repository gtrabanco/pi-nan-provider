/**
 * @gtrabanco/pi-nan-provider — NaN Builders provider + native MCP servers for pi.
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
 *  2. MCP servers via pi's native registerMcpServer (pi >=0.99):
 *     - `nan-search` — the official NaN remote MCP server
 *       (https://api.nan.builders/mcp), exposing `mcp__nan-search__web_search`.
 *       Default: enabled. NAN_MCP_TOOLS=0 to disable.
 *     - `nan-media` — the community stdio media server
 *       (flux-2-klein / kokoro / whisper), exposing
 *       `mcp__nan-media__generate_image` etc. Default: enabled,
 *       NAN_MEDIA_MCP=0 to disable.
 *
 *     Both are session-scoped (visible in /mcp with source "extension").
 *     Exposure: `direct` — tools are declared to the model like built-ins.
 */

import type { ContextEvent, ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { registerNanMcpCommand } from "./commands.ts";
import { registerNanUsageCommand } from "./usage.ts";
import {
	crossModelThinkingGuardEnabled,
	stripCrossModelThinking,
} from "./cross-model-thinking-guard.ts";
import { baselineModels } from "./fetch-models.ts";
import { createNanCompatibleProvider, type OpenAICompatibleProviderConfig } from "./provider-factory.ts";
import { PROVIDERS } from "./providers.ts";
import { NAN_API_KEY_ENV, mcpToolsDisabled, mcpToolsEnvExplicit, resolveNanApiKey, tryResolveNanApiKeyViaRegistry, resolveStoredNanApiKey, NAN_MCP_TOOLS_ENV, webSearchBridgeEnabled } from "./mcp/api-key.ts";
import { mediaMcpCommand, mediaMcpEnabled, mediaMcpEnvExplicit, mediaMcpEnvTruthy, mediaMcpTimeoutSec } from "./mcp/media-server.ts";
import { registerMcpHostGuard } from "./mcp/host-support.ts";

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
			...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
		})),
	};
	pi.registerProvider(config.id, legacy);
}

// ── Native MCP registration ──────────────────────────────────────────────

/**
 * Guard message shown when pi lacks native MCP support (pi <0.99 despite peers).
 * Matches the loud-skip style of existing guards (pi-ai, registerTool).
 */
const NO_NATIVE_MCP_GUARD_MSG =
	"pi-nan-provider 0.10+ requires pi >= 0.99 for MCP tools (native MCP); upgrade pi or stay on package 0.9.x";

/** Register the official NaN web-search MCP server (session-scoped). */
async function registerWebSearchMcpServer(pi: ExtensionAPI, apiKey: string | undefined): Promise<boolean> {
	if (!webSearchBridgeEnabled()) return false;
	if (!apiKey) {
		console.warn(
			"[pi-nan-provider] NAN_API_KEY is not set — web-search server not registered. " +
				"Run `/login nan` in pi or export `NAN_API_KEY=<your-key>`.",
		);
		return false;
	}
	pi.registerMcpServer("nan-search", {
		type: "http",
		url: "https://api.nan.builders/mcp",
		headers: { Authorization: `Bearer ${apiKey}` },
		exposure: "direct",
	});
	return true;
}

/** Register the community media stdio MCP server (session-scoped). */
function registerMediaMcpServer(pi: ExtensionAPI, apiKey: string | undefined): boolean {
	if (!mediaMcpEnabled()) return false;
	if (!apiKey) {
		console.warn(
			"[pi-nan-provider] NAN_API_KEY is not set — media server not registered. " +
				"Run `/login nan` in pi or export `NAN_API_KEY=<your-key>`.",
		);
		return false;
	}
	const mediaArgs = mediaMcpCommand();
	pi.registerMcpServer("nan-media", {
		type: "stdio",
		command: mediaArgs[0]!,
		args: mediaArgs.slice(1),
		env: { [NAN_API_KEY_ENV]: apiKey },
		exposure: "direct",
		timeout: mediaMcpTimeoutSec(),
	});
	return true;
}

/**
 * Register MCP servers via pi's native registerMcpServer.
 *
 * Session-scoped: servers appear in /mcp with source "extension", are
 * visible to the model (exposure: "direct"), and user mcp.json entries
 * with the same name take precedence.
 *
 * On pi <0.99 (registerMcpServer absent) this does NOT bridge — it
 * notifies once and skips (same loud-skip style as existing guards).
 * Hard cutover: users on older pi stay on package 0.9.x.
 */
async function registerMcpServersNative(pi: ExtensionAPI): Promise<void> {
	// Guard: pi >= 0.99 required for native MCP.
	if (typeof pi.registerMcpServer !== "function") {
		console.warn(NO_NATIVE_MCP_GUARD_MSG);
		return;
	}

	// Resolve the API key ONCE: stored credential (auth.json) → env fallback.
	// The factory-time ExtensionAPI has NO modelRegistry; stored credentials
	// must be read through the coding-agent's readStoredCredential API.
	const storedKey = resolveStoredNanApiKey();
	const apiKey = storedKey ?? process.env[NAN_API_KEY_ENV];

	await registerWebSearchMcpServer(pi, apiKey);
	registerMediaMcpServer(pi, apiKey);
}

// ── Extension entrypoint ─────────────────────────────────────────────────

/**
 * Drop the reasoning pi-ai replays across a model switch.
 *
 * pi-ai's `transformMessages` downgrades a previous model's `thinking` blocks
 * to plain text with no size bound (verified on 0.87.1), and nothing
 * bounds the sum across messages — measured at 30–60% of the whole context on
 * real sessions. Switching from a 1M-context model to a 262K one (`qwen3.6`)
 * then overflows the window, and NaN's gateway answers a generic
 * `400 Invalid request. Check your request parameters.` This hook runs before
 * pi-ai converts the blocks, so removing the cross-model reasoning here keeps
 * the replayed context small. Answers and tool results are untouched. See
 * src/cross-model-thinking-guard.ts.
 *
 * Scope: only requests targeting this package's providers are touched, and
 * only messages from a DIFFERENT model — same-model reasoning is never removed.
 */
export function registerCrossModelThinkingGuard(pi: ExtensionAPI): void {
	if (typeof pi.on !== "function") return; // old pi without the context hook
	const providerIds = new Set(PROVIDERS.map((provider) => provider.id));
	pi.on("context", (event, ctx) => {
		if (!crossModelThinkingGuardEnabled()) return;
		const guarded = stripCrossModelThinking(event.messages, ctx.model, { providerIds });
		if (guarded === event.messages) return;
		return { messages: guarded as ContextEvent["messages"] };
	});
}

export default async function nanProviderExtension(pi: ExtensionAPI): Promise<void> {
	registerCrossModelThinkingGuard(pi);
	// Replaces pi's cryptic "no loaded extension connects MCP servers" error with
	// actionable guidance when the host loads no built-in `mcp` extension (PI WEB).
	registerMcpHostGuard(pi);
	for (const config of PROVIDERS) {
		await registerProviderCompat(pi, config);
	}
	await registerMcpServersNative(pi);
	if (typeof pi.registerCommand === "function") {
		registerNanMcpCommand(pi);
		registerNanUsageCommand(pi);
	}
}

/** Exposed for tests: the env var this package uses for every NaN surface. */
export { NAN_API_KEY_ENV };

/** Exposed for advanced consumers that want the typed provider factory directly. */
export { createNanCompatibleProvider, type OpenAICompatibleProviderConfig } from "./provider-factory.ts";
export { PROVIDERS, NAN_PROVIDER } from "./providers.ts";
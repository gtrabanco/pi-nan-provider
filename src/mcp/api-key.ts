import { bridgeSource, resolveBridgeEnabled } from "./state.ts";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";

/**
 * NaN API key resolution — shared across every surface (web search, media, usage).
 *
 * Strategy: pi's stored credential (modelRegistry) wins → env var fallback.
 * Never logs or embeds the key beyond the Authorization header.
 */

/**
 * Resolve the NaN API key through pi's stored credential (auth.json).
 * Reads synchronously via `readStoredCredential("nan")` — the factory-time
 * ExtensionAPI has NO modelRegistry (verified pi 0.99.1); stored credentials
 * must be resolved at load time through the coding-agent API.
 *
 * Guards the credential shape: only accepts `{ type: "api_key", key: "sk-..." }`
 * with a non-empty string key. Wraps in try/catch → undefined on any error.
 *
 * Precedence: this function is the **stored-credential** layer; callers compose
 * it with the env var fallback to achieve stored → env order.
 */
export function resolveStoredNanApiKey(): string | undefined {
	try {
		const credential = readStoredCredential(NAN_PROVIDER_ID);
		if (
			credential != null &&
			typeof credential === "object" &&
			"type" in credential &&
			credential.type === "api_key" &&
			"key" in credential &&
			typeof credential.key === "string" &&
			credential.key.length > 0
		) {
			return credential.key;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** Env var that overrides the official web_search bridge. */
export const NAN_MCP_TOOLS_ENV = "NAN_MCP_TOOLS";
/** Env var that overrides the media bridge. */
export const NAN_MEDIA_MCP_ENV = "NAN_MEDIA_MCP";
/** The NaN API key env var used everywhere. */
export const NAN_API_KEY_ENV = "NAN_API_KEY";
/** NaN provider id used for stored-credential lookup. */
const NAN_PROVIDER_ID = "nan";

/**
 * Resolve the NaN API key: pi's registry first (covers stored auth.json),
 * then env fallback. `registryKey` is the result of an attempted registry
 * lookup (already caught and converted to string | undefined by the caller).
 */
export function resolveNanApiKey(registryKey: string | undefined): string | undefined {
	if (registryKey) return registryKey;
	return process.env[NAN_API_KEY_ENV] || undefined;
}

/**
 * Attempt to resolve the API key through pi's model registry.
 * Catches any error and returns undefined so the caller can fall back to env.
 */
export async function tryResolveNanApiKeyViaRegistry(
	modelRegistry: { getApiKeyForProvider(provider: string): Promise<string | undefined> } | undefined,
): Promise<string | undefined> {
	try {
		return await modelRegistry?.getApiKeyForProvider(NAN_PROVIDER_ID);
	} catch {
		// Registry unavailable — caller falls back to env.
		return undefined;
	}
}

/** Whether MCP tool registration is disabled via env (NAN_MCP_TOOLS=0|false|off). */
export function mcpToolsDisabled(): boolean {
	const value = process.env[NAN_MCP_TOOLS_ENV]?.trim().toLowerCase();
	return value === "0" || value === "false" || value === "off";
}

/** Whether NAN_MCP_TOOLS is explicitly set (any value). */
export function mcpToolsEnvExplicit(): boolean {
	const value = process.env[NAN_MCP_TOOLS_ENV];
	return value !== undefined && value.trim() !== "";
}

/** Whether NAN_MEDIA_MCP is explicitly set (any value). */
export function mediaMcpEnvExplicit(): boolean {
	const value = process.env[NAN_MEDIA_MCP_ENV];
	return value !== undefined && value.trim() !== "";
}

/** Whether NAN_MEDIA_MCP is explicitly set and truthy. */
export function mediaMcpEnvTruthy(): boolean {
	const value = process.env[NAN_MEDIA_MCP_ENV]?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "on";
}

/** Source of the effective web-search enablement (env / persisted / default). */
export function webSearchBridgeSource(): import("./state.ts").BridgeSource {
	return bridgeSource("webSearch", mcpToolsEnvExplicit());
}

/** Whether the web-search bridge is enabled by gate (env → persisted → default). */
export function webSearchBridgeEnabled(): boolean {
	return resolveBridgeEnabled("webSearch", mcpToolsEnvExplicit(), !mcpToolsDisabled(), true);
}
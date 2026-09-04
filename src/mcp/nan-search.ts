/**
 * Bridge to NaN's official remote MCP server over plain HTTP — no MCP client
 * needed in pi (pi intentionally ships without MCP support; see docs/usage.md).
 *
 * Endpoint (NaN OpenAPI spec, tag "MCP"): `https://api.nan.builders/mcp`
 * (host root, NOT under `/v1`). Transport is streamable HTTP and stateless;
 * protocol is JSON-RPC 2.0 (`initialize`, `tools/list`, `tools/call`, `ping`).
 * Auth is the same `sk-` key as the REST API (`Authorization: Bearer`), and
 * MCP calls share the key's rate limit, daily quota, and concurrency.
 *
 * Today the server exposes `web_search` (same arguments as `POST /v1/search`);
 * it is a growing registry, so this module keeps a generic `callNanMcpTool`
 * that can invoke any current or future tool by name.
 */

import { Type, type Static } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { bridgeSource, resolveBridgeEnabled, type BridgeSource } from "./state.ts";

/** NaN's official remote MCP endpoint (host root, not /v1). */
export const NAN_MCP_URL = "https://api.nan.builders/mcp";
/** Web search can be slow; the endpoint shares the key's rate limits. */
export const NAN_MCP_TIMEOUT_MS = 30_000;
/** Env var that overrides the official web_search bridge: NAN_MCP_TOOLS=0|false|off disables it. */
export const NAN_MCP_TOOLS_ENV = "NAN_MCP_TOOLS";

const NAN_PROVIDER_ID = "nan";
export const NAN_API_KEY_ENV = "NAN_API_KEY";

export interface NapiKeyContext {
	/** pi's model registry (checks the stored credential and env vars). */
	modelRegistry?: { getApiKeyForProvider(provider: string): Promise<string | undefined> };
}

/**
 * Resolve the NaN API key for tool execution: pi's registry first (it covers
 * the stored auth.json credential and configured env sources), then a direct
 * env fallback so the tools also work on pi versions without the registry.
 * Never logs or embeds the key beyond the Authorization header.
 */
export async function resolveNanApiKey(ctx: NapiKeyContext): Promise<string | undefined> {
	try {
		const stored = await ctx.modelRegistry?.getApiKeyForProvider(NAN_PROVIDER_ID);
		if (stored) return stored;
	} catch {
		// Registry unavailable (older pi) or provider not registered — env fallback below.
	}
	return process.env[NAN_API_KEY_ENV] || undefined;
}

export interface NanMcpToolCall {
	/** MCP tool name, e.g. "web_search". */
	name: string;
	/** Tool arguments object (JSON-serializable). */
	arguments?: Record<string, unknown>;
}

export interface NanMcpToolResult {
	/** true when the call completed without a tool-level or transport error. */
	ok: boolean;
	/** Concatenated text content returned by the tool. */
	text: string;
	/** Error description when ok is false. */
	error?: string;
}

export interface NanMcpCallOptions {
	apiKey?: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

function renderMcpContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const block = item as { type?: string; text?: string };
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		} else if (block.type === "image") {
			parts.push("[image returned by tool; see the saved file path in the text above if present]");
		}
	}
	return parts.join("\n\n");
}

/**
 * Invoke a tool on NaN's official MCP server: POST a JSON-RPC 2.0
 * `tools/call` and flatten the response content. Transport failures,
 * JSON-RPC errors, and tool errors all surface as `{ ok: false }` with a
 * message — never as a thrown error, so tool results degrade gracefully.
 */
export async function callNanMcpTool(
	name: string,
	args: Record<string, unknown> | undefined,
	options: NanMcpCallOptions = {},
): Promise<NanMcpToolResult> {
	const { apiKey, timeoutMs = NAN_MCP_TIMEOUT_MS, fetchImpl = fetch } = options;
	if (!apiKey) return { ok: false, text: "", error: `${NAN_API_KEY_ENV} is not set — set it or run /login nan.` };

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(NAN_MCP_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args ?? {} },
			}),
			signal: controller.signal,
		});
		if (!response.ok) {
			return {
				ok: false,
				text: "",
				error: `NaN MCP returned HTTP ${response.status}${response.status === 401 ? " — check your NaN API key" : ""}`,
			};
		}
		const payload = (await response.json()) as {
			result?: { content?: unknown; isError?: boolean };
			error?: { code?: number; message?: string };
		};
		if (payload.error) {
			return { ok: false, text: "", error: `NaN MCP error ${payload.error.code ?? ""}: ${payload.error.message ?? "unknown"}` };
		}
		const text = renderMcpContent(payload.result?.content);
		if (payload.result?.isError) {
			return { ok: false, text, error: text || "NaN MCP tool reported an error" };
		}
		return { ok: true, text: text || "(empty response)" };
	} catch (error) {
		const aborted = controller.signal.aborted;
		return {
			ok: false,
			text: "",
			error: aborted
				? `NaN MCP call timed out after ${timeoutMs}ms`
				: `NaN MCP call failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	} finally {
		clearTimeout(timeoutId);
	}
}

const webSearchParameters = Type.Object({
	query: Type.String({ description: "The search query." }),
	count: Type.Optional(
		Type.Integer({
			description: "Number of results to return, 1-20 (values outside the range are clamped). Default 5.",
			minimum: 1,
			maximum: 20,
		}),
	),
	freshness: Type.Optional(
		Type.String({
			description:
				"Recency filter: 'pd' (past day), 'pw' (past week), 'pm' (past month), 'py' (past year), or a 'YYYY-MM-DDtoYYYY-MM-DD' date range. Omit for no time filter.",
		}),
	),
	fetch_content: Type.Optional(
		Type.Boolean({
			description:
				"When true, also fetch and include the readable main text of the top results. Slower; defaults to snippets only.",
		}),
	),
});

export type NanWebSearchParams = Static<typeof webSearchParameters>;

/**
 * pi tool bridging NaN's official MCP `web_search`. Registered by default
 * when the runtime supports registerTool; disable with NAN_MCP_TOOLS=0.
 *
 * Failure convention per pi's AgentTool contract: execute() throws on
 * failure instead of encoding errors in content — the runtime surfaces the
 * error to the model so it can self-correct (e.g. ask the user for a key).
 */
export function createNanWebSearchTool(): ToolDefinition<typeof webSearchParameters> {
	return {
		name: "nan_web_search",
		label: "NaN Web Search",
		description:
			"Web search via NaN's remote MCP server (api.nan.builders/mcp). Returns ranked web results with snippets; requires NAN_API_KEY. Same rate limit and quota as the REST /v1/search endpoint.",
		promptSnippet: "nan_web_search(query, count?, freshness?, fetch_content?): web search via the NaN MCP server",
		parameters: webSearchParameters,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const apiKey = await resolveNanApiKey(contextHasKeySource(ctx));
			if (!apiKey) {
				throw new Error(
					`${NAN_API_KEY_ENV} is not set. Export it (export ${NAN_API_KEY_ENV}="sk-...") or run /login nan.`,
				);
			}
			const result = await callNanMcpTool(
				"web_search",
				params as Record<string, unknown>,
				{ apiKey, timeoutMs: NAN_MCP_TIMEOUT_MS },
			);
			if (!result.ok) throw new Error(result.error ?? "NaN MCP call failed");
			return { content: [{ type: "text", text: result.text }], details: undefined } as const;
		},
	};
}

/** Whether MCP tool registration is disabled via env (NAN_MCP_TOOLS=0|false|off). */
export function mcpToolsDisabled(): boolean {
	const value = process.env[NAN_MCP_TOOLS_ENV]?.trim().toLowerCase();
	return value === "0" || value === "false" || value === "off";
}

/** Whether NAN_MCP_TOOLS is explicitly set (any value) — it overrides the persisted toggle. */
export function mcpToolsEnvExplicit(): boolean {
	const value = process.env[NAN_MCP_TOOLS_ENV];
	return value !== undefined && value.trim() !== "";
}

/**
 * Effective enablement of the official web_search bridge: explicit
 * NAN_MCP_TOOLS env var wins (any value, e.g. 0 to force one session off);
 * then the toggle persisted by /nan-mcp; default: enabled.
 */
export function webSearchBridgeEnabled(): boolean {
	return resolveBridgeEnabled("webSearch", mcpToolsEnvExplicit(), !mcpToolsDisabled(), true);
}

/** Source of the effective web_search enablement (env / persisted / default). */
export function webSearchBridgeSource(): BridgeSource {
	return bridgeSource("webSearch", mcpToolsEnvExplicit());
}

/** Extract an ExtensionContext-shaped key source for tests without full pi. */
export function contextHasKeySource(ctx: ExtensionContext): NapiKeyContext {
	return ctx as unknown as NapiKeyContext;
}
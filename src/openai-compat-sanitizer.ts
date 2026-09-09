/**
 * Strict OpenAI Chat Completions schema conformance for NaN-compatible
 * providers.
 *
 * NaN's gateway returns HTTP 400 `Invalid request. Check your request parameters.`
 * for any request that does not match the schema it publishes at
 * https://nan.builders/openapi.json (checked 2026-09-09). That schema is
 * stricter than the permissive OpenAI shape models like OpenAI/Anthropic
 * tolerate, and it does NOT match what pi-ai's message transformer emits in
 * every case. This module rewrites the outgoing `/chat/completions` payload
 * so it is always schema-valid, no matter which pi-ai version is bundled or
 * how the history was constructed.
 *
 * The violated shapes we correct (each one traced to NaN's schema):
 *
 *  1. An `assistant` message whose `content` ARRAY contains a `toolCall`
 *     block. NaN's `ContentPart` oneOf allows ONLY `{type:"text"}` and
 *     `{type:"image_url"}` parts; a tool call is rejected. Tool calls must
 *     live in the top-level `tool_calls` field:
 *     `{ id, type:"function", function:{ name, arguments } }` with
 *     `arguments` as a JSON-encoded string. (This is the shape reported in
 *     the issue: a replayed assistant message with a `toolCall` block still
 *     inside `content` → 400.)
 *  2. An `assistant` message carrying `reasoning_details`. NaN's `Message`
 *     schema admits `role/content/name/tool_calls/tool_call_id/reasoning_content`
 *     but NOT `reasoning_details` (an OpenAI-specific field pi-ai emits on
 *     same-model replay of encrypted/text reasoning signatures). That field
 *     is stripped; reasoning content is delivered the way NaN understands it
 *     (`reasoning_content`, or as plain text already present in `content`).
 *  3. A `content` array containing an unknown part type (e.g. `thinking`).
 *     NaN only accepts `text` and `image_url`; other types are dropped, and
 *     thinking text is folded into a `text` part so the model's reasoning is
 *     not silently lost.
 *  4. Top-level fields NaN's schema does not list: `store` and
 *     `stream_options`. These are opt-in/usage fields pi-ai sends by default
 *     for a "standard" provider; NaN does not document them, so they are
 *     removed. (Removing `stream_options` only costs live token-usage in the
 *     stream; NaN models are membership-quota based with zero per-token cost,
 *     so this is a safe trade.)
 *  5. An EMPTY `tools` array. Verified against the live gateway (2026-09-09):
 *     NaN rejects `tools: []` with the same 400, while `stream: true`, a
 *     `system` message, string content, and a `tool` role message are all
 *     accepted. pi-ai emits `tools: []` when the conversation has tool-call
 *     history but no active tools; NaN only accepts a real tool list, so the
 *     empty array is dropped and a non-empty list is kept.
 *
 * This is applied by wrapping the provider's api `stream`/`streamSimple`
 * with an `onPayload` hook in src/provider-factory.ts, so every provider
 * registered through the shared factory stays schema-valid. A user-supplied
 * `onPayload` (if pi or a consumer passes one) is preserved and chained
 * after sanitization.
 */

interface ContentPart {
	type?: unknown;
	text?: unknown;
	thinking?: unknown;
	[m: string]: unknown;
}

interface ToolCallBlock {
	id?: unknown;
	name?: unknown;
	arguments?: unknown;
	[m: string]: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Monotonic counter for deterministic fallback tool-call ids (pi-ai always supplies ids; this is pure defense). */
let anonymousToolCallSeq = 0;

/** Normalize a `toolCall` content block into NaN's `tool_calls[].{id,type,function}` shape. */
function toToolCall(block: ToolCallBlock): Record<string, unknown> {
	const rawArgs = block.arguments;
	let argumentsJson: string;
	if (typeof rawArgs === "string") {
		argumentsJson = rawArgs;
	} else {
		try {
			argumentsJson = JSON.stringify(rawArgs ?? {});
		} catch {
			argumentsJson = "{}";
		}
	}
	const fallbackName = typeof block.name === "string" && block.name.length > 0 ? block.name : "function";
	return {
		id: typeof block.id === "string" && block.id.length > 0 ? block.id : `call_${fallbackName}_${++anonymousToolCallSeq}`,
		type: "function",
		function: {
			name: fallbackName,
			arguments: argumentsJson,
		},
	};
}

/** Merge tool calls, de-duplicating by id and preferring the pre-existing (pi-ai-built) entries. */
function mergeToolCalls(existing: unknown[], incoming: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	const byId = new Map<string, Record<string, unknown>>();
	for (const tc of existing) {
		if (isObject(tc) && typeof tc.id === "string") byId.set(tc.id, tc);
	}
	for (const tc of incoming) {
		if (typeof tc.id === "string" && !byId.has(tc.id)) byId.set(tc.id, tc);
	}
	return [...byId.values()];
}

/**
 * Rebuild an assistant `content` value from an array of sanitized parts.
 * NaN follows the OpenAI convention: a plain string when there is only text,
 * an array of `text`/`image_url` parts when there are images, and `null` when
 * there is no content (valid on an assistant message that returns tool calls).
 */
function normalizeAssistantContent(parts: Array<Record<string, unknown>>): string | Array<unknown> | null {
	if (parts.length === 0) return null;
	const allText = parts.every((part) => part.type === "text");
	if (allText) {
		const text = parts
			.map((part) => (typeof part.text === "string" ? part.text : ""))
			.join("");
		return text.length > 0 ? text : null;
	}
	return parts;
}

/** Permit only NaN's approved content-part types; fold `thinking` into text. */
function sanitizeAssistantContentPart(part: unknown): Record<string, unknown> | undefined {
	if (!isObject(part)) return undefined;
	const type = part.type;
	if (type === "text") {
		return { type: "text", text: typeof part.text === "string" ? part.text : String(part.text ?? "") };
	}
	if (type === "image_url") {
		return { type: "image_url", image_url: part.image_url };
	}
	if (type === "thinking") {
		const thinking = typeof part.thinking === "string" ? part.thinking : "";
		if (thinking.trim().length === 0) return undefined;
		return { type: "text", text: thinking };
	}
	// Anything else (toolCall handled separately, unknown types dropped) — NaN rejects it.
	return undefined;
}

/** Sanitize a single message against NaN's strict schema. */
function sanitizeMessage(message: unknown): unknown {
	if (!isObject(message)) return message;
	if (message.role !== "assistant") return message;

	const out: Record<string, unknown> = { ...message };
	delete out.reasoning_details; // OpenAI-only; absent from NaN's Message schema.
	// NaN understands `reasoning_content` (not the generic `reasoning` field), so
	// carry any reasoning text over to the field NaN accepts rather than dropping it.
	if (out.reasoning !== undefined && out.reasoning_content === undefined) {
		out.reasoning_content = out.reasoning;
	}
	delete out.reasoning;

	const content = message.content;
	if (!Array.isArray(content)) return out; // string / null content is already schema-valid.

	const textParts: Array<Record<string, unknown>> = [];
	const toolCallBlocks: ToolCallBlock[] = [];
	for (const part of content) {
		if (isObject(part) && part.type === "toolCall") {
			toolCallBlocks.push(part as unknown as ToolCallBlock);
			continue;
		}
		const sanitized = sanitizeAssistantContentPart(part);
		if (sanitized) textParts.push(sanitized);
	}

	out.content = normalizeAssistantContent(textParts);

	const existingToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
	const toolCalls = toolCallBlocks.length > 0 ? mergeToolCalls(existingToolCalls, toolCallBlocks.map(toToolCall)) : [...existingToolCalls];
	if (toolCalls.length > 0) out.tool_calls = toolCalls;
	else delete out.tool_calls;

	return out;
}

/**
 * Rewrite an OpenAI-compatible `/chat/completions` payload so every field
 * conforms to NaN's published schema. Returns the updated payload; if the
 * payload has no `messages` array it is returned unchanged.
 */
export function sanitizeOpenAICompatPayload(payload: unknown): unknown {
	if (!isObject(payload) || !Array.isArray(payload.messages)) return payload;

	const messages = payload.messages.map(sanitizeMessage);
	const out: Record<string, unknown> = { ...payload, messages };

	// Patch function-tools call arguments: NaN wants function-call arguments
	// serialized as a JSON string under `function.arguments`. pi-ai already does
	// this, but a hand-built / older-version payload may not. Normalize each.
	if (Array.isArray(out.messages)) {
		out.messages = out.messages.map((m) => {
			if (!isObject(m) || m.role !== "assistant") return m;
			if (!Array.isArray(m.tool_calls)) return m;
			const normalized = m.tool_calls.map((tc) => {
				if (!isObject(tc)) return tc;
				if (typeof tc.type === "string" && tc.type !== "function") return tc;
				const fn = isObject(tc.function) ? tc.function : {};
				let args = fn.arguments;
				if (args !== undefined && typeof args !== "string") {
					try {
						args = JSON.stringify(args);
					} catch {
						args = "{}";
					}
				}
				return { ...tc, type: "function", function: { ...fn, ...(args !== undefined ? { arguments: args } : {}) } };
			});
			return { ...m, tool_calls: normalized };
		});
	}

	// Top-level fields absent from NaN's schema.
	delete out.store;
	delete out.stream_options;
	// NaN documents `max_tokens`, not `max_completion_tokens`.
	if ("max_completion_tokens" in out && !("max_tokens" in out)) {
		out.max_tokens = out.max_completion_tokens;
		delete out.max_completion_tokens;
	}
	// NaN rejects an EMPTY `tools` array with HTTP 400 `Invalid request. Check
	// your request parameters.` (verified against the live gateway 2026-09-09:
	// everything else in the payload — stream/system/content-as-string/tool role
	// — is accepted, but `tools: []` is not). pi-ai emits `tools: []` whenever
	// the conversation has tool-call history but no active tools; NaN only
	// accepts a real tool list, so drop the empty array. A non-empty `tools`
	// list is preserved unchanged.
	if (Array.isArray(out.tools) && out.tools.length === 0) {
		delete out.tools;
	}

	return out;
}

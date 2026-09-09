import { describe, expect, test } from "bun:test";
import { sanitizeOpenAICompatPayload } from "../src/openai-compat-sanitizer.ts";
import { createNanCompatibleProvider, wrapApiForStrictSanitization } from "../src/provider-factory.ts";
import { NAN_PROVIDER } from "../src/providers.ts";

type Json = Record<string, unknown>;

/** Return the assistant message that carries the tool call / reasoning payload. */
function assistantMsg(messages: unknown): Json {
	return (messages as Json[]).find((m) => m.role === "assistant")!;
}

function toolCallsOf(assistant: Json): Array<{ id: string; type: string; function?: { name: unknown; arguments: unknown } }> {
	return (assistant.tool_calls as Array<{ id: string; type: string; function?: { name: unknown; arguments: unknown } }>) ?? [];
}

/**
 * NaN's published strict Chat Completions schema (https://nan.builders/openapi.json).
 * These assertions encode exactly the fields NaN accepts, so a 400 `Invalid request.
 * Check your request parameters.` is impossible for a payload that passes them.
 */
const ALLOWED_TOP_LEVEL = new Set([
	"model",
	"messages",
	"max_tokens",
	"temperature",
	"top_p",
	"stream",
	"tools",
	"tool_choice",
	"response_format",
	"reasoning_effort",
	"chat_template_kwargs",
]);
const ALLOWED_MESSAGE_FIELDS = new Set(["role", "content", "name", "tool_calls", "tool_call_id", "reasoning_content"]);
const ALLOWED_CONTENT_PART_TYPES = new Set(["text", "image_url"]);

function assertNanSchemaValid(payload: Json): void {
	for (const key of Object.keys(payload)) {
		expect(ALLOWED_TOP_LEVEL.has(key), `unexpected top-level field: ${key}`).toBe(true);
	}
	for (const message of payload.messages as Json[]) {
		if (message.role !== "assistant") continue;
		for (const key of Object.keys(message)) {
			expect(ALLOWED_MESSAGE_FIELDS.has(key), `unexpected assistant field: ${key}`).toBe(true);
		}
		const content = message.content;
		if (Array.isArray(content)) {
			for (const part of content as Array<{ type: string }>) {
				expect(ALLOWED_CONTENT_PART_TYPES.has(part.type), `unexpected content part: ${part.type}`).toBe(true);
				expect(part.type === "toolCall").toBe(false);
			}
		}
		for (const tc of toolCallsOf(message)) {
			expect(tc.type, "toolCall.type must be 'function'").toBe("function");
			expect(tc.function).toBeDefined();
			expect(typeof tc.function!.name).toBe("string");
			expect(typeof tc.function!.arguments).toBe("string");
		}
	}
}

const asst = (id: string, extra: Json = {}): Json => ({
	role: "assistant",
	provider: "nan",
	api: "openai-completions",
	model: "qwen3.6",
	...extra,
});

describe("sanitizeOpenAICompatPayload (NaN strict schema)", () => {
	test("returns a payload with no messages array unchanged", () => {
		expect(sanitizeOpenAICompatPayload(null)).toBeNull();
		expect(sanitizeOpenAICompatPayload("hi")).toBe("hi");
		expect(sanitizeOpenAICompatPayload({ model: "qwen3.6" })).toEqual({ model: "qwen3.6" });
	});

	test("leaves non-assistant messages untouched", () => {
		const payload: Json = {
			model: "qwen3.6",
			messages: [
				{ role: "system", content: "You are a helper" },
				{ role: "user", content: "hi", custom: "keep" },
				{ role: "tool", content: "ok", tool_call_id: "call_x", name: "bash" },
			],
		};
		expect(sanitizeOpenAICompatPayload(payload)).toEqual(payload);
	});

	test("leaves an assistant message with string content alone", () => {
		const payload: Json = { model: "qwen3.6", messages: [{ role: "assistant", content: "plain text" }] };
		expect(sanitizeOpenAICompatPayload(payload)).toEqual(payload);
	});

	test("THE ISSUE: moves a toolCall block out of the content array into tool_calls", () => {
		const payload: Json = {
			model: "qwen3.6",
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: [
					{ type: "text", text: "ok" },
					{ type: "toolCall", id: "call_x", name: "bash", arguments: { command: "echo hi" } },
				] },
			],
		};
		const out = sanitizeOpenAICompatPayload(payload) as Json;
		const assistant = assistantMsg(out.messages);
		// The toolCall must NOT stay inside the content array.
		expect(assistant.content).toBe("ok");
		// ...and must appear as a standard tool_calls entry with JSON-string arguments.
		expect(assistant.tool_calls).toEqual([
			{ id: "call_x", type: "function", function: { name: "bash", arguments: '{"command":"echo hi"}' } },
		]);
		assertNanSchemaValid(out);
	});

	test("THE ISSUE: assistant with ONLY a toolCall block yields content:null plus tool_calls", () => {
		const payload: Json = {
			model: "qwen3.6",
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: [{ type: "toolCall", id: "call_x", name: "bash", arguments: { command: "echo hi" } }] },
			],
		};
		const out = sanitizeOpenAICompatPayload(payload) as Json;
		const assistant = assistantMsg(out.messages);
		expect(assistant.content).toBeNull();
		expect(toolCallsOf(assistant).length).toBe(1);
		assertNanSchemaValid(out);
	});

	test("does NOT duplicate tool calls already in the standard tool_calls field", () => {
		const payload: Json = {
			model: "qwen3.6",
			messages: [
				{ role: "assistant", content: "ok", tool_calls: [{ id: "call_x", type: "function", function: { name: "bash", arguments: '{"command":"echo hi"}' } }] },
			],
		};
		const out = sanitizeOpenAICompatPayload(payload) as Json;
		const assistant = assistantMsg(out.messages);
		expect(toolCallsOf(assistant).length).toBe(1);
		expect(assistant.content).toBe("ok");
	});

	test("dedupes a content toolCall against an existing tool_calls entry with the same id", () => {
		const payload: Json = {
			model: "qwen3.6",
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "ok" },
						{ type: "toolCall", id: "call_x", name: "bash", arguments: { command: "echo hi" } },
					],
					tool_calls: [{ id: "call_x", type: "function", function: { name: "bash", arguments: '{"command":"echo hi"}' } }],
				},
			],
		};
		const out = sanitizeOpenAICompatPayload(payload) as Json;
		const assistant = assistantMsg(out.messages);
		expect(toolCallsOf(assistant).length).toBe(1);
		expect(assistant.content).toBe("ok");
	});

	test("strips reasoning_details (OpenAI-only, absent from NaN's Message schema)", () => {
		const payload: Json = {
			model: "qwen3.6",
			messages: [
				{ role: "assistant", content: "ok", reasoning_details: [{ type: "reasoning.encrypted", id: "r_1", format: "base64", index: 0, data: "AAAA" }] },
			],
		};
		const out = sanitizeOpenAICompatPayload(payload) as Json;
		const assistant = assistantMsg(out.messages);
		expect("reasoning_details" in assistant).toBe(false);
		assertNanSchemaValid(out);
	});

	test("keeps reasoning_content (NaN supports it)", () => {
		const payload: Json = { model: "qwen3.6", messages: [{ role: "assistant", content: "ok", reasoning_content: "the reasoning trace" }] };
		const out = sanitizeOpenAICompatPayload(payload) as Json;
		const assistant = assistantMsg(out.messages);
		expect(assistant.reasoning_content).toBe("the reasoning trace");
	});

	test("maps generic reasoning content into reasoning_content (the field NaN accepts)", () => {
		const payload: Json = { model: "qwen3.6", messages: [{ role: "assistant", content: "ok", reasoning: "think harder" }] };
		const out = sanitizeOpenAICompatPayload(payload) as Json;
		const assistant = assistantMsg(out.messages);
		expect("reasoning" in assistant).toBe(false);
		expect(assistant.reasoning_content).toBe("think harder");
	});

	test("folds a thinking content part into text (NaN has no thinking part)", () => {
		const payload: Json = {
			model: "qwen3.6",
			messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }, { type: "thinking", thinking: "I will think" }] }],
		};
		const out = sanitizeOpenAICompatPayload(payload) as Json;
		const assistant = assistantMsg(out.messages);
		expect(assistant.content).toBe("okI will think");
		assertNanSchemaValid(out);
	});

	test("drops empty thinking and unknown content parts but preserves image_url", () => {
		const payload: Json = {
			model: "qwen3.6",
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "ok" },
						{ type: "thinking", thinking: "   " },
						{ type: "weird", foo: 1 },
						{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
					],
				},
			],
		};
		const out = sanitizeOpenAICompatPayload(payload) as Json;
		const assistant = assistantMsg(out.messages);
		expect(assistant.content).toEqual([
			{ type: "text", text: "ok" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
		]);
		assertNanSchemaValid(out);
	});

	test("removes store and stream_options (absent from NaN's top-level schema)", () => {
		const payload: Json = { model: "qwen3.6", store: false, stream_options: { include_usage: true }, messages: [{ role: "user", content: "hi" }] };
		const out = sanitizeOpenAICompatPayload(payload) as Json;
		expect("store" in out).toBe(false);
		expect("stream_options" in out).toBe(false);
		assertNanSchemaValid(out);
	});

	test("THE ISSUE (live-verified): drops an EMPTY tools array but keeps a real tool list", () => {
		// NaN returns HTTP 400 for `tools: []` (verified against the live gateway).
		const emptyTools: Json = { model: "qwen3.6", tools: [], messages: [{ role: "user", content: "hi" }] };
		const outEmpty = sanitizeOpenAICompatPayload(emptyTools) as Json;
		expect("tools" in outEmpty).toBe(false);
		assertNanSchemaValid(outEmpty);

		// A real tool list must be preserved.
		const realTools: Json = { model: "qwen3.6", tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }], messages: [{ role: "user", content: "hi" }] };
		const outReal = sanitizeOpenAICompatPayload(realTools) as Json;
		expect(Array.isArray(outReal.tools)).toBe(true);
		expect((outReal.tools as unknown[]).length).toBe(1);
	});

	test("maps max_completion_tokens to max_tokens (NaN documents max_tokens)", () => {
		const payload: Json = { model: "qwen3.6", max_completion_tokens: 123, messages: [{ role: "user", content: "hi" }] };
		const out = sanitizeOpenAICompatPayload(payload) as Json;
		expect(out.max_tokens).toBe(123);
		expect("max_completion_tokens" in out).toBe(false);
	});

	test("preserves arguments already serialized as a JSON string and normalizes object/other to string", () => {
		const payload: Json = {
			model: "qwen3.6",
			messages: [
				{
					role: "assistant",
					content: "ok",
					tool_calls: [
						{ id: "call_s", type: "function", function: { name: "read", arguments: '{"path":"/x"}' } },
						{ id: "call_o", type: "function", function: { name: "write", arguments: { path: "/y" } } },
					],
				},
			],
		};
		const out = sanitizeOpenAICompatPayload(payload) as Json;
		const calls = toolCallsOf(assistantMsg(out.messages));
		expect(calls[0]!.function!.arguments).toBe('{"path":"/x"}');
		expect(calls[1]!.function!.arguments).toBe('{"path":"/y"}');
	});

	test("assigns a deterministic fallback id to a toolCall block that has none", () => {
		const payload: Json = {
			model: "qwen3.6",
			messages: [{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "echo hi" } }] }],
		};
		const out = sanitizeOpenAICompatPayload(payload) as Json;
		const toolCall = toolCallsOf(assistantMsg(out.messages))[0]!;
		expect(toolCall.id).toMatch(/^call_bash_/);
	});
});

describe("createNanCompatibleProvider real request is NaN-schema-valid (replay scenarios)", () => {
	/** Capture the first request body a provider.stream call sends (mock fetch). */
	async function captureRequest(messages: Json[], overrides: { onPayload?: (p: unknown, m: unknown) => unknown } = {}): Promise<{ body: Json; sawSanitized: boolean }> {
		let body: Json = {};
		let sawSanitized = false;
		const provider = await createNanCompatibleProvider(NAN_PROVIDER);
		const model = {
			id: "qwen3.6",
			name: "Qwen3.6",
			provider: "nan",
			api: "openai-completions",
			baseUrl: "https://api.nan.builders/v1",
			reasoning: true,
			input: ["text", "image"],
			compat: { supportsDeveloperRole: false, supportsReasoningEffort: true, supportsUsageInStreaming: true, supportsFinishReason: false, maxTokensField: "max_tokens" },
		} as never;
		const fetchImpl: typeof fetch = (async (_url, init) => {
			body = JSON.parse(init!.body as string) as Json;
			sawSanitized = !("store" in body) && !("stream_options" in body);
			return new Response(
				new ReadableStream({
					start(controller) {
						const enc = new TextEncoder();
						controller.enqueue(enc.encode('data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"qwen3.6","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":null}]}\n\n'));
						controller.enqueue(enc.encode("data: [DONE]\n\n"));
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as typeof fetch;

		// The stream is lazy: the request fires only when we consume it.
		for await (const _ of provider.stream(model, { systemPrompt: "You are a helper", messages: messages as never, tools: [] }, { apiKey: "sk-test", fetch: fetchImpl, ...overrides })) {
			// noop — consume until done
		}

		return { body, sawSanitized };
	}

	const textSig = JSON.stringify([{ type: "reasoning.text", text: "think", signature: "sig" }]);

	test("plain tool-call replay emits tool_calls, no toolCall in content, no store/stream_options", async () => {
		const { body, sawSanitized } = await captureRequest([
			{ role: "user", content: "hi" },
			asst("call_x", { content: [{ type: "text", text: "ok" }, { type: "toolCall", id: "call_x", name: "bash", arguments: { command: "echo hi" } }] }),
			{ role: "toolResult", toolCallId: "call_x", toolName: "bash", content: [{ type: "text", text: "hi" }], isError: false },
			{ role: "user", content: "now answer" },
		]);
		const assistant = (body.messages as Json[]).find((m) => m.role === "assistant")!;
		expect(assistant.content).toBe("ok");
		expect(assistant.tool_calls).toEqual([{ id: "call_x", type: "function", function: { name: "bash", arguments: '{"command":"echo hi"}' } }]);
		assertNanSchemaValid(body);
		// `tools: []` (which pi-ai emits for tool-history-only turns) must be dropped
		// so the live gateway returns 200 instead of the strict-schema 400.
		expect("tools" in body).toBe(false);
		expect(sawSanitized).toBe(true);
	});

	test("same-model reasoning replay strips reasoning_details", async () => {
		const { body } = await captureRequest([
			{ role: "user", content: "hi" },
			asst("call_z", {
				content: [
					{ type: "thinking", thinking: "think text", thinkingSignature: textSig },
					{ type: "text", text: "ok" },
					{ type: "toolCall", id: "call_z", name: "read", arguments: { path: "/x" } },
				],
			}),
			{ role: "toolResult", toolCallId: "call_z", toolName: "read", content: [{ type: "text", text: "content" }], isError: false },
			{ role: "user", content: "answer" },
		]);
		const assistant = (body.messages as Json[]).find((m) => m.role === "assistant")!;
		expect("reasoning_details" in assistant).toBe(false);
		assertNanSchemaValid(body);
	});

	test("builder respects a caller onPayload chained after sanitization", async () => {
		const seen: Json[] = [];
		const { body, sawSanitized } = await captureRequest(
			[{ role: "user", content: "hi" }],
			{
				onPayload: async (payload) => {
					const p = payload as Json;
					seen.push(p);
					return { ...p, patched: "byUser" };
				},
			},
		);
		expect(body.patched).toBe("byUser");
		expect(sawSanitized).toBe(true);
		// The user hook received the sanitized payload (store already removed).
		expect("store" in seen[0]!).toBe(false);
		expect("stream_options" in seen[0]!).toBe(false);
	});
});

describe("wrapApiForStrictSanitization (structural)", () => {
	test("exposes wrapped stream/streamSimple and preserves the api surface", () => {
		const fake = {
			stream: () => ({} as never),
			streamSimple: () => ({} as never),
			fetchDeferred: () => ({} as never),
		};
		const wrapped = wrapApiForStrictSanitization(fake as Parameters<typeof wrapApiForStrictSanitization>[0]);
		expect(typeof wrapped.stream).toBe("function");
		expect(typeof wrapped.streamSimple).toBe("function");
		expect(typeof wrapped.fetchDeferred).toBe("function");
	});
});

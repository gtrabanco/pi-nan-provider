/**
 * Issue #52 — the session wedge is a malformed payload, not an under-counting
 * estimator.
 *
 * The report attributes a two-hour `mimo-v2.6-flash` wedge to
 * `estimateRequestTokens()` undercounting tokens. The transcript it cites says
 * otherwise: the turn that precedes the first 400 reports `input` 2,075 +
 * `cacheRead` 559,232 = **561,307 prompt tokens** against a **1,048,576**
 * window, while the estimator answers 625,484 for the same 2,170,428 payload
 * bytes — i.e. it OVER-estimates (real ratio 3.867 bytes/token), so there was
 * nothing over the window to compact.
 *
 * What the payload did carry is a phantom tool call the gateway streamed with
 * an empty id and an empty name, plus pi's `"Tool  not found"` result with an
 * empty `tool_call_id`:
 *
 *   {"role":"assistant","content":"…","tool_calls":[{"id":"","type":"function",
 *     "function":{"name":"","arguments":"{}"}}]}
 *   {"role":"tool","content":"Tool  not found","tool_call_id":""}
 *
 * That pair is not schema-valid, so every later replay of the history returned
 * the same opaque 400. These tests pin both halves: the repair (no empty ids)
 * and the measurement that forbids "fixing" it by loosening the threshold.
 *
 * Archive evidence (read-only, not bundled): transcript
 * `2026-11-25T17-24-52-559Z_01a213bd-24cf-708b-a681-cd801e702cf6.jsonl` lines
 * 634–636; attempts log rows 2026-11-26T17:53:17.317Z … 20:21:25.456Z.
 */
import { describe, expect, test } from "bun:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import {
	classifyContextOverflowError,
	ESTIMATED_CHARS_PER_TOKEN,
	estimateRequestTokens,
	NAN_GENERIC_BAD_REQUEST,
} from "../src/context-overflow-classifier.ts";
import { sanitizeOpenAICompatPayload } from "../src/openai-compat-sanitizer.ts";
import { createNanCompatibleProvider } from "../src/provider-factory.ts";
import { NAN_PROVIDER } from "../src/providers.ts";

type Json = Record<string, unknown>;

/** `payload_bytes` of the last failing request (issue #52, `nan-http-attempts.jsonl`). */
const ARCHIVED_PAYLOAD_BYTES = 2_170_428;
/** Prompt tokens the model reported for that context (`input` 2,075 + `cacheRead` 559,232). */
const ARCHIVED_PROMPT_TOKENS = 561_307;
/** `mimo-v2.6-flash` context window, from the generated catalog. */
const MIMO_CONTEXT_WINDOW = 1_048_576;

/** The two messages pi persisted, verbatim in shape (transcript lines 634-635), in the OpenAI payload shape the sanitizer receives. */
const PHANTOM_TURN: Json[] = [
	{ role: "user", content: "keep going" },
	{
		role: "assistant",
		content: "Git reality confirmed.",
		tool_calls: [{ id: "", type: "function", function: { name: "", arguments: "{}" } }],
	},
	{ role: "tool", content: "Tool  not found", tool_call_id: "" },
];

/** The same turn in pi's internal message shape, for the end-to-end wire test. */
const PHANTOM_PI_MESSAGES = [
	{ role: "user", content: [{ type: "text", text: "keep going" }], timestamp: 0 },
	{
		role: "assistant",
		content: [
			{ type: "text", text: "Git reality confirmed." },
			{ type: "toolCall", id: "", name: "", arguments: {} },
		],
		api: "openai-completions",
		provider: "nan",
		model: "mimo-v2.6-flash",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	},
	{ role: "toolResult", toolCallId: "", toolName: "", content: [{ type: "text", text: "Tool  not found" }], isError: true, timestamp: 0 },
];

function idsOf(messages: unknown[]): { callIds: string[]; resultIds: string[] } {
	const callIds: string[] = [];
	const resultIds: string[] = [];
	for (const message of messages as Json[]) {
		if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
			for (const tc of message.tool_calls as Json[]) callIds.push(String(tc.id ?? ""));
		}
		if (message.role === "tool") resultIds.push(String(message.tool_call_id ?? ""));
	}
	return { callIds, resultIds };
}

/** The wire-level invariant: no tool id may be empty, and every result must name a real call. */
function assertNoEmptyToolIds(messages: unknown[]): void {
	const { callIds, resultIds } = idsOf(messages);
	for (const id of callIds) expect(id.length).toBeGreaterThan(0);
	for (const id of resultIds) {
		expect(id.length).toBeGreaterThan(0);
		expect(callIds).toContain(id);
	}
	expect(new Set(callIds).size).toBe(callIds.length);
}

describe("issue #52 — empty tool-call ids are repaired before the gateway sees them", () => {
	test("the archived phantom turn becomes a schema-valid call/result pair", () => {
		const out = sanitizeOpenAICompatPayload({ model: "mimo-v2.6-flash", messages: PHANTOM_TURN }) as Json;
		const messages = out.messages as Json[];
		const assistant = messages.find((m) => m.role === "assistant")!;
		const tool = messages.find((m) => m.role === "tool")!;
		const call = (assistant.tool_calls as Json[])[0]!;

		expect(call.id).toBe(tool.tool_call_id);
		expect(typeof call.id).toBe("string");
		expect((call.id as string).length).toBeGreaterThan(0);
		assertNoEmptyToolIds(messages);
	});

	test("never emits an empty tool_calls[].id, even when several messages are malformed", () => {
		const out = sanitizeOpenAICompatPayload({
			model: "mimo-v2.6-flash",
			messages: [
				...PHANTOM_TURN,
				{ role: "user", content: "again" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{ id: "", type: "function", function: { name: "bash", arguments: "{}" } },
						{ id: "call_keep", type: "function", function: { name: "read", arguments: "{}" } },
					],
				},
				{ role: "tool", content: "one", tool_call_id: "" },
				{ role: "tool", content: "two", tool_call_id: "call_keep" },
			],
		}) as Json;
		assertNoEmptyToolIds(out.messages as Json[]);
	});

	test("fallback ids are deterministic, so a replay keeps the prefix cache warm", () => {
		const payload = { model: "mimo-v2.6-flash", messages: PHANTOM_TURN };
		const first = sanitizeOpenAICompatPayload(payload) as Json;
		const second = sanitizeOpenAICompatPayload(payload) as Json;

		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
		// Not a process-wide counter: a fresh payload at the same positions gets the same id.
		expect(JSON.stringify(idsOf(first.messages as Json[]))).toBe(JSON.stringify(idsOf(second.messages as Json[])));
	});

	test("an empty function.name is repaired; a grammar call (type !== function) is left alone", () => {
		const grammarCall = { id: "call_grammar", type: "custom", custom: { name: "json", input: "{}" } };
		const out = sanitizeOpenAICompatPayload({
			model: "mimo-v2.6-flash",
			messages: [
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{ id: "call_named", type: "function", function: { name: "", arguments: "{}" } },
						grammarCall,
					],
				},
			],
		}) as Json;
		const assistant = (out.messages as Json[])[0]!;
		const calls = assistant.tool_calls as Json[];

		expect((calls[0]!.function as Json).name).toBe("function");
		expect(calls[1]).toEqual(grammarCall);
	});

	test("multiple results bind pairwise to the announced calls, in order", () => {
		const out = sanitizeOpenAICompatPayload({
			model: "mimo-v2.6-flash",
			messages: [
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{ id: "", type: "function", function: { name: "bash", arguments: "{}" } },
						{ id: "", type: "function", function: { name: "read", arguments: "{}" } },
					],
				},
				{ role: "tool", content: "first", tool_call_id: "" },
				{ role: "tool", content: "second", tool_call_id: "" },
			],
		}) as Json;
		const messages = out.messages as Json[];
		const calls = (messages[0]!.tool_calls as Json[]).map((tc) => tc.id);
		const results = messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);

		expect(results).toEqual(calls);
		assertNoEmptyToolIds(messages);
	});

	test("a result whose call id is real is never rewritten, orphan included", () => {
		const orphan = { role: "tool", content: "ok", tool_call_id: "call_unknown" };
		const out = sanitizeOpenAICompatPayload({
			model: "mimo-v2.6-flash",
			messages: [{ role: "user", content: "hi" }, orphan],
		}) as Json;
		expect(out.messages).toEqual([{ role: "user", content: "hi" }, orphan]);
	});

	test("an empty id with nothing to bind to is dropped (the only schema-valid outcome)", () => {
		const out = sanitizeOpenAICompatPayload({
			model: "mimo-v2.6-flash",
			messages: [
				{ role: "user", content: "hi" },
				{ role: "tool", content: "Tool  not found", tool_call_id: "" },
			],
		}) as Json;
		expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
	});

	test("the repair reaches the wire through the provider api (onPayload path)", async () => {
		let body: Json = {};
		const provider = await createNanCompatibleProvider(NAN_PROVIDER);
		const model = {
			id: "mimo-v2.6-flash",
			name: "MiMo-V2.6-Flash",
			provider: "nan",
			api: "openai-completions",
			baseUrl: "https://api.nan.builders/v1",
			reasoning: true,
			input: ["text", "image"],
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				supportsUsageInStreaming: false,
				supportsFinishReason: true,
				maxTokensField: "max_tokens",
			},
		} as never;
		const fetchImpl: typeof fetch = (async (_url, init) => {
			body = JSON.parse(init!.body as string) as Json;
			return new Response(
				new ReadableStream({
					start(controller) {
						const enc = new TextEncoder();
						controller.enqueue(
							enc.encode(
								'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"mimo-v2.6-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":null}]}\n\n',
							),
						);
						controller.enqueue(enc.encode("data: [DONE]\n\n"));
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as typeof fetch;

		for await (const _ of provider.stream(
			model,
			normalizeContext({ systemPrompt: "You are a helper", messages: PHANTOM_PI_MESSAGES as never, tools: [] }),
			{ apiKey: "sk-test", fetch: fetchImpl },
		)) {
			// consume the stream so the request fires
		}

		assertNoEmptyToolIds(body.messages as Json[]);
	});
});

describe("issue #52 — the measurement that forbids loosening the threshold", () => {
	test("the archived payload is estimated ABOVE the model-reported token count", () => {
		const estimated = Math.ceil(ARCHIVED_PAYLOAD_BYTES / ESTIMATED_CHARS_PER_TOKEN);
		// 625,484 estimated vs 561,307 real: 3.867 bytes/token, so 3.47 is conservative,
		// not optimistic. A larger divisor would let a real overflow escape.
		expect(estimated).toBeGreaterThanOrEqual(ARCHIVED_PROMPT_TOKENS);
		expect(estimated).toBe(625_484);
	});

	test("the archived request is far below the window, so it was never a context overflow", () => {
		const estimated = Math.ceil(ARCHIVED_PAYLOAD_BYTES / ESTIMATED_CHARS_PER_TOKEN);
		expect(ARCHIVED_PROMPT_TOKENS / MIMO_CONTEXT_WINDOW).toBeLessThan(0.6);
		expect(estimated).toBeLessThan(MIMO_CONTEXT_WINDOW);

		const message = {
			role: "assistant" as const,
			content: [],
			api: "openai-completions" as const,
			provider: "nan",
			model: "mimo-v2.6-flash",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "error" as const,
			errorMessage: `400: {"message":"${NAN_GENERIC_BAD_REQUEST}","type":"invalid_request_error","param":null,"code":"400"}`,
			timestamp: 0,
		};
		const out = classifyContextOverflowError(message, { contextWindow: MIMO_CONTEXT_WINDOW }, estimated);
		// Unchanged: the gateway's 400 was NOT an overflow and must not be labelled one.
		expect(out.errorMessage).toBe(message.errorMessage);
	});

	test("the proposed ÷2.0 divisor would fabricate an overflow for a healthy request", () => {
		const withIssueDivisor = Math.ceil(ARCHIVED_PAYLOAD_BYTES / 2.0);
		expect(withIssueDivisor).toBe(1_085_214);
		// That number exceeds the window although the real prompt used 53.5% of it.
		expect(withIssueDivisor).toBeGreaterThan(MIMO_CONTEXT_WINDOW);
		expect(ARCHIVED_PROMPT_TOKENS).toBeLessThan(MIMO_CONTEXT_WINDOW);
	});

	test("estimateRequestTokens still counts prompt, tools and messages from the same bytes", () => {
		const systemPrompt = "s".repeat(1_000);
		const tools = [{ type: "function", function: { name: "bash", description: "run", parameters: {} } }];
		const messages = PHANTOM_TURN;
		const expected =
			systemPrompt.length + JSON.stringify(tools).length + JSON.stringify(messages).length;
		expect(estimateRequestTokens({ systemPrompt, tools, messages } as never)).toBe(
			Math.ceil(expected / ESTIMATED_CHARS_PER_TOKEN),
		);
	});
});

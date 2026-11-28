/**
 * CONTRACT TESTS — pi-ai 1.7.0 OpenAI-completions behavior this package
 * depends on (issue #54, devDependencies 1.6.0 → 1.7.0).
 *
 * Only the two upstream moves that change what this package observes are
 * pinned here; the rest of the 1.7.0 surface is either unused or additive
 * (see AGENTS.md, "pi 1.7.0 / pi-ai 1.7.0 compat"):
 *
 *  1. `onResponse` now fires for every HTTP attempt, error responses and
 *     retried attempts included (`onErrorResponse` in
 *     `utils/provider-retry.js`, wired by `api/openai-completions.js`). 1.6.0
 *     called it only after the retry loop resolved. `src/cache-anomaly.ts`
 *     joins `cf-ray` from that hook, so the shape matters.
 *  2. Reasoning replay metadata is now encoded in `thinkingSignature`
 *     (`encodeThinkingSignature`). A signature written by a 1.6.0 session is
 *     a plain field name, and 1.7.0 still decodes it (`kind: "field"`), so
 *     NaN keeps replaying `reasoning_content` and old sessions do not break.
 *
 * Wire-level, no network: fetch is injected.
 */

import { describe, expect, test } from "bun:test";
import { normalizeContext, type AssistantMessage, type Model, type ProviderResponse } from "@earendil-works/pi-ai";
import { toModel } from "../src/fetch-models.ts";
import { createNanCompatibleProvider } from "../src/provider-factory.ts";
import { NAN_PROVIDER } from "../src/providers.ts";
import { NAN_GENERATED_MODELS } from "../scripts/models.generated.ts";

type Json = Record<string, unknown>;

const SOURCE = { providerId: "nan", baseUrl: "https://api.nan.builders/v1" } as const;

function modelFor(id: string): Model<"openai-completions"> {
	const entry = NAN_GENERATED_MODELS.find((e) => e.id === id);
	if (!entry) throw new Error(`generated catalog is missing model "${id}"`);
	return toModel(entry, SOURCE);
}

/** One SSE chunk carrying a delta, terminated by the usage chunk and [DONE]. */
function sseBody(deltas: Json[], finishReason = "stop"): string {
	const chunks = deltas.map(
		(delta) =>
			`data: ${JSON.stringify({
				id: "chatcmpl-1",
				object: "chat.completion.chunk",
				created: 1,
				model: "test",
				choices: [{ index: 0, delta, finish_reason: null }],
			})}\n\n`,
	);
	chunks.push(
		`data: ${JSON.stringify({
			id: "chatcmpl-1",
			object: "chat.completion.chunk",
			created: 1,
			model: "test",
			choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
			usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
		})}\n\n`,
		"data: [DONE]\n\n",
	);
	return chunks.join("");
}

function streamResponse(body: string): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(body));
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

/** Run one turn through the real provider and consume it to completion. */
async function runTurn(
	model: Model<"openai-completions">,
	options: {
		fetch: typeof fetch;
		onResponse?: (response: ProviderResponse) => void;
		maxRetries?: number;
		messages?: unknown[];
	},
): Promise<AssistantMessage> {
	const provider = await createNanCompatibleProvider(NAN_PROVIDER);
	const context = normalizeContext({
		messages: (options.messages ?? [{ role: "user", content: [{ type: "text", text: "hi" }] }]) as never,
		tools: [] as never,
	});
	const stream = provider.stream(model, context, {
		apiKey: "sk-test",
		fetch: options.fetch,
		...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
		...(options.onResponse ? { onResponse: options.onResponse } : {}),
	});
	for await (const _event of stream) {
		// consume to completion
	}
	return await stream.result();
}

describe("pi-ai 1.7.0 contract — onResponse reports every attempt", () => {
	test("a retried 429 reaches the caller's hook before the 200", async () => {
		const statuses: number[] = [];
		let attempt = 0;
		const fetchImpl = (async () => {
			attempt += 1;
			if (attempt === 1) {
				return new Response(JSON.stringify({ error: { message: "rate limited", type: "rate_limit" } }), {
					status: 429,
					headers: { "content-type": "application/json", "retry-after-ms": "0" },
				});
			}
			return streamResponse(sseBody([{ role: "assistant", content: "ok" }]));
		}) as unknown as typeof fetch;

		const result = await runTurn(modelFor("qwen3.6"), {
			fetch: fetchImpl,
			maxRetries: 1,
			onResponse: (response) => {
				statuses.push(response.status);
			},
		});

		expect(result.stopReason).toBe("stop");
		expect(statuses).toEqual([429, 200]);
	});

	test("a terminal failure is reported once and leaves no response id", async () => {
		const statuses: number[] = [];
		const fetchImpl = (async () =>
			new Response(JSON.stringify({ error: { message: "nope", type: "invalid_request_error" } }), {
				status: 400,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;

		const result = await runTurn(modelFor("qwen3.6"), {
			fetch: fetchImpl,
			maxRetries: 0,
			onResponse: (response) => {
				statuses.push(response.status);
			},
		});

		expect(result.stopReason).toBe("error");
		expect(statuses).toEqual([400]);
		expect(result.responseId).toBeUndefined();
	});
});

describe("pi-ai 1.7.0 contract — legacy thinking signatures still replay", () => {
	test("a 1.6.0-style plain signature replays under the same field", async () => {
		let body: Json = {};
		const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
			body = JSON.parse(init!.body as string) as Json;
			return streamResponse(sseBody([{ role: "assistant", content: "ok" }]));
		}) as unknown as typeof fetch;

		const model = modelFor("qwen3.6");
		await runTurn(model, {
			fetch: fetchImpl,
			messages: [
				{
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: [
						{ type: "thinking", thinking: "let me think", thinkingSignature: "reasoning_content" },
						{ type: "text", text: "answer" },
					],
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
					stopReason: "stop",
					timestamp: 0,
				},
				{ role: "user", content: [{ type: "text", text: "next" }] },
			],
		});

		const messages = body.messages as Json[];
		expect(messages[0]?.reasoning_content).toBe("let me think");
		expect(messages[0]).not.toHaveProperty("thinkingSignature");
		expect(messages[0]).not.toHaveProperty("reasoning_opaque");
	});

	test("NaN's own streamed reasoning keeps a plain field signature", async () => {
		const fetchImpl = (async () =>
			streamResponse(
				sseBody([
					{ role: "assistant", reasoning_content: "thinking..." },
					{ content: "done" },
				]),
			)) as unknown as typeof fetch;

		const result = await runTurn(modelFor("qwen3.6"), { fetch: fetchImpl });
		const thinking = result.content.find((block) => block.type === "thinking");
		expect(thinking).toBeDefined();
		// 1.7.0 encodes replay metadata, but the field kind stays the bare name,
		// so the next request evicts nothing from NaN's cache.
		expect((thinking as { thinkingSignature?: string }).thinkingSignature).toBe("reasoning_content");
	});
});

describe("pi-ai 1.7.0 contract — the 1.6.0 wire pins survive the realign", () => {
	test("the catalog still pins supportsDeveloperRole false, so system stays the instruction role", async () => {
		for (const id of NAN_GENERATED_MODELS.map((e) => e.id)) {
			expect(modelFor(id).compat?.supportsDeveloperRole).toBe(false);
		}
		let body: Json = {};
		const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
			body = JSON.parse(init!.body as string) as Json;
			return streamResponse(sseBody([{ role: "assistant", content: "ok" }]));
		}) as unknown as typeof fetch;
		const provider = await createNanCompatibleProvider(NAN_PROVIDER);
		const stream = provider.stream(
			modelFor("qwen3.6"),
			normalizeContext({
				systemPrompt: "You are a NaN helper",
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] as never,
			}),
			{ apiKey: "sk-test", fetch: fetchImpl },
		);
		for await (const _event of stream) {
			// consume
		}
		const messages = body.messages as Array<{ role: string; content: unknown }>;
		expect(messages[0]?.role).toBe("system");
		expect(messages.some((message) => message.role === "developer")).toBe(false);
	});

	test("no request carries a strict tool schema (supportsStrictMode stays false)", async () => {
		let body: Json = {};
		const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
			body = JSON.parse(init!.body as string) as Json;
			return streamResponse(sseBody([{ role: "assistant", content: "ok" }]));
		}) as unknown as typeof fetch;
		const provider = await createNanCompatibleProvider(NAN_PROVIDER);
		const stream = provider.stream(
			modelFor("qwen3.6"),
			normalizeContext({
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] as never,
				tools: [
					{
						name: "mcp__nan_media__list_models",
						description: "list models",
						parameters: {
							type: "object",
							properties: { filter: { type: "string" } },
						},
					},
				] as never,
			}),
			{ apiKey: "sk-test", fetch: fetchImpl },
		);
		for await (const _event of stream) {
			// consume
		}
		const tools = body.tools as Array<Record<string, Json>>;
		expect(tools).toHaveLength(1);
		expect(tools[0]!.function).not.toHaveProperty("strict");
	});
});

describe("pi-ai 1.7.0 contract — an absent maxTokens sends no budget field at all", () => {
	test("the provider stream never fills in model.maxTokens", async () => {
		const model = modelFor("kimi-k3.1-pro");
		let body: Json = {};
		const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
			body = JSON.parse(init!.body as string) as Json;
			return streamResponse(sseBody([{ role: "assistant", content: "ok" }]));
		}) as unknown as typeof fetch;
		await runTurn(model, { fetch: fetchImpl });
		// `buildParams` only emits a budget when `options.maxTokens` is set, and the
		// openai-completions path does not run `buildBaseOptions`, so a catalog
		// ceiling (1,048,576 for kimi-k3.1-pro) rides along only when pi passes it.
		expect(model.maxTokens).toBe(1_048_576);
		expect(body).not.toHaveProperty("max_tokens");
		expect(body).not.toHaveProperty("max_completion_tokens");
	});
});

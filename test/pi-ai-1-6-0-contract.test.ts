/**
 * CONTRACT TESTS — pi-ai 1.6.0 OpenAI-completions behavior this package
 * depends on (issue #45, devDependencies 1.5.1 → 1.6.0).
 *
 * These pin the upstream behaviors recorded as "Verified API facts" in
 * AGENTS.md. When one fails, an upstream pi-ai release changed behavior the
 * package silently relies on — re-verify against the new release before
 * touching package code:
 *
 *  1. NaN keeps sending the `system` role. pi-ai 1.6.0 flipped the
 *     `supportsDeveloperRole` default to "OpenAI's own API only" (#10741) and
 *     sent every other OpenAI-compatible host a `system` role; this package's
 *     wire never moves because the generated catalog pins
 *     `supportsDeveloperRole: false` for every NaN entry.
 *  2. A top-level `usage.reasoning_tokens` is counted. pi-ai 1.6.0 falls back
 *     to it when `completion_tokens_details.reasoning_tokens` is absent (0 on
 *     1.5.1). NaN reports the nested field; this is tolerance for gateways
 *     that report the flat one.
 *  3. No NaN request carries `strict` tool schemas. 1.6.0 makes a schema node
 *     without `type` unsupported in strict mode (#12049), but
 *     `openai-completions` defaults `supportsStrictMode: false`, so NaN never
 *     takes that path.
 *  4. NaN's mid-stream drop texts are retryable. 1.6.0 adds
 *     `connection closed`, bare socket error codes (`ECONNRESET`, `EPIPE`,
 *     `ETIMEDOUT`, …) and `connection reset by peer` to the retryable pattern
 *     (#12064, #12128); 1.5.1 did not retry them. NaN's LiteLLM gateway closes
 *     SSE streams mid-turn (issue #2), so this coverage matters.
 *
 * Wire-level, no network: fetch is injected.
 */

import { describe, expect, test } from "bun:test";
import { normalizeContext, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
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

const FINAL_USAGE_CHUNK = (usage: Json): string =>
	`data: ${JSON.stringify({
		id: "1",
		object: "chat.completion.chunk",
		created: 1,
		model: "test",
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage,
	})}\n\n`;

/** Mock NaN gateway that captures the last request body and replays one answer. */
function capturingGateway(usage: Json = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }) {
	let body: Json = {};
	const chunks = [
		'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n',
		FINAL_USAGE_CHUNK(usage),
		"data: [DONE]\n\n",
	];
	const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
		body = JSON.parse(init!.body as string) as Json;
		return new Response(
			new ReadableStream({
				start(controller) {
					const encoder = new TextEncoder();
					for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
					controller.close();
				},
			}),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
	}) as unknown as typeof fetch;
	return { fetchImpl, lastBody: () => body };
}

interface RunOptions {
	systemPrompt?: string;
	tools?: Array<Record<string, unknown>>;
}

/** Drive one turn through the real provider and consume to completion. */
async function runTurn(
	model: Model<"openai-completions">,
	gateway: { fetchImpl: typeof fetch },
	options: RunOptions = {},
): Promise<AssistantMessage> {
	const provider = await createNanCompatibleProvider(NAN_PROVIDER);
	const context = normalizeContext({
		systemPrompt: options.systemPrompt,
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] as never,
		tools: (options.tools ?? []) as never,
	});
	const stream = provider.stream(model, context, { apiKey: "sk-test", fetch: gateway.fetchImpl });
	for await (const _event of stream) {
		// consume to completion
	}
	return await stream.result();
}

function failedAssistant(message: string): Parameters<typeof isRetryableAssistantError>[0] {
	return {
		role: "assistant",
		provider: "nan",
		api: "openai-completions",
		model: "qwen3.6",
		content: [{ type: "text", text: "" }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: message,
		timestamp: 0,
	} as unknown as Parameters<typeof isRetryableAssistantError>[0];
}

describe("pi-ai 1.6.0 contract — NaN keeps the system role (#10741 default flip)", () => {
	test("the catalog pins supportsDeveloperRole false for every model", () => {
		for (const id of NAN_GENERATED_MODELS.map((e) => e.id)) {
			expect(modelFor(id).compat?.supportsDeveloperRole).toBe(false);
		}
	});

	test("a system prompt reaches NaN as messages[0].role === 'system'", async () => {
		const gateway = capturingGateway();
		await runTurn(modelFor("qwen3.6"), gateway, { systemPrompt: "You are a NaN helper" });
		const messages = gateway.lastBody().messages as Array<{ role: string; content: unknown }>;
		expect(messages[0]?.role).toBe("system");
		expect(messages[0]?.content).toContain("You are a NaN helper");
		expect(messages.some((message) => message.role === "developer")).toBe(false);
	});
});

describe("pi-ai 1.6.0 contract — flat usage.reasoning_tokens is counted", () => {
	test("top-level reasoning_tokens lands in message.usage.reasoning", async () => {
		const gateway = capturingGateway({
			prompt_tokens: 10,
			completion_tokens: 20,
			total_tokens: 30,
			reasoning_tokens: 11,
		});
		const result = await runTurn(modelFor("deepseek-v4-flash"), gateway);
		expect(result.usage.reasoning).toBe(11);
	});

	test("nested completion_tokens_details.reasoning_tokens still wins (NaN's reported shape)", async () => {
		const gateway = capturingGateway({
			prompt_tokens: 10,
			completion_tokens: 20,
			total_tokens: 30,
			reasoning_tokens: 11,
			completion_tokens_details: { reasoning_tokens: 5 },
		});
		const result = await runTurn(modelFor("deepseek-v4-flash"), gateway);
		expect(result.usage.reasoning).toBe(5);
	});
});

describe("pi-ai 1.6.0 contract — NaN never takes the strict-schema path (#12049)", () => {
	test("a tool whose schema has a node without type is sent without strict", async () => {
		const gateway = capturingGateway();
		await runTurn(modelFor("qwen3.6"), gateway, {
			tools: [
				{
					name: "mcp__nan_media__list_models",
					description: "list models",
					parameters: {
						type: "object",
						properties: { filter: { description: "no explicit type" } },
					},
				},
			],
		});
		const tools = gateway.lastBody().tools as Array<Record<string, Json>>;
		expect(tools).toHaveLength(1);
		const fn = tools[0]!.function as Json;
		expect(fn.name).toBe("mcp__nan_media__list_models");
		// 1.6.0 rejects typeless nodes in strict mode; supportsStrictMode false keeps the field off.
		expect(fn).not.toHaveProperty("strict");
	});
});

describe("pi-ai 1.6.0 contract — NaN's mid-stream drop texts are retryable (#12064, #12128)", () => {
	const newlyRetryable = ["Connection closed.", "read ECONNRESET", "write EPIPE", "connect ETIMEDOUT 1.2.3.4:443", "connection reset by peer"];

	for (const message of newlyRetryable) {
		test(`"${message}" is retryable`, () => {
			expect(isRetryableAssistantError(failedAssistant(message))).toBe(true);
		});
	}

	test("the deterministic NaN 400 stays non-retryable", () => {
		expect(isRetryableAssistantError(failedAssistant("Invalid request. Check your request parameters."))).toBe(false);
	});

	test("NaN's truncated-stream error stays retryable (issue #2)", () => {
		expect(isRetryableAssistantError(failedAssistant("Stream ended without finish_reason"))).toBe(true);
	});
});

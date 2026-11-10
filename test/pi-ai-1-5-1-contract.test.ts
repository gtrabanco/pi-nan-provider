/**
 * CONTRACT TESTS — pi-ai 1.5.1 OpenAI-completions behavior this package
 * documents for NaN users (CHANGELOG 1.5.1, README "compat escape hatches").
 *
 * These pin the upstream behaviors recorded as "Verified API facts" in
 * AGENTS.md. When one fails, an upstream pi-ai release changed behavior the
 * package silently relies on — re-verify against the new release before
 * touching package code:
 *
 *  1. `tools: []` is NOT sent for NaN models when the conversation has tool
 *     history and every tool is disabled (pi-ai 1.5.1, #11843). vLLM 0.20+
 *     behind LiteLLM rejects an empty tools array with a 400, and NaN sits
 *     behind LiteLLM. The only escape hatch is an explicit per-model
 *     `compat.requiresToolsWithToolHistory: true` in `models.json` — the
 *     catalog must never set it (detection for api.nan.builders is `false`).
 *  2. No catalog entry sets `requiresNonNullAssistantContent` or
 *     `promptCacheKeyMode`: pi-ai's safe defaults govern NaN (`prompt_cache_key`
 *     is never sent to a non-OpenAI baseUrl under the default `auto` mode).
 *
 * Wire-level, no network: fetch is injected.
 */

import { describe, expect, test } from "bun:test";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
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

/** Mock NaN gateway that captures the last request body and replays a simple answer. */
function capturingGateway() {
	let body: Json = {};
	const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
		body = JSON.parse(init!.body as string) as Json;
		const chunks = [
			'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n',
			'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
			'data: [DONE]\n\n',
		];
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

/** Drive one turn through the real provider and consume to completion. */
async function runTurn(model: Model<"openai-completions">, gateway: { fetchImpl: typeof fetch }): Promise<unknown> {
	const provider = await createNanCompatibleProvider(NAN_PROVIDER);
	const stream = provider.stream(model, normalizeContext({ messages: toolHistory() as never }), {
		apiKey: "sk-test",
		fetch: gateway.fetchImpl,
	});
	for await (const _event of stream) {
		// consume to completion
	}
	return await stream.result();
}

/** A conversation whose history carries tool calls and a tool result, with NO tools available. */
function toolHistory(): Array<Record<string, unknown>> {
	return [
		{ role: "user", content: [{ type: "text", text: "run the check" }] },
		{
			role: "assistant",
			provider: "nan",
			api: "openai-completions",
			model: "qwen3.6",
			content: [{ type: "toolCall", id: "call_1", name: "mcp__nan_media__list_models", arguments: {} }],
		},
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "mcp__nan_media__list_models",
			content: [{ type: "text", text: "[]" }],
		},
		{ role: "user", content: [{ type: "text", text: "now answer" }] },
	];
}

describe("pi-ai 1.5.1 contract — empty tools array is never sent to NaN (#11843)", () => {
	for (const id of NAN_GENERATED_MODELS.map((e) => e.id)) {
		test(`"${id}" omits "tools" on the wire for tool history with all tools disabled`, async () => {
			const model = modelFor(id);
			expect(model.compat?.requiresToolsWithToolHistory).toBeUndefined();

			const gateway = capturingGateway();
			await runTurn(model, gateway);
			const body = gateway.lastBody();
			// pi-ai <= 1.5.0 sent "tools": [] here; vLLM 0.20+ (behind LiteLLM) rejects it with a 400.
			expect(body).not.toHaveProperty("tools");
			expect(body.messages).toBeDefined();
		});
	}

	test("the catalog never sets the 1.5.1 compat opt-outs — pi-ai defaults govern NaN", () => {
		for (const id of NAN_GENERATED_MODELS.map((e) => e.id)) {
			const compat = modelFor(id).compat ?? {};
			expect(compat.requiresToolsWithToolHistory).toBeUndefined();
			expect(compat.requiresNonNullAssistantContent).toBeUndefined();
			expect(compat.promptCacheKeyMode).toBeUndefined();
		}
	});
});

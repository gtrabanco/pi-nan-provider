/**
 * ACCEPTANCE TESTS — issue #16
 * "finish_reason: 'length' with an empty answer when a NaN reasoning model
 * runs long — and max_tokens does not bound reasoning."
 *
 * https://github.com/gtrabanco/pi-nan-provider/issues/16
 *
 * The bug: pi-ai's buildRequest maps `reasoning: "off"` to
 * `reasoningEffort: undefined`, then fires the "off" branch which only
 * sends `reasoning_effort` when `model.thinkingLevelMap?.off` is a string.
 * The NaN catalog has ZERO entries with `thinkingLevelMap`, so `undefined`
 * → no `reasoning_effort` in the outgoing payload → NaN does NOT disable
 * reasoning → runaway reasoning (13-14K tokens) → `finish_reason: "length"`
 * with ZERO answer text → empty assistant message → wedge.
 *
 * The fix: every NaN reasoning model that needs an off-map carries
 * `thinkingLevelMap` in its generated catalog entry (source: issue #16,
 * measured 2026-09-27 against the live gateway). When `reasoning: "off"`
 * maps to undefined, the catalog's thinkingLevelMap.off supplies the
 * effort value (e.g. `"none"` for deepseek-v4-flash) which NaN accepts to
 * suppress reasoning.
 *
 * Measured values (issue #16, 2026-09-27, live gateway):
 * - deepseek-v4-flash: `off → "none"` → 0 reasoning tokens, answer produced
 * - glm5.3-flash: `off → "minimal"` → 38 reasoning tokens, answer produced
 * - "none" does NOT suppress on glm5.3-flash (13,382 reasoning tokens)
 *
 * These tests are FROZEN acceptance criteria. They drive the real pi-ai
 * `openai-completions` adapter end-to-end through the real provider against a
 * mock NaN gateway that captures the request body. No network: fetch is
 * injected.
 */

import { describe, expect, test } from "bun:test";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { toModel } from "../src/fetch-models.ts";
import { createNanCompatibleProvider } from "../src/provider-factory.ts";
import { NAN_PROVIDER } from "../src/providers.ts";
import { NAN_GENERATED_MODELS } from "../scripts/models.generated.ts";

type Json = Record<string, unknown>;

const SOURCE = { providerId: "nan", baseUrl: "https://api.nan.builders/v1" } as const;

/** A catalog model by id, optionally with extra fields applied. */
function modelFor(id: string, extra?: Partial<Model<"openai-completions">>): Model<"openai-completions"> {
	const entry = NAN_GENERATED_MODELS.find((e) => e.id === id);
	if (!entry) throw new Error(`generated catalog is missing model "${id}"`);
	return { ...toModel(entry, SOURCE), ...extra };
}

/**
 * Mock NaN gateway that captures the last request body and replays a simple
 * answer (no reasoning blocks — those are the gateway's responsibility).
 */
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
	const stream = provider.stream(
		model,
		normalizeContext({ systemPrompt: "You are a helper", messages: [{ role: "user", content: "hi" }] as never, tools: [] }),
		{ apiKey: "sk-test", fetch: gateway.fetchImpl },
	);
	for await (const _event of stream) {
		// consume to completion
	}
	return await stream.result();
}

describe("issue #16 — thinkingLevelMap flows to the wire", () => {
	test("deepseek-v4-flash with reasoning: 'off' sends reasoning_effort: 'none'", async () => {
		const model = modelFor("deepseek-v4-flash");
		expect(model.thinkingLevelMap?.off).toBe("none");
		expect(model.reasoning).toBe(true);
		expect(model.compat?.supportsReasoningEffort).toBe(true);

		const gateway = capturingGateway();
		await runTurn(model, gateway);

		// The decisive wire contract: reasoning_effort must be "none" (not absent).
		expect(gateway.lastBody().reasoning_effort).toBe("none");
	});

	test("glm5.3-flash with reasoning: 'off' sends reasoning_effort: 'minimal'", async () => {
		const model = modelFor("glm5.3-flash");
		expect(model.thinkingLevelMap?.off).toBe("minimal");
		expect(model.reasoning).toBe(true);
		expect(model.compat?.supportsReasoningEffort).toBe(true);

		const gateway = capturingGateway();
		await runTurn(model, gateway);

		// The decisive wire contract: reasoning_effort must be "minimal".
		expect(gateway.lastBody().reasoning_effort).toBe("minimal");
	});

	test("qwen3.6 with reasoning: 'off' sends reasoning_effort: 'none' (issue #16)", async () => {
		const model = modelFor("qwen3.6");
		expect(model.thinkingLevelMap?.off).toBe("none");
		expect(model.reasoning).toBe(true);
		expect(model.compat?.supportsReasoningEffort).toBe(true);

		const gateway = capturingGateway();
		await runTurn(model, gateway);

		// NaN docs: with no parameter qwen3.6 reasons by default (16,384-token
		// budget); off must send `none` to skip the reasoning phase entirely.
		expect(gateway.lastBody().reasoning_effort).toBe("none");
	});

	test("gemma4 with reasoning: 'off' sends reasoning_effort: 'none' (issue #16)", async () => {
		const model = modelFor("gemma4");
		expect(model.thinkingLevelMap?.off).toBe("none");
		expect(model.reasoning).toBe(true);
		expect(model.compat?.supportsReasoningEffort).toBe(true);

		const gateway = capturingGateway();
		await runTurn(model, gateway);

		// Same NaN docs contract as qwen3.6: reasoning ON by default, `none` skips.
		expect(gateway.lastBody().reasoning_effort).toBe("none");
	});

	test("a model with non-adjustable reasoning sends no reasoning_effort when reasoning: 'off'", async () => {
		// qwen3.8-flash accepts the parameter but its depth is not adjustable and
		// it has no `none` value, so the catalog declares no thinkingLevelMap:
		// pi cannot ask for off, and nothing is sent (the model's own default).
		const model = modelFor("qwen3.8-flash");
		expect(model.thinkingLevelMap).toBeUndefined();
		expect(model.reasoning).toBe(true);

		const gateway = capturingGateway();
		await runTurn(model, gateway);

		expect("reasoning_effort" in gateway.lastBody()).toBe(false);
	});

	test("deepseek-v4-flash reasoningEffortValues is ['none']", async () => {
		const entry = NAN_GENERATED_MODELS.find((e) => e.id === "deepseek-v4-flash");
		expect(entry).toBeDefined();
		expect(entry!.reasoningEffortValues).toEqual(["none"]);
		// The note must cite issue #16 as the source.
		expect(
			entry!.notes?.some((n) => n.includes("issue #16") || n.includes("#16")),
			"deepseek-v4-flash note must cite issue #16",
		).toBe(true);
	});

	test("glm5.3-flash reasoningEffortValues includes 'minimal'", async () => {
		const entry = NAN_GENERATED_MODELS.find((e) => e.id === "glm5.3-flash");
		expect(entry).toBeDefined();
		expect(entry!.reasoningEffortValues).toContain("minimal");
		// The note must cite issue #16 as the source.
		expect(
			entry!.notes?.some((n) => n.includes("issue #16") || n.includes("#16")),
			"glm5.3-flash note must cite issue #16",
		).toBe(true);
	});
});

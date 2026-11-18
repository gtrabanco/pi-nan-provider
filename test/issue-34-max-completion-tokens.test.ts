/**
 * ACCEPTANCE TESTS — issue #34 interim bound, reverted by issue #36.
 *
 * #34 "qwen3.8-flash: NaN confirms max_tokens does not bound reasoning and the
 * excess bills the quota — send max_completion_tokens as the interim bound."
 * https://github.com/gtrabanco/pi-nan-provider/issues/34
 *
 * #36 "Tracking: remove the qwen3.8-flash max_completion_tokens override when
 * NaN ships the max_tokens fix."
 * https://github.com/gtrabanco/pi-nan-provider/issues/36
 *
 * History:
 * - 2026-11-11 — NaN confirmed `max_tokens` did not bound the reasoning phase
 *   on `qwen3.8-flash`, the excess billed against the quota, and
 *   `max_completion_tokens` was respected. Package 1.5.3 sent that field as an
 *   interim bound with the sanitizer's rename gated per model.
 * - 2026-11-17 — NaN support reported the gateway fix deployed and validated
 *   (`max_tokens` honours the client budget). The interim override was removed
 *   in package 1.5.7; the per-model sanitizer opt-out stays because
 *   `qwen3.8-max` still declares the field on docs evidence.
 *
 * These tests are the revert contract. They drive the real pi-ai
 * `openai-completions` adapter end-to-end through the real provider (including
 * the strict-schema sanitizer wrapper) against a mock NaN gateway that captures
 * the request body. No network: fetch is injected.
 */

import { describe, expect, test } from "bun:test";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { toModel } from "../src/fetch-models.ts";
import { createNanCompatibleProvider } from "../src/provider-factory.ts";
import { NAN_PROVIDER } from "../src/providers.ts";
import { NAN_GENERATED_MODELS } from "../scripts/models.generated.ts";
import { MANUAL_OVERRIDES } from "../scripts/manual-overrides.ts";
import { sanitizeOpenAICompatPayload } from "../src/openai-compat-sanitizer.ts";

type Json = Record<string, unknown>;

const SOURCE = { providerId: "nan", baseUrl: "https://api.nan.builders/v1" } as const;

/** A catalog model by id. */
function modelFor(id: string): Model<"openai-completions"> {
	const entry = NAN_GENERATED_MODELS.find((e) => e.id === id);
	if (!entry) throw new Error(`generated catalog is missing model "${id}"`);
	return toModel(entry, SOURCE);
}

/**
 * Mock NaN gateway that captures the last request body and replays a simple
 * answer (no reasoning blocks — the gateway's responsibility).
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

/** Drive one turn through the real provider (sanitizer included) and consume it. */
async function runTurn(model: Model<"openai-completions">, gateway: { fetchImpl: typeof fetch }): Promise<unknown> {
	const provider = await createNanCompatibleProvider(NAN_PROVIDER);
	const stream = provider.stream(
		model,
		normalizeContext({ systemPrompt: "You are a helper", messages: [{ role: "user", content: "hi" }] as never, tools: [] }),
		{ apiKey: "sk-test", fetch: gateway.fetchImpl, maxTokens: 32_768 },
	);
	for await (const _event of stream) {
		// consume to completion
	}
	return await stream.result();
}

describe("issue #36 — qwen3.8-flash is back on max_tokens", () => {
	test("qwen3.8-flash catalog entry no longer overrides maxTokensField", () => {
		const entry = NAN_GENERATED_MODELS.find((e) => e.id === "qwen3.8-flash");
		expect(entry).toBeDefined();
		expect(entry!.compat?.maxTokensField).toBe("max_tokens");
		expect(MANUAL_OVERRIDES["qwen3.8-flash"]?.maxTokensField).toBeUndefined();
	});

	test("the qwen3.8-flash note records the revert and its provenance", () => {
		const entry = NAN_GENERATED_MODELS.find((e) => e.id === "qwen3.8-flash");
		const note = entry!.notes?.join(" ") ?? MANUAL_OVERRIDES["qwen3.8-flash"]?.note ?? "";
		// History stays: the interim bound existed and was billed-aware.
		expect(note).toContain("#34");
		// The revert traces to NaN support confirming the deployed gateway fix.
		expect(note).toContain("2026-11-17");
		expect(note).toContain("#36");
		expect(/max_tokens/i.test(note)).toBe(true);
	});

	// `qwen3.8-max` keeps the field on docs evidence (docs/models 2026-11-17);
	// its contract is independent of the #34 interim bound.
	test("qwen3.8-max keeps maxTokensField 'max_completion_tokens'", () => {
		const entry = NAN_GENERATED_MODELS.find((e) => e.id === "qwen3.8-max");
		expect(entry).toBeDefined();
		expect(entry!.compat?.maxTokensField).toBe("max_completion_tokens");
	});

	test("every other catalog model keeps maxTokensField 'max_tokens'", () => {
		expect(NAN_GENERATED_MODELS.length).toBeGreaterThan(1);
		for (const entry of NAN_GENERATED_MODELS) {
			if (entry.id === "qwen3.8-max") {
				expect(entry.compat?.maxTokensField, entry.id).toBe("max_completion_tokens");
				continue;
			}
			expect(entry.compat?.maxTokensField, entry.id).toBe("max_tokens");
		}
	});

	test("qwen3.8-flash wire request sends max_tokens (not max_completion_tokens)", async () => {
		const model = modelFor("qwen3.8-flash");
		expect(model.compat?.maxTokensField).toBe("max_tokens");

		const gateway = capturingGateway();
		await runTurn(model, gateway);

		expect(gateway.lastBody().max_tokens).toBe(32_768);
		expect("max_completion_tokens" in gateway.lastBody()).toBe(false);
	});

	test("qwen3.8-max wire request still sends max_completion_tokens", async () => {
		const model = modelFor("qwen3.8-max");
		expect(model.compat?.maxTokensField).toBe("max_completion_tokens");

		const gateway = capturingGateway();
		await runTurn(model, gateway);

		expect(gateway.lastBody().max_completion_tokens).toBe(32_768);
		expect("max_tokens" in gateway.lastBody()).toBe(false);
	});

	// Previous-behavior control (issue #20 line): a flash model with the classic
	// field keeps sending `max_tokens` and never `max_completion_tokens`.
	test("deepseek-v4-flash wire request still sends max_tokens", async () => {
		const model = modelFor("deepseek-v4-flash");

		const gateway = capturingGateway();
		await runTurn(model, gateway);

		expect(gateway.lastBody().max_tokens).toBe(32_768);
		expect("max_completion_tokens" in gateway.lastBody()).toBe(false);
	});

	// Sanitizer gate, default side: without a per-model option the documented
	// rename still runs — hand-built payloads for non-overridden models stay on
	// the strict `max_tokens` shape.
	test("sanitizer keeps renaming max_completion_tokens → max_tokens by default", () => {
		const payload: Json = { model: "qwen3.6", max_completion_tokens: 123, messages: [{ role: "user", content: "hi" }] };
		const out = sanitizeOpenAICompatPayload(payload) as Json;
		expect(out.max_tokens).toBe(123);
		expect("max_completion_tokens" in out).toBe(false);
	});

	// Sanitizer gate, opt-in side: the mechanism stays for the model that still
	// declares `maxTokensField` (qwen3.8-max).
	test("sanitizer preserves max_completion_tokens when the model opts in", () => {
		const payload: Json = { model: "qwen3.8-max", max_completion_tokens: 32_768, messages: [{ role: "user", content: "hi" }] };
		const out = sanitizeOpenAICompatPayload(payload, { preserveMaxCompletionTokens: true }) as Json;
		expect(out.max_completion_tokens).toBe(32_768);
		expect("max_tokens" in out).toBe(false);
	});
});

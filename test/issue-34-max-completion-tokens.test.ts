/**
 * ACCEPTANCE TESTS — issue #34
 * "qwen3.8-flash: NaN confirms max_tokens does not bound reasoning and the
 * excess bills the quota — send max_completion_tokens as the interim bound."
 *
 * https://github.com/gtrabanco/pi-nan-provider/issues/34
 *
 * The bug: the catalog sends `maxTokensField: "max_tokens"` for every model.
 * NaN confirmed maintainer-side (2026-11-11, quoted in the issue) that on
 * `qwen3.8-flash` `max_tokens` does NOT bound the reasoning phase, the excess
 * bills against the quota, and `max_completion_tokens` IS respected as the
 * interim bound until NaN ships their prepared fix.
 *
 * The fix: `compat.maxTokensField: "max_completion_tokens"` for qwen3.8-flash
 * only (the issue's conservative scope — accepting the field on the other
 * flash models is unverified live), with the sanitizer's
 * `max_completion_tokens → max_tokens` rename gated per model so the field
 * survives to the wire. Provenance: NaN's reply, not a docs URL — the
 * published OpenAPI schema does not document `max_completion_tokens`.
 *
 * These tests are FROZEN acceptance criteria. They drive the real pi-ai
 * `openai-completions` adapter end-to-end through the real provider (including
 * the strict-schema sanitizer wrapper) against a mock NaN gateway that
 * captures the request body. No network: fetch is injected.
 *
 * Revert contract (issue #34): once NaN ships their gateway fix, the catalog
 * override must be REMOVED. The provenance test below fails loudly until it
 * is — that test is the revert tripwire, not something to relax.
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

describe("issue #34 — max_completion_tokens bounds qwen3.8-flash reasoning", () => {
	// FROZEN acceptance criterion C1/C3: the catalog pins the field on the one
	// model NaN named, with provenance tracing to their reply (not a docs URL).
	test("qwen3.8-flash catalog entry declares maxTokensField 'max_completion_tokens' with 2026-11-11 provenance", () => {
		const entry = NAN_GENERATED_MODELS.find((e) => e.id === "qwen3.8-flash");
		expect(entry).toBeDefined();
		expect(entry!.compat?.maxTokensField).toBe("max_completion_tokens");

		// Provenance (no-fabrication rule): the value traces to NaN's maintainer
		// reply of 2026-11-11 — the issue quotes it.
		const note = entry!.notes?.join(" ") ?? MANUAL_OVERRIDES["qwen3.8-flash"]?.note ?? "";
		expect(note).toContain("2026-11-11");
		expect(note.includes("issue #34") || note.includes("#34")).toBe(true);

		// Revert tripwire (C4): the note must say how to undo the override.
		expect(
			/revert|remove the override|shipping their fix|once NaN ships/i.test(note),
			"provenance note must record the revert plan",
		).toBe(true);
	});

	// FROZEN acceptance criterion C2: scope is one model. Every other generated
	// entry keeps the LiteLLM-confirmed `max_tokens` field.
	test("every other catalog model keeps maxTokensField 'max_tokens'", () => {
		expect(NAN_GENERATED_MODELS.length).toBeGreaterThan(1);
		for (const entry of NAN_GENERATED_MODELS) {
			if (entry.id === "qwen3.8-flash") continue;
			expect(entry.compat?.maxTokensField, entry.id).toBe("max_tokens");
		}
	});

	// FROZEN acceptance criterion C1: the wire carries the new field end-to-end.
	test("qwen3.8-flash wire request sends max_completion_tokens (not max_tokens)", async () => {
		const model = modelFor("qwen3.8-flash");
		expect(model.compat?.maxTokensField).toBe("max_completion_tokens");

		const gateway = capturingGateway();
		await runTurn(model, gateway);

		// The decisive wire contract.
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

	// Sanitizer gate, default side (O4): without a per-model option the
	// documented rename still runs — hand-built payloads for non-overridden
	// models stay on the strict `max_tokens` shape.
	test("sanitizer keeps renaming max_completion_tokens → max_tokens by default", () => {
		const payload: Json = { model: "qwen3.6", max_completion_tokens: 123, messages: [{ role: "user", content: "hi" }] };
		const out = sanitizeOpenAICompatPayload(payload) as Json;
		expect(out.max_tokens).toBe(123);
		expect("max_completion_tokens" in out).toBe(false);
	});

	// Sanitizer gate, opt-in side (O5): a model declaring
	// maxTokensField: "max_completion_tokens" keeps the field after
	// sanitization — this is what lets the wire contract hold.
	test("sanitizer preserves max_completion_tokens for a max_completion_tokens model", () => {
		const payload: Json = { model: "qwen3.8-flash", max_completion_tokens: 32_768, messages: [{ role: "user", content: "hi" }] };
		const out = sanitizeOpenAICompatPayload(payload, { preserveMaxCompletionTokens: true }) as Json;
		expect(out.max_completion_tokens).toBe(32_768);
		expect("max_tokens" in out).toBe(false);
	});
});

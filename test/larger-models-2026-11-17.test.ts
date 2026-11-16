/**
 * ACCEPTANCE TESTS — NaN catalog update of 2026-11-17
 * (`qwen4-max` + `hy4-flash`, and the documented limits the catalog was
 * carrying stale).
 *
 * The NaN docs (https://nan.builders/docs/models, checked 2026-11-17) now
 * document every chat model served behind api.nan.builders, including the two
 * ids the catalog never had — `qwen4-max` and `hy4-flash` — which the live
 * `GET /v1/models` lists and models.dev provider `nan` does not.
 *
 * Without catalog entries those ids fall back to UNKNOWN_MODEL_LIMITS
 * (128K context / 4K output, reasoning off) and pi compacts around 100K of a
 * 1M-token window; with a stale entry, `glm5.3` accepts images that the
 * gateway rejects with 400 and `qwen3.8-max` lets reasoning run outside the
 * client budget.
 *
 * No network: the payloads below are the 2026-11-17 `/v1/models` snapshot and
 * every fetch is injected.
 */

import { describe, expect, test } from "bun:test";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { mergeLiveWithGenerated, toModel } from "../src/fetch-models.ts";
import { createNanCompatibleProvider } from "../src/provider-factory.ts";
import { NAN_PROVIDER } from "../src/providers.ts";
import { GENERATED_CATALOG_META, NAN_GENERATED_MODELS } from "../scripts/models.generated.ts";

type Json = Record<string, unknown>;

const SOURCE = { providerId: "nan", baseUrl: "https://api.nan.builders/v1" } as const;

/** `GET /v1/models` chat + non-chat ids, 2026-11-17 (token-free call). */
const LIVE_CHAT_IDS = [
	"deepseek-v4-flash",
	"deepseek-v4-pro",
	"gemma4",
	"glm5.3",
	"glm5.3-flash",
	"hy4",
	"hy4-flash",
	"kimi-k3.1-pro",
	"mimo-v2.6-flash",
	"qwen3.6",
	"qwen3.8-flash",
	"qwen3.8-max",
	"qwen4-max",
] as const;
const LIVE_NON_CHAT_IDS = [
	"flux-2-klein",
	"kokoro",
	"minimax-h3",
	"qwen-image-2.1",
	"qwen3-embedding",
	"rerank",
	"whisper",
] as const;

const byId = new Map(NAN_GENERATED_MODELS.map((entry) => [entry.id, entry]));

function modelFor(id: string): Model<"openai-completions"> {
	const entry = byId.get(id);
	if (!entry) throw new Error(`generated catalog is missing model "${id}"`);
	return toModel(entry, SOURCE);
}

/** Mock NaN gateway: captures the request body, replays a plain answer. */
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

/** One turn through the real provider + sanitizer. `reasoning` defaults to off. */
async function runTurn(
	model: Model<"openai-completions">,
	gateway: { fetchImpl: typeof fetch },
	options: { maxTokens?: number; reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" } = {},
): Promise<unknown> {
	const provider = await createNanCompatibleProvider(NAN_PROVIDER);
	const stream = provider.stream(
		model,
		normalizeContext({
			systemPrompt: "You are a helper",
			messages: [{ role: "user", content: "hi" }] as never,
			tools: [],
		}),
		{
			apiKey: "sk-test",
			fetch: gateway.fetchImpl,
			...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
			...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
		},
	);
	for await (const _event of stream) {
		// consume to completion
	}
	return await stream.result();
}

describe("2026-11-17 — the two new models reach the catalog", () => {
	const NEW_MODELS = [
		{
			id: "qwen4-max",
			name: "Qwen4 Max",
			contextWindow: 1_000_000,
			maxTokens: 131_072,
			input: ["text", "image"],
			efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
		},
		{
			id: "hy4-flash",
			name: "Hy4 Flash",
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			input: ["text", "image"],
			efforts: ["none"],
		},
	] as const;

	for (const expected of NEW_MODELS) {
		test(`${expected.id} ships its documented capabilities`, () => {
			const entry = byId.get(expected.id);
			expect(entry, `${expected.id} must be in the generated catalog`).toBeDefined();
			expect(entry!.name).toBe(expected.name);
			expect(entry!.contextWindow).toBe(expected.contextWindow);
			expect(entry!.maxTokens).toBe(expected.maxTokens);
			expect(entry!.input).toEqual([...expected.input]);
			expect(entry!.reasoning).toBe(true);
			expect(entry!.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			expect(entry!.reasoningEffortValues).toEqual([...expected.efforts]);
			// Both bound reasoning + answer in the classic `max_tokens` field.
			expect(entry!.compat?.maxTokensField).toBe("max_tokens");
			expect(entry!.compat?.supportsReasoningEffort).toBe(true);
			// `reasoning: off` must reach the gateway as `reasoning_effort: none`.
			expect(entry!.thinkingLevelMap?.off).toBe("none");
		});

		test(`${expected.id} carries docs/models provenance (2026-11-17)`, () => {
			const entry = byId.get(expected.id);
			const note = (entry!.notes ?? []).join(" ");
			expect(note).toContain("https://nan.builders/docs/models");
			expect(note).toContain("2026-11-17");
			expect(note).toContain(expected.id);
		});
	}
});

describe("2026-11-17 — documented limits replace the stale 32,768 default", () => {
	const DOCUMENTED = [
		// id, contextWindow, maxTokens, input, maxTokensField
		{ id: "hy4", contextWindow: 1_048_576, maxTokens: 65_536, input: ["text", "image"], field: "max_tokens" },
		{ id: "kimi-k3.1-pro", contextWindow: 1_048_576, maxTokens: 1_048_576, input: ["text", "image"], field: "max_tokens" },
		{ id: "deepseek-v4-pro", contextWindow: 1_048_576, maxTokens: 393_216, input: ["text"], field: "max_tokens" },
		{ id: "qwen3.8-max", contextWindow: 1_000_000, maxTokens: 131_072, input: ["text", "image"], field: "max_completion_tokens" },
		{ id: "qwen4-max", contextWindow: 1_000_000, maxTokens: 131_072, input: ["text", "image"], field: "max_tokens" },
	] as const;

	for (const expected of DOCUMENTED) {
		test(`${expected.id}: ${expected.contextWindow} / ${expected.maxTokens} / ${expected.field}`, () => {
			const entry = byId.get(expected.id);
			expect(entry).toBeDefined();
			expect(entry!.contextWindow).toBe(expected.contextWindow);
			expect(entry!.maxTokens).toBe(expected.maxTokens);
			expect(entry!.input).toEqual([...expected.input]);
			expect(entry!.compat?.maxTokensField).toBe(expected.field);
		});
	}

	test("glm5.3 is text-only (the docs state an image answers 400)", () => {
		const entry = byId.get("glm5.3");
		expect(entry).toBeDefined();
		expect(entry!.input).toEqual(["text"]);
		// Documented ladder: `none` is applied as `minimal`, so `off` maps there.
		expect(entry!.reasoningEffortValues).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
		expect(entry!.thinkingLevelMap?.off).toBe("minimal");
	});

	test("glm5.3-flash keeps its 1M window and maps off to minimal", () => {
		const entry = byId.get("glm5.3-flash");
		expect(entry!.contextWindow).toBe(1_048_576);
		expect(entry!.maxTokens).toBe(131_072);
		expect(entry!.thinkingLevelMap?.off).toBe("minimal");
		expect(entry!.reasoningEffortValues).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	test("mimo-v2.6-flash declares the documented levels (minimal→low, xhigh→max) and keeps off→none", () => {
		const entry = byId.get("mimo-v2.6-flash");
		expect(entry!.reasoningEffortValues).toEqual(["none", "low", "medium", "high", "max"]);
		expect(entry!.thinkingLevelMap?.off).toBe("none");
	});

	test("deepseek-v4-flash declares the documented steering ladder while keeping off→none", () => {
		const entry = byId.get("deepseek-v4-flash");
		expect(entry!.reasoningEffortValues).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
		expect(entry!.thinkingLevelMap?.off).toBe("none");
		// The measured ceiling stays: the gateway rejects max_tokens above ~256k.
		expect(entry!.maxTokens).toBe(32_768);
	});

	test("qwen3.6 and gemma4 declare the documented ladder including xhigh", () => {
		for (const id of ["qwen3.6", "gemma4"]) {
			const entry = byId.get(id);
			expect(entry!.reasoningEffortValues, id).toEqual([
				"none",
				"minimal",
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			]);
			expect(entry!.thinkingLevelMap?.off, id).toBe("none");
		}
	});
});

describe("2026-11-17 — reasoning control reaches the wire", () => {
	// `none` is the documented off switch and it "works on every model except
	// GLM": the catalog must supply it when pi maps reasoning:"off" to undefined.
	for (const id of ["qwen4-max", "hy4-flash", "hy4", "qwen3.8-flash", "qwen3.8-max"]) {
		test(`${id} with reasoning: "off" sends reasoning_effort: "none"`, async () => {
			const model = modelFor(id);
			expect(model.thinkingLevelMap?.off).toBe("none");

			const gateway = capturingGateway();
			await runTurn(model, gateway);

			expect(gateway.lastBody().reasoning_effort).toBe("none");
		});
	}

	for (const id of ["glm5.3", "glm5.3-flash"]) {
		test(`${id} with reasoning: "off" sends reasoning_effort: "minimal"`, async () => {
			const model = modelFor(id);
			expect(model.thinkingLevelMap?.off).toBe("minimal");

			const gateway = capturingGateway();
			await runTurn(model, gateway);

			expect(gateway.lastBody().reasoning_effort).toBe("minimal");
		});
	}

	// The docs keep these two out of the reasoning contract and state that the
	// `none` aliases are NOT mapped on them: nothing may be sent.
	for (const id of ["kimi-k3.1-pro", "deepseek-v4-pro"]) {
		test(`${id} sends no reasoning_effort (outside the documented contract)`, async () => {
			const model = modelFor(id);
			expect(model.thinkingLevelMap).toBeUndefined();
			expect(byId.get(id)!.reasoningEffortValues).toEqual([]);

			const gateway = capturingGateway();
			await runTurn(model, gateway);

			expect("reasoning_effort" in gateway.lastBody()).toBe(false);
		});
	}

	test("a documented level is forwarded verbatim for a new model", async () => {
		const gateway = capturingGateway();
		await runTurn(modelFor("qwen4-max"), gateway, { reasoningEffort: "high" });
		expect(gateway.lastBody().reasoning_effort).toBe("high");
	});
});

describe("2026-11-17 — qwen3.8-max bounds the client budget", () => {
	// The docs: `max_tokens` "only bounds the visible answer: the reasoning comes
	// on top of it. To cap the total ... use max_completion_tokens" — the same
	// quota blowout issue #34 fixed for qwen3.8-flash.
	test("qwen3.8-max sends max_completion_tokens, never max_tokens", async () => {
		const gateway = capturingGateway();
		await runTurn(modelFor("qwen3.8-max"), gateway, { maxTokens: 16_384 });

		expect(gateway.lastBody().max_completion_tokens).toBe(16_384);
		expect("max_tokens" in gateway.lastBody()).toBe(false);
	});

	test("the new models keep the classic max_tokens field", async () => {
		for (const id of ["qwen4-max", "hy4-flash"]) {
			const gateway = capturingGateway();
			await runTurn(modelFor(id), gateway, { maxTokens: 8_192 });
			expect(gateway.lastBody().max_tokens, id).toBe(8_192);
			expect("max_completion_tokens" in gateway.lastBody(), id).toBe(false);
		}
	});
});

describe("2026-11-17 — cost stays zero on every model", () => {
	// NaN bills a credit pool, not per-token USD. models.dev provider `nan`
	// started publishing a derived USD conversion on 2026-11-17; adopting it
	// would make pi display an estimate as real money, so the generator pins 0
	// and records why.
	test("no catalog model carries a per-token price", () => {
		for (const entry of NAN_GENERATED_MODELS) {
			expect(entry.cost, entry.id).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		}
		expect(
			GENERATED_CATALOG_META.notes.some((note) => note.startsWith("cost 0 on every model")),
			"the cost decision must be recorded in the catalog metadata",
		).toBe(true);
	});
});

describe("2026-11-17 — the live /models snapshot resolves to catalog capabilities", () => {
	test("every chat id from the live list is catalogued (no placeholder fallback)", () => {
		const merged = mergeLiveWithGenerated([...LIVE_CHAT_IDS, ...LIVE_NON_CHAT_IDS], SOURCE);

		expect(merged.unknown).toEqual([]);
		expect(merged.matched.sort()).toEqual([...LIVE_CHAT_IDS].sort());
		expect(merged.nonChat.sort()).toEqual([...LIVE_NON_CHAT_IDS].sort());

		for (const model of merged.models) {
			// The placeholder would be 128K / 4K / text-only / reasoning off.
			expect(model.contextWindow, model.id).toBeGreaterThanOrEqual(262_144);
			expect(model.maxTokens, model.id).toBeGreaterThan(4_096);
			expect(model.reasoning, model.id).toBe(true);
		}
	});

	test("qwen4-max and hy4-flash do not fall back to the unknown-model placeholder", () => {
		const merged = mergeLiveWithGenerated(["qwen4-max", "hy4-flash"], SOURCE);
		const qwen = merged.models.find((model) => model.id === "qwen4-max")!;
		const hy = merged.models.find((model) => model.id === "hy4-flash")!;

		expect(qwen.contextWindow).toBe(1_000_000);
		expect(qwen.maxTokens).toBe(131_072);
		expect(qwen.input).toEqual(["text", "image"]);
		expect(hy.contextWindow).toBe(1_048_576);
		expect(hy.maxTokens).toBe(65_536);
		expect(hy.thinkingLevelMap?.off).toBe("none");
	});
});

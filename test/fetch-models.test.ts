import { describe, expect, test } from "bun:test";
import { NAN_GENERATED_MODELS } from "../scripts/models.generated.ts";
import {
	baselineModels,
	fetchNanCompatibleModels,
	listLiveModelIds,
	mergeLiveWithGenerated,
	UNKNOWN_MODEL_LIMITS,
} from "../src/fetch-models.ts";

const SOURCE = { providerId: "nan", baseUrl: "https://api.nan.builders/v1" } as const;

/** Minimal fetch stub returning a fixed JSON body with the given status. */
function jsonFetch(body: unknown, status = 200): typeof fetch {
	return (async () =>
		new Response(typeof body === "string" ? body : JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		})) as unknown as typeof fetch;
}

/** Fetch stub that hangs until aborted — simulates a slow endpoint. */
function hangingFetch(): typeof fetch {
	return ((_input: unknown, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new Error("Aborted")));
		})) as unknown as typeof fetch;
}

/** Fetch stub capturing the request for assertions, then delegating. */
function capturingFetch(delegate: typeof fetch): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const stub = (async (input: unknown, init?: RequestInit) => {
		calls.push({ url: String(input), init: init ?? {} });
		return delegate(input as Parameters<typeof fetch>[0], init);
	}) as unknown as typeof fetch;
	return { fetch: stub, calls };
}

describe("listLiveModelIds", () => {
	test("returns trimmed, de-duplicated live ids in order", async () => {
		const ids = await listLiveModelIds({
			baseUrl: SOURCE.baseUrl,
			fetchImpl: jsonFetch({ data: [{ id: " qwen3.6 " }, { id: "qwen3.6" }, { id: "glm5.2" }, { id: "" }, {}] }),
		});
		expect(ids).toEqual(["qwen3.6", "glm5.2"]);
	});

	test("sends Authorization bearer header when an api key is given", async () => {
		const { fetch: stub, calls } = capturingFetch(jsonFetch({ data: [{ id: "qwen3.6" }] }));
		await listLiveModelIds({ baseUrl: SOURCE.baseUrl, apiKey: "sk-test", fetchImpl: stub });
		expect(calls.length).toBe(1);
		expect(calls[0]!.url).toBe(`${SOURCE.baseUrl}/models`);
		const headers = calls[0]!.init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer sk-test");
	});

	test("sends no Authorization header without an api key", async () => {
		const { fetch: stub, calls } = capturingFetch(jsonFetch({ data: [{ id: "qwen3.6" }] }));
		await listLiveModelIds({ baseUrl: SOURCE.baseUrl, fetchImpl: stub });
		const headers = calls[0]!.init.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
	});

	test("non-OK status yields undefined", async () => {
		const ids = await listLiveModelIds({
			baseUrl: SOURCE.baseUrl,
			fetchImpl: jsonFetch({ error: { message: "No api key passed in." } }, 401),
		});
		expect(ids).toBeUndefined();
	});

	test("timeout aborts and yields undefined", async () => {
		const start = Date.now();
		const ids = await listLiveModelIds({
			baseUrl: SOURCE.baseUrl,
			timeoutMs: 25,
			fetchImpl: hangingFetch(),
		});
		expect(ids).toBeUndefined();
		expect(Date.now() - start).toBeLessThan(2000);
	});

	test("malformed JSON yields undefined", async () => {
		const ids = await listLiveModelIds({
			baseUrl: SOURCE.baseUrl,
			fetchImpl: jsonFetch("<html>gateway error</html>"),
		});
		expect(ids).toBeUndefined();
	});

	test("non-array data yields undefined", async () => {
		const ids = await listLiveModelIds({
			baseUrl: SOURCE.baseUrl,
			fetchImpl: jsonFetch({ models: [{ id: "qwen3.6" }] }),
		});
		expect(ids).toBeUndefined();
	});

	test("empty data array yields undefined", async () => {
		const ids = await listLiveModelIds({
			baseUrl: SOURCE.baseUrl,
			fetchImpl: jsonFetch({ data: [] }),
		});
		expect(ids).toBeUndefined();
	});
});

describe("mergeLiveWithGenerated", () => {
	test("live ids with generated matches keep the generated capabilities", () => {
		const merged = mergeLiveWithGenerated(["deepseek-v4-flash"], SOURCE);
		expect(merged.matched).toEqual(["deepseek-v4-flash"]);
		expect(merged.unknown).toEqual([]);
		const model = merged.models[0]!;
		// From models.dev provider nan: context 1M, output 384K.
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(384_000);
		expect(model.reasoning).toBe(true);
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("nan");
		expect(model.baseUrl).toBe(SOURCE.baseUrl);
	});

	test("live ids without generated matches get conservative unknown limits, not fabricated data", () => {
		const merged = mergeLiveWithGenerated(["brand-new-model", "qwen3-embedding"], SOURCE);
		expect(merged.unknown).toEqual(["brand-new-model", "qwen3-embedding"]);
		expect(merged.matched).toEqual([]);
		for (const model of merged.models) {
			expect(model.contextWindow).toBe(UNKNOWN_MODEL_LIMITS.contextWindow);
			expect(model.maxTokens).toBe(UNKNOWN_MODEL_LIMITS.maxTokens);
			expect(model.reasoning).toBe(false);
			expect(model.input).toEqual(["text"]);
			expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			expect(model.name).toBe(model.id);
		}
	});

	test("mixed catalog keeps generated and unknown entries side by side", () => {
		const merged = mergeLiveWithGenerated(["glm5.2", "future-model"], SOURCE);
		expect(merged.models.length).toBe(2);
		expect(merged.matched).toEqual(["glm5.2"]);
		expect(merged.unknown).toEqual(["future-model"]);
	});
});

describe("baselineModels", () => {
	test("returns the full generated catalog as pi-ai models", () => {
		const models = baselineModels(SOURCE);
		expect(models.length).toBe(NAN_GENERATED_MODELS.length);
		for (const model of models) {
			expect(model.api).toBe("openai-completions");
			expect(model.provider).toBe("nan");
			expect(model.baseUrl).toBe(SOURCE.baseUrl);
		}
	});

	test("covers the four founding models with models.dev-sourced limits", () => {
		const byId = new Map(baselineModels(SOURCE).map((model) => [model.id, model]));
		// Values pinned from models.dev provider "nan" (api.json), 2026-09-04.
		expect(byId.get("qwen3.6")).toMatchObject({ contextWindow: 262_144, maxTokens: 65_536, reasoning: true, input: ["text", "image"] });
		expect(byId.get("gemma4")).toMatchObject({ contextWindow: 262_144, maxTokens: 32_768, reasoning: true, input: ["text", "image"] });
		expect(byId.get("deepseek-v4-flash")).toMatchObject({ contextWindow: 1_000_000, maxTokens: 384_000, reasoning: true, input: ["text", "image"] });
		expect(byId.get("mimo-v2.5")).toMatchObject({ contextWindow: 1_048_576, maxTokens: 131_072, reasoning: true, input: ["text", "image"] });
	});

	test("deepseek-v4-flash image input carries its provenance note", () => {
		const entry = NAN_GENERATED_MODELS.find((model) => model.id === "deepseek-v4-flash");
		expect(entry?.notes?.join(" ")).toContain("nan.builders/docs/models");
	});
});

describe("fetchNanCompatibleModels", () => {
	test("success merges live ids with generated capabilities (partial catalog)", async () => {
		const models = await fetchNanCompatibleModels(SOURCE, {
			fetchImpl: jsonFetch({ data: [{ id: "qwen3.6" }, { id: "totally-new" }] }),
		});
		expect(models.length).toBe(2);
		const qwen = models.find((model) => model.id === "qwen3.6")!;
		expect(qwen.contextWindow).toBe(262_144); // generated data wins
		const newcomer = models.find((model) => model.id === "totally-new")!;
		expect(newcomer.contextWindow).toBe(UNKNOWN_MODEL_LIMITS.contextWindow);
	});

	test("timeout falls back entirely to the generated catalog", async () => {
		const models = await fetchNanCompatibleModels(SOURCE, {
			timeoutMs: 25,
			fetchImpl: hangingFetch(),
		});
		expect(models.length).toBe(NAN_GENERATED_MODELS.length);
	});

	test("auth error (401) falls back to the generated catalog", async () => {
		const models = await fetchNanCompatibleModels(SOURCE, {
			fetchImpl: jsonFetch({ error: { message: "Authentication Error" } }, 401),
		});
		expect(models.length).toBe(NAN_GENERATED_MODELS.length);
	});

	test("empty live catalog falls back to the generated catalog", async () => {
		const models = await fetchNanCompatibleModels(SOURCE, {
			fetchImpl: jsonFetch({ data: [] }),
		});
		expect(models.length).toBe(NAN_GENERATED_MODELS.length);
	});
});

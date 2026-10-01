/**
 * ACCEPTANCE TESTS — issue #19
 * "pi persists a dynamic provider's catalog in ~/.pi/agent/models-store.json.
 *  After upgrading this package, a stale persisted entry (written by an older
 *  package version, e.g. without the newly-added thinkingLevelMap) is restored
 *  by pi-ai as-is and, because its checkedAt is recent, is never refreshed —
 *  so new generated capability data never reaches the registered model and the
 *  #16 fix (thinkingLevelMap: {off:'none'} for deepseek-v4-flash) silently
 *  never applies."
 *
 * https://github.com/gtrabanco/pi-nan-provider/issues/19
 *
 * The fix: read-time overlay. The provider's getModels()/getAllModels()
 * re-check the generated catalog at call time and apply any capability data
 * the generated catalog owns when the model id exists there (same type).
 * The persisted store decides *which* ids exist; the generated catalog
 * decides *what capabilities* each id has.
 *
 * No network: fetch is injected everywhere.
 */

import { describe, expect, test } from "bun:test";
import type { ImageModel, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { NAN_GENERATED_MODELS } from "../scripts/models.generated.ts";
import { createNanCompatibleProvider } from "../src/provider-factory.ts";
import { NAN_PROVIDER } from "../src/providers.ts";

// ── Test helpers ────────────────────────────────────────────────────────────

/** Build a stale stored model entry: a snapshot written by an older catalog
 * version that lacks thinkingLevelMap and has an older compat. */
function staleModelEntry(
	id: string,
	overrides: Partial<Model<"openai-completions">> = {},
): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "nan",
		baseUrl: "https://api.nan.builders/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000, // deliberately stale — should be replaced
		maxTokens: 4_096, // deliberately stale
		// NO thinkingLevelMap — that is the bug we are fixing
		...(overrides as object),
	};
}

/** Build a stale stored IMAGE model entry. */
function staleImageModelEntry(
	id: string,
): ImageModel<"nan-images"> {
	return {
		id,
		name: id,
		type: "image",
		api: "nan-images",
		provider: "nan",
		baseUrl: "https://api.nan.builders/v1",
		input: ["text"],
		output: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

/** A minimal ModelsStoreEntry as pi would read from disk. */
function storedEntry(models: unknown[]): unknown {
	return {
		models,
		lastModified: Date.now(),
		checkedAt: Date.now() - 60_000, // 1 min ago — pi won't refresh
	};
}

/** Create a minimal RefreshModelsContext with no network and a fake publish. */
function refreshContext(
	overrides: Partial<import("@earendil-works/pi-ai").RefreshModelsContext> = {},
): import("@earendil-works/pi-ai").RefreshModelsContext {
	const controller = new AbortController();
	return {
		allowNetwork: false,
		signal: controller.signal,
		publish: async (publication) => {
			publication.update?.();
			return true;
		},
		...overrides,
	};
}

/** Capturing gateway: mimics the one in issue-16 test. */
function capturingGateway() {
	let body: Record<string, unknown> = {};
	const fetchImpl = (async (url: unknown, init?: RequestInit) => {
		if (typeof url === "string" && url.includes("/chat/completions")) {
			body = JSON.parse(init!.body as string) as Record<string, unknown>;
		}
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

/** Minimal JSON body for /models endpoint. */
function jsonModelsBody(ids: string[]) {
	return { data: ids.map((id) => ({ id })) };
}

// ── Test: stale store overlay (chat models) ─────────────────────────────────

describe("issue #19 — stale catalog overlay (chat models)", () => {
	test(
		"stored deepseek-v4-flash WITHOUT thinkingLevelMap returns generated capabilities",
		async () => {
			const provider = await createNanCompatibleProvider(NAN_PROVIDER);

			const staleModel = staleModelEntry("deepseek-v4-flash", {
				name: "DeepSeek V4.1 Flash",
				contextWindow: 128_000, // stale
				maxTokens: 4_096, // stale
				// no thinkingLevelMap
			});

			const store = storedEntry([staleModel]);
			await provider.refreshModels!(
				refreshContext({
					allowNetwork: false,
					stored: store as any,
				}),
			);

			const models = provider.getModels() as Model<"openai-completions">[];
			const ds = models.find((m) => m.id === "deepseek-v4-flash");
			expect(ds).toBeDefined();
			// Generated capabilities must be overlaid despite stale store
			expect(ds!.contextWindow).toBe(1_000_000);
			expect(ds!.maxTokens).toBe(384_000);
			expect(ds!.thinkingLevelMap?.off).toBe("none");
			expect(ds!.input).toEqual(["text", "image"]);
			expect(ds!.compat?.supportsReasoningEffort).toBe(true);
			expect(ds!.compat?.supportsUsageInStreaming).toBe(true);
		},
	);

	test(
		"stored glm5.3-flash WITHOUT thinkingLevelMap returns generated capabilities",
		async () => {
			const provider = await createNanCompatibleProvider(NAN_PROVIDER);

			const staleModel = staleModelEntry("glm5.3-flash", {
				name: "GLM-5.3-Flash",
				contextWindow: 64_000,
				maxTokens: 8_192,
			});

			await provider.refreshModels!(
				refreshContext({
					stored: storedEntry([staleModel]) as any,
				}),
			);

			const models = provider.getModels() as Model<"openai-completions">[];
			const glm = models.find((m) => m.id === "glm5.3-flash");
			expect(glm).toBeDefined();
			expect(glm!.contextWindow).toBe(1_000_000);
			expect(glm!.maxTokens).toBe(131_072);
			expect(glm!.thinkingLevelMap?.off).toBe("minimal");
		},
	);

	test(
		"stored qwen3.6 and gemma4 also get thinkingLevelMap overlaid",
		async () => {
			const provider = await createNanCompatibleProvider(NAN_PROVIDER);

			const staleQwen = staleModelEntry("qwen3.6", { name: "Qwen3.6 35B-A3B" });
			const staleGemma = staleModelEntry("gemma4", { name: "Gemma 4 26B A4B IT" });

			await provider.refreshModels!(
				refreshContext({
					stored: storedEntry([staleQwen, staleGemma]) as any,
				}),
			);

			const models = provider.getModels() as Model<"openai-completions">[];
			const qwen = models.find((m) => m.id === "qwen3.6");
			const gemma = models.find((m) => m.id === "gemma4");
			expect(qwen).toBeDefined();
			expect(gemma).toBeDefined();
			expect(qwen!.thinkingLevelMap?.off).toBe("none");
			expect(qwen!.contextWindow).toBe(262_144);
			expect(qwen!.maxTokens).toBe(65_536);
			expect(gemma!.thinkingLevelMap?.off).toBe("none");
			expect(gemma!.contextWindow).toBe(262_144);
			expect(gemma!.maxTokens).toBe(32_768);
		},
	);
});

// ── Test: stored id absent from generated catalog passes through ────────────

describe("issue #19 — live-only / uncatalogued stored ids pass through", () => {
	test(
		"a stored id not in the generated catalog (e.g. premium glm5.3) passes through as-is",
		async () => {
			const provider = await createNanCompatibleProvider(NAN_PROVIDER);

			const liveOnlyModel: Model<"openai-completions"> = {
				id: "glm5.3", // premium tier — not in generated catalog
				name: "GLM 5.3",
				api: "openai-completions",
				provider: "nan",
				baseUrl: "https://api.nan.builders/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 131_072,
				compat: {
					supportsDeveloperRole: false,
					supportsReasoningEffort: true,
					supportsUsageInStreaming: true,
					supportsFinishReason: true,
					maxTokensField: "max_tokens",
				},
			};

			await provider.refreshModels!(
				refreshContext({
					stored: storedEntry([liveOnlyModel]) as any,
				}),
			);

			const models = provider.getModels() as Model<"openai-completions">[];
			const glm53 = models.find((m) => m.id === "glm5.3");
			expect(glm53).toBeDefined();
			// Pass through as-is — capabilities preserved from store
			expect(glm53!.contextWindow).toBe(1_000_000);
			expect(glm53!.thinkingLevelMap).toBeUndefined();
			expect(glm53!.compat?.supportsReasoningEffort).toBe(true);
		},
	);

	test("a stored id from an older version that has NO generated counterpart at all is preserved", async () => {
		const provider = await createNanCompatibleProvider(NAN_PROVIDER);

		const ghostModel: Model<"openai-completions"> = {
			id: "some-deprecated-model",
			name: "Old Model",
			api: "openai-completions",
			provider: "nan",
			baseUrl: "https://api.nan.builders/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 2_048,
		};

		await provider.refreshModels!(
			refreshContext({
				stored: storedEntry([ghostModel]) as any,
			}),
		);

		const models = provider.getModels() as Model<"openai-completions">[];
		const ghost = models.find((m) => m.id === "some-deprecated-model");
		expect(ghost).toBeDefined();
		expect(ghost!.contextWindow).toBe(32_000); // preserved as-is
	});
});

// ── Test: image model overlay ───────────────────────────────────────────────

describe("issue #19 — stale catalog overlay (image models)", () => {
	test(
		"flux-2-klein image model returns correct input/output from generated catalog",
		async () => {
			const provider = await createNanCompatibleProvider(NAN_PROVIDER);

			await provider.refreshModels!(
				refreshContext({
					stored: storedEntry([]) as any,
				}),
			);

			// Image models come from the provider's own static image-models
			// registration. Check that getAllModels() returns correct image data.
			const allModels = provider.getAllModels?.();
			if (allModels) {
				const images = allModels.filter(
					(m) => m.type === "image",
				) as ImageModel<"nan-images">[];
				const flux = images.find((m) => m.id === "flux-2-klein");
				expect(flux).toBeDefined();
				// Generated image model data has correct input/output
				expect(flux!.input).toContain("text");
				expect(flux!.input).toContain("image");
				expect(flux!.output).toEqual(["image"]);
			}
		},
	);

	test(
		"qwen-image-2.1 returns generated image-model capability data",
		async () => {
			const provider = await createNanCompatibleProvider(NAN_PROVIDER);

			await provider.refreshModels!(
				refreshContext({
					stored: storedEntry([]) as any,
				}),
			);

			const allModels = provider.getAllModels?.();
			if (allModels) {
				const images = allModels.filter(
					(m) => m.type === "image",
				) as ImageModel<"nan-images">[];
				const qwenImg = images.find((m) => m.id === "qwen-image-2.1");
				expect(qwenImg).toBeDefined();
				expect(qwenImg!.input).toEqual(["text"]);
				expect(qwenImg!.output).toEqual(["image"]);
			}
		},
	);
});

// ── Test: network refresh preserves correctness ────────────────────────────

describe("issue #19 — network refresh still correct after overlay", () => {
	test(
		"after a live /models refresh, getModels still returns correct capability data",
		async () => {
			const provider = await createNanCompatibleProvider(NAN_PROVIDER, {
				fetchImpl: jsonModelsBody([
					"qwen3.6",
					"deepseek-v4-flash",
					"mimo-v2.6-flash",
				]) as unknown as typeof fetch,
			});

			const staleModel = staleModelEntry("deepseek-v4-flash", {
				name: "DeepSeek V4.1 Flash",
				contextWindow: 128_000,
				maxTokens: 4_096,
			});

			await provider.refreshModels!(
				refreshContext({
					allowNetwork: true,
					stored: storedEntry([staleModel]) as any,
					credential: { type: "api_key", key: "sk-test" },
					publish: async (pub) => {
						pub.update?.();
						return true;
					},
				}),
			);

			const models = provider.getModels() as Model<"openai-completions">[];
			const ds = models.find((m) => m.id === "deepseek-v4-flash");
			expect(ds).toBeDefined();
			expect(ds!.contextWindow).toBe(1_000_000);
			expect(ds!.thinkingLevelMap?.off).toBe("none");
			// mimo-v2.6-flash should also be present (live list includes it)
			const mimo = models.find((m) => m.id === "mimo-v2.6-flash");
			expect(mimo).toBeDefined();
		},
	);

	test(
		"publish payload from network refresh is passed through unchanged",
		async () => {
			const provider = await createNanCompatibleProvider(NAN_PROVIDER, {
				fetchImpl: jsonModelsBody([
					"qwen3.6",
					"deepseek-v4-flash",
				]) as unknown as typeof fetch,
			});

			let publishCalled = false;
			await provider.refreshModels!(
				refreshContext({
					allowNetwork: true,
					credential: { type: "api_key", key: "sk-test" },
					publish: async (publication) => {
						publishCalled = true;
						publication.update?.();
						return true;
					},
				}),
			);

			// Overlay must not corrupt what pi persists — publish must succeed.
			expect(publishCalled).toBe(true);
			// The models visible via getModels() must have generated capabilities,
			// confirming the overlay did not interfere with the refresh pipeline.
			const models = provider.getModels() as Model<"openai-completions">[];
			const ds = models.find((m) => m.id === "deepseek-v4-flash");
			expect(ds).toBeDefined();
			expect(ds!.contextWindow).toBe(1_000_000);
			expect(ds!.thinkingLevelMap?.off).toBe("none");
		},
	);
});

// ── Test: idempotency / no regression ───────────────────────────────────────

describe("issue #19 — overlay is idempotent, no behavioral regression", () => {
	test(
		"baseline-only provider returns identical data before and after a no-op refresh",
		async () => {
			const provider = await createNanCompatibleProvider(NAN_PROVIDER);

			const before = provider.getModels().map((m) => ({
				id: m.id,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				thinkingLevelMap: m.thinkingLevelMap
					? { ...m.thinkingLevelMap }
					: undefined,
			}));

			// Refresh without stored data — no-op
			await provider.refreshModels!(
				refreshContext({
					allowNetwork: false,
				}),
			);

			const after = provider.getModels().map((m) => ({
				id: m.id,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				thinkingLevelMap: m.thinkingLevelMap
					? { ...m.thinkingLevelMap }
					: undefined,
			}));

			expect(after).toEqual(before);
		},
	);

	test(
		"calling getModels multiple times returns the same overlaid data",
		async () => {
			const provider = await createNanCompatibleProvider(NAN_PROVIDER);

			const staleModel = staleModelEntry("deepseek-v4-flash", {
				name: "DeepSeek V4.1 Flash",
				contextWindow: 128_000,
				maxTokens: 4_096,
			});

			await provider.refreshModels!(
				refreshContext({
					stored: storedEntry([staleModel]) as any,
				}),
			);

			const first = provider.getModels();
			const second = provider.getModels();
			const third = provider.getModels();

			// All calls must return consistent data (overlay is stable)
			const ds0 = first.find((m) => m.id === "deepseek-v4-flash");
			const ds1 = second.find((m) => m.id === "deepseek-v4-flash");
			const ds2 = third.find((m) => m.id === "deepseek-v4-flash");

			expect(ds0!.contextWindow).toBe(ds1!.contextWindow);
			expect(ds1!.contextWindow).toBe(ds2!.contextWindow);
			expect(ds0!.contextWindow).toBe(1_000_000);
			expect(ds0!.thinkingLevelMap?.off).toBe("none");
		},
	);

	test("all generated chat models retain their thinkingLevelMap after stale overlay", async () => {
		const provider = await createNanCompatibleProvider(NAN_PROVIDER);

		// Build a stale snapshot of every generated model WITHOUT thinkingLevelMap
		const staleModels = NAN_GENERATED_MODELS
			.filter((e) => e.reasoning)
			.map((entry) =>
				staleModelEntry(entry.id, { name: entry.name }),
			);

		await provider.refreshModels!(
			refreshContext({
				stored: storedEntry(staleModels) as any,
			}),
		);

		const models = provider.getModels() as Model<"openai-completions">[];

		for (const entry of NAN_GENERATED_MODELS) {
			if (!entry.reasoning) continue;
			const model = models.find((m) => m.id === entry.id);
			expect(model).toBeDefined();
			if (entry.thinkingLevelMap) {
				expect(model!.thinkingLevelMap).toBeDefined();
				expect(model!.thinkingLevelMap?.off).toBe(entry.thinkingLevelMap.off);
			}
			// Context window and maxTokens must also be correct
			expect(model!.contextWindow).toBe(entry.contextWindow);
			expect(model!.maxTokens).toBe(entry.maxTokens);
		}
	});
});

// ── Test: image model overlay (GAP 1: getAllModels wrapping) ────────────────

describe("issue #19 — stale catalog overlay (image models, GAP 1)", () => {
	test(
		"a stale stored IMAGE model entry is overlaid via getAllModels()",
		async () => {
			const provider = await createNanCompatibleProvider(NAN_PROVIDER);

			// Write a stale flux-2-klein with wrong input/output into the store
			const staleFlux = staleImageModelEntry("flux-2-klein");
			await provider.refreshModels!(
				refreshContext({
					stored: storedEntry([staleFlux]) as any,
				}),
			);

			// getAllModels must return the baseline image capability data,
			// NOT the stale store entry
			const allModels = provider.getAllModels?.();
			expect(allModels).toBeDefined();
			const fluxImg = allModels!.find((m) => m.id === "flux-2-klein") as ImageModel<"nan-images">;
			expect(fluxImg).toBeDefined();
			expect(fluxImg.type).toBe("image");
			// Baseline: flux-2-klein accepts text+image input, outputs image
			expect(fluxImg.input).toContain("text");
			expect(fluxImg.input).toContain("image");
			expect(fluxImg.output).toEqual(["image"]);
		},
	);

	test(
		"a ghost image id (not in the image baseline) passes through as-is via getAllModels()",
		async () => {
			const provider = await createNanCompatibleProvider(NAN_PROVIDER);

			const ghostImage: ImageModel<"nan-images"> = {
				id: "phantom-image-model",
				name: "Phantom",
				type: "image",
				api: "nan-images",
				provider: "nan",
				baseUrl: "https://api.nan.builders/v1",
				input: ["text"],
				output: ["image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};

			await provider.refreshModels!(
				refreshContext({
					stored: storedEntry([ghostImage]) as any,
				}),
			);

			const allModels = provider.getAllModels?.();
			const phantom = allModels!.find((m) => m.id === "phantom-image-model");
			expect(phantom).toBeDefined();
			expect((phantom as ImageModel<"nan-images">).name).toBe("Phantom");
			// Ghost id: not in baseline, passes through as-is
			expect(phantom!.input).toEqual(["text"]);
		},
	);

	test("getAllModels() and getModels() agree for chat ids after overlay", async () => {
		const provider = await createNanCompatibleProvider(NAN_PROVIDER);

		// Stale deepseek-v4-flash stored
		const staleModel = staleModelEntry("deepseek-v4-flash", {
			contextWindow: 128_000,
			maxTokens: 4_096,
		});

		await provider.refreshModels!(
			refreshContext({
				stored: storedEntry([staleModel]) as any,
			}),
		);

		const chatModels = provider.getModels() as Model<"openai-completions">[];
		const all = provider.getAllModels?.();

		const chatDs = chatModels.find((m) => m.id === "deepseek-v4-flash");
		const allDsRaw = all?.find((m) => m.id === "deepseek-v4-flash");
		const allDs = allDsRaw as Model<"openai-completions"> | undefined;

		expect(chatDs).toBeDefined();
		expect(allDs).toBeDefined();
		// Both must return the overlaid generated data
		expect(chatDs!.contextWindow).toBe(allDs!.contextWindow);
		expect(chatDs!.maxTokens).toBe(allDs!.maxTokens);
		expect(chatDs!.thinkingLevelMap?.off).toBe(allDs!.thinkingLevelMap?.off);
		expect(allDs).not.toHaveProperty("type"); // chat, not image
	});
});

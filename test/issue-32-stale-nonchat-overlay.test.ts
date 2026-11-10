/**
 * ACCEPTANCE TESTS — issue #32
 * "Non-chat ids (kokoro, whisper, rerank, qwen3-embedding, flux-2-klein,
 *  qwen-image-2.1, minimax-h3) still show up as chat models in pi when
 *  models-store.json was written by an older package version that predates
 *  #15. A model-catalog refresh does not clear them."
 *
 * https://github.com/gtrabanco/pi-nan-provider/issues/32
 *
 * The fix (issue's proposed fix, verbatim scope): drop NON_CHAT_MODEL_IDS in
 * the read-time overlay (`withStaleCatalogOverlay`), the same place #19
 * corrects stale capabilities. Chat-type entries whose id is a non-chat id are
 * dropped from both read paths; `type: "image"` entries (flux-2-klein,
 * qwen-image-2.1 as baseline image models) are never dropped.
 *
 * No network: fetch is injected everywhere.
 */

import { describe, expect, test } from "bun:test";
import type { ImageModel, Model } from "@earendil-works/pi-ai";
import { createNanCompatibleProvider } from "../src/provider-factory.ts";
import { NON_CHAT_MODEL_IDS } from "../src/fetch-models.ts";
import { NAN_PROVIDER } from "../src/providers.ts";

// ── Test helpers (mirroring the issue #19 harness) ──────────────────────────

/** A stored chat entry with the shape an old package version persisted. */
function staleChatEntry(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "nan",
		baseUrl: "https://api.nan.builders/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 2_048,
	};
}

/** Minimal ModelsStoreEntry as pi would read from disk. */
function storedEntry(models: unknown[]): unknown {
	return {
		models,
		lastModified: Date.now(),
		checkedAt: Date.now() - 60_000, // 1 min ago — pi won't refresh
	};
}

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

// ── Regression: stored non-chat chat entries are dropped ────────────────────

describe("issue #32 — stale store non-chat ids are not registered as chat models", () => {
	test(
		"a stored kokoro chat entry is absent from getModels()",
		async () => {
			const provider = await createNanCompatibleProvider(NAN_PROVIDER);

			await provider.refreshModels!(
				refreshContext({
					stored: storedEntry([staleChatEntry("kokoro")]) as any,
				}),
			);

			const models = provider.getModels() as Model<"openai-completions">[];
			expect(models.find((m) => m.id === "kokoro")).toBeUndefined();
			// Sanity: the healthy chat entry stored alongside it survives.
			expect(models.find((m) => m.id === "qwen3.6")).toBeDefined();
		},
	);

	test(
		"none of the seven NON_CHAT_MODEL_IDS survive a stale-store restore as chat models",
		async () => {
			const nonChatIds = Object.keys(NON_CHAT_MODEL_IDS);
			expect(nonChatIds.length).toBe(7);

			const provider = await createNanCompatibleProvider(NAN_PROVIDER);

			await provider.refreshModels!(
				refreshContext({
					// The pre-#15 store shape: every id persisted as a chat entry.
					stored: storedEntry(nonChatIds.map((id) => staleChatEntry(id))) as any,
				}),
			);

			const models = provider.getModels() as Model<"openai-completions">[];
			for (const id of nonChatIds) {
				expect(models.find((m) => m.id === id)).toBeUndefined();
			}
		},
	);

	test(
		"image models with non-chat ids are never dropped (flux-2-klein stays an image model)",
		async () => {
			const provider = await createNanCompatibleProvider(NAN_PROVIDER);

			await provider.refreshModels!(
				refreshContext({
					stored: storedEntry([]) as any,
				}),
			);

			const allModels = provider.getAllModels?.() ?? [];
			const images = allModels.filter((m) => m.type === "image") as ImageModel<"nan-images">[];
			const flux = images.find((m) => m.id === "flux-2-klein");
			const qwenImage = images.find((m) => m.id === "qwen-image-2.1");
			expect(flux).toBeDefined();
			expect(qwenImage).toBeDefined();
			// ...and they are still not chat models.
			const chat = provider.getModels() as Model<"openai-completions">[];
			expect(chat.find((m) => m.id === "flux-2-klein")).toBeUndefined();
			expect(chat.find((m) => m.id === "qwen-image-2.1")).toBeUndefined();
		},
	);
});

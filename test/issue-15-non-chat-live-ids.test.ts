import { describe, expect, test } from "bun:test";
import {
	NON_CHAT_MODEL_IDS,
	baselineModels,
	mergeLiveWithGenerated,
	resolveCatalog,
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

// ---------------------------------------------------------------------------
// Issue #15 — non-chat model IDs (kokoro/TTS, whisper/STT, rerank,
// qwen3-embedding, flux-2-klein/image, qwen-image-2.1/image) must never
// surface as chat models in the resolved catalog.
// ---------------------------------------------------------------------------

describe("NON_CHAT_MODEL_IDS export", () => {
	test("NON_CHAT_MODEL_IDS is exported as a Readonly<Record<string, string>>", () => {
		// Must be a plain object; undefined or array is wrong.
		expect(typeof NON_CHAT_MODEL_IDS).toBe("object");
		expect(NON_CHAT_MODEL_IDS).not.toBeNull();
		// Every value is a provenance reason string.
		for (const [id, reason] of Object.entries(NON_CHAT_MODEL_IDS) as Array<[string, string]>) {
			expect(typeof id).toBe("string");
			expect(id.length).toBeGreaterThan(0);
			expect(typeof reason).toBe("string");
			expect(reason.length).toBeGreaterThan(0);
			// Provenance discipline: every reason cites a source URL.
			expect(reason).toContain("https://");
		}
	});

	test("NON_CHAT_MODEL_IDS contains exactly the six non-chat ids", () => {
		const expected = new Set([
			"qwen3-embedding",
			"rerank",
			"kokoro",
			"whisper",
			"flux-2-klein",
			"qwen-image-2.1",
		]);
		const actual = new Set(Object.keys(NON_CHAT_MODEL_IDS));
		expect(actual).toEqual(expected);
		expect(Object.keys(NON_CHAT_MODEL_IDS).length).toBe(6);
	});
});

describe("mergeLiveWithGenerated — non-chat ids", () => {
	// Data-driven: every non-chat id must land in nonChat, never in models or unknown.
	const nonChatIds = Object.keys(NON_CHAT_MODEL_IDS);

	test.each(nonChatIds)("mergeLiveWithGenerated([%s]) → models: [], unknown: [], nonChat: [%s]", (id) => {
		const merged = mergeLiveWithGenerated([id], SOURCE);
		expect(merged.models).toEqual([]);
		expect(merged.unknown).toEqual([]);
		expect(merged.nonChat).toEqual([id]);
	});

	test("mixed live list: chat ids in models/unknown, non-chat in nonChat only", () => {
		const liveIds = [
			"qwen3.6",
			"kokoro",
			"whisper",
			"rerank",
			"qwen3-embedding",
			"flux-2-klein",
			"qwen-image-2.1",
			"minimax-h3",
		];
		const merged = mergeLiveWithGenerated(liveIds, SOURCE);

		// Chat ids that have generated data go to matched/models.
		expect(merged.matched).toEqual(["qwen3.6"]);
		// Non-catalogued chat ids go to unknown.
		expect(merged.unknown).toEqual(["minimax-h3"]);
		// nonChat gets the six non-chat ids in live order.
		expect(merged.nonChat).toEqual([
			"kokoro",
			"whisper",
			"rerank",
			"qwen3-embedding",
			"flux-2-klein",
			"qwen-image-2.1",
		]);
		// models: only the chat models.
		const modelIds = merged.models.map((m) => m.id);
		expect(modelIds).toEqual(["qwen3.6", "minimax-h3"]);
	});

	test("uncatalogued chat id still gets the placeholder with correct defaults", () => {
		const merged = mergeLiveWithGenerated(["minimax-h3"], SOURCE);
		expect(merged.unknown).toEqual(["minimax-h3"]);
		expect(merged.nonChat).toEqual([]);
		const model = merged.models[0]!;
		expect(model.contextWindow).toBe(UNKNOWN_MODEL_LIMITS.contextWindow); // 128_000
		expect(model.maxTokens).toBe(UNKNOWN_MODEL_LIMITS.maxTokens); // 4_096
		expect(model.reasoning).toBe(false);
		expect(model.compat?.supportsFinishReason).toBe(true);
	});
});

describe("resolveCatalog — non-chat ids", () => {
	test("non-chat ids excluded from models; nonChatIds set populated", async () => {
		const liveResponse = {
			data: [
				{ id: "qwen3.6" },
				{ id: "kokoro" },
				{ id: "whisper" },
				{ id: "rerank" },
				{ id: "qwen3-embedding" },
				{ id: "flux-2-klein" },
				{ id: "qwen-image-2.1" },
				{ id: "minimax-h3" },
			],
		};
		const catalog = await resolveCatalog(SOURCE, { fetchImpl: jsonFetch(liveResponse) });

		// models must NOT contain non-chat ids.
		const modelIds = catalog.models.map((m) => m.id);
		for (const nonChatId of Object.keys(NON_CHAT_MODEL_IDS)) {
			expect(modelIds).not.toContain(nonChatId);
		}
		// models contains the chat ids.
		expect(modelIds).toContain("qwen3.6");
		expect(modelIds).toContain("minimax-h3");

		// nonChatIds must be the six non-chat ids.
		expect(catalog.nonChatIds).toEqual([
			"kokoro",
			"whisper",
			"rerank",
			"qwen3-embedding",
			"flux-2-klein",
			"qwen-image-2.1",
		]);

		// liveIds is the FULL live set, including non-chat ids (authoritative list).
		expect(catalog.liveIds).not.toBeUndefined();
		const liveSet = catalog.liveIds!;
		for (const id of Object.keys(NON_CHAT_MODEL_IDS)) {
			expect(liveSet).toContain(id);
		}
	});

	test("fallback path (401) → nonChatIds is []", async () => {
		const catalog = await resolveCatalog(SOURCE, {
			fetchImpl: jsonFetch({ error: { message: "auth" } }, 401),
		});
		expect(catalog.nonChatIds).toEqual([]);
		// liveIds undefined on fallback.
		expect(catalog.liveIds).toBeUndefined();
	});
});

describe("baselineModels — defense in depth", () => {
	test("baselineModels must not contain any non-chat id", () => {
		const baselineIds = new Set(baselineModels(SOURCE).map((m) => m.id));
		for (const nonChatId of Object.keys(NON_CHAT_MODEL_IDS)) {
			expect(baselineIds.has(nonChatId), `baseline should not contain ${nonChatId}`).toBe(false);
		}
	});
});
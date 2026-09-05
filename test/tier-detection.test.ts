import { describe, expect, test } from "bun:test";
import { NAN_GENERATED_MODELS } from "../scripts/models.generated.ts";
import { createNanCompatibleProvider } from "../src/provider-factory.ts";
import { NAN_PROVIDER } from "../src/providers.ts";
import { baselineModels, type CatalogSource } from "../src/fetch-models.ts";

const SOURCE: CatalogSource = { providerId: "nan", baseUrl: "https://api.nan.builders/v1" };

function jsonFetch(body: unknown, status = 200): typeof fetch {
	return (async () =>
		new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
}

function refreshContext(overrides: Record<string, unknown> = {}) {
	return {
		allowNetwork: true,
		signal: new AbortController().signal,
		publish: async (publication: { update?: () => void }) => {
			publication.update?.();
			return true;
		},
		...overrides,
	};
}

describe("tier detection (filterModels driven by live /models)", () => {
	test("after a successful live refresh, only key-visible models are available", async () => {
		// NaN lists exactly the models your membership can call: simulate a key
		// that sees qwen3.6 and a brand-new model, but not glm5.2/gemma4/etc.
		const provider = await createNanCompatibleProvider(NAN_PROVIDER, {
			fetchImpl: jsonFetch({ data: [{ id: "qwen3.6" }, { id: "brand-new-model" }] }),
		});
		await provider.refreshModels!(
			refreshContext({ credential: { type: "api_key", key: "sk-live" } }),
		);
		const available = provider.filterModels!(provider.getModels(), { type: "api_key", key: "sk-live" });
		expect(available.map((model) => model.id).sort()).toEqual(["brand-new-model", "qwen3.6"]);
	});

	test("without a successful live refresh, the full generated catalog stays available", async () => {
		const provider = await createNanCompatibleProvider(NAN_PROVIDER, { fetchImpl: jsonFetch({}, 500) });
		await provider.refreshModels!(
			refreshContext({ credential: { type: "api_key", key: "sk-live" } }),
		);
		const available = provider.filterModels!(provider.getModels(), { type: "api_key", key: "sk-live" });
		expect(available.length).toBe(NAN_GENERATED_MODELS.length);
	});

	test("a fresh provider with no live data filters nothing", async () => {
		const provider = await createNanCompatibleProvider(NAN_PROVIDER);
		const available = provider.filterModels!(baselineModels(SOURCE), undefined);
		expect(available.length).toBe(NAN_GENERATED_MODELS.length);
	});
});
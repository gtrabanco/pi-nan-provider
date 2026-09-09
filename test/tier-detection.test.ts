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
		// NaN lists exactly the models your membership can call: a premium key
		// that sees qwen3.6 and the premium-tier glm5.3, but not the
		// baseline-only gemma4/glm5.3-flash etc. Undocumented live ids never
		// surface (allowlist, not open ingest).
		const provider = await createNanCompatibleProvider(NAN_PROVIDER, {
			fetchImpl: jsonFetch({ data: [{ id: "qwen3.6" }, { id: "glm5.3" }] }),
		});
		await provider.refreshModels!(
			refreshContext({ credential: { type: "api_key", key: "sk-live" } }),
		);
		const available = provider.filterModels!(provider.getModels(), { type: "api_key", key: "sk-live" });
		expect(available.map((model) => model.id).sort()).toEqual(["glm5.3", "qwen3.6"]);
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
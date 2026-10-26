import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	configureProviderAttribution,
	PROVIDER_ATTRIBUTION_HEADER,
	providerAttributionEnabled,
	providerAttributionHeaderValue,
	stripProviderAttribution,
	withProviderAttribution,
} from "../src/attribution.ts";
import { baselineModels, mergeLiveWithGenerated, buildOverlayMap } from "../src/fetch-models.ts";
import { baselineImageModels } from "../src/images.ts";
import { createNanCompatibleProvider } from "../src/provider-factory.ts";
import { NAN_PROVIDER } from "../src/providers.ts";

const SOURCE = { providerId: "nan", baseUrl: "https://api.nan.builders/v1" };

const packageVersion = (): string => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
		version?: string;
	};
	if (typeof pkg.version !== "string") throw new Error("package.json has no version");
	return pkg.version;
};

describe("provider attribution header", () => {
	test("header value is the package name and version from package.json", () => {
		const value = providerAttributionHeaderValue();
		expect(value).toBe(`gtrabanco/pi-nan-provider@${packageVersion()}`);
	});

	test("withProviderAttribution attaches the header without touching other fields", () => {
		const model: { id: string; api: string; headers?: Record<string, string> } = {
			id: "m",
			api: "openai-completions",
			headers: { "X-Existing": "1" },
		};
		const attributed = withProviderAttribution(model);
		expect(attributed.headers).toEqual({
			"X-Existing": "1",
			[PROVIDER_ATTRIBUTION_HEADER]: providerAttributionHeaderValue() ?? "",
		});
		expect(attributed.id).toBe("m");
	});

	test("withProviderAttribution adds a headers object when the model has none", () => {
		const attributed = withProviderAttribution({
			id: "m",
			api: "openai-completions",
		} as { id: string; api: string; headers?: Record<string, string> });
		expect(attributed.headers?.[PROVIDER_ATTRIBUTION_HEADER]).toBe(
			providerAttributionHeaderValue(),
		);
	});

	test("every baseline chat model carries the header", () => {
		for (const model of baselineModels(SOURCE)) {
			expect(model.headers?.[PROVIDER_ATTRIBUTION_HEADER]).toBe(
				providerAttributionHeaderValue(),
			);
		}
	});

	test("every merged live model carries the header (matched, live-only and unknown)", async () => {
		const generated = baselineModels(SOURCE).map((m) => m.id);
		const firstCatalogId = generated[0];
		if (!firstCatalogId) throw new Error("generated catalog is empty");
		const liveIds = [firstCatalogId, "glm5.3", "brand-new-model"];
		const merged = mergeLiveWithGenerated(liveIds, SOURCE);
		expect(merged.matched).toContain(firstCatalogId);
		expect(merged.unknown).toContain("brand-new-model");
		for (const model of merged.models) {
			expect(model.headers?.[PROVIDER_ATTRIBUTION_HEADER]).toBe(
				providerAttributionHeaderValue(),
			);
		}
	});

	test("every overlay entry carries the header (stale-catalog correction path)", () => {
		const overlay = buildOverlayMap(SOURCE, undefined, baselineImageModels(SOURCE));
		expect(overlay.size).toBeGreaterThan(0);
		for (const entry of overlay.values()) {
			const headers = entry.chat?.headers ?? entry.image?.headers;
			expect(headers?.[PROVIDER_ATTRIBUTION_HEADER]).toBe(providerAttributionHeaderValue());
		}
	});

	test("baseline image models carry the header and the image request path merges it", () => {
		for (const model of baselineImageModels(SOURCE)) {
			expect(model.headers?.[PROVIDER_ATTRIBUTION_HEADER]).toBe(
				providerAttributionHeaderValue(),
			);
		}
	});

	test("the registered provider surfaces models with the header", async () => {
		const provider = await createNanCompatibleProvider({
			id: NAN_PROVIDER.id,
			name: NAN_PROVIDER.name,
			baseUrl: NAN_PROVIDER.baseUrl,
			envVars: NAN_PROVIDER.envVars,
		});
		const all = provider.getAllModels?.() ?? [];
		for (const model of all) {
			const headers = (model as { headers?: Record<string, string> }).headers;
			expect(headers?.[PROVIDER_ATTRIBUTION_HEADER]).toBe(providerAttributionHeaderValue());
		}
	});
});

describe("provider attribution telemetry gate", () => {
	test("attribution is enabled by default (no gate configured)", () => {
		expect(providerAttributionEnabled()).toBe(true);
	});

	test("disabling the gate omits the header without touching the version", () => {
		try {
			configureProviderAttribution(() => false);
			expect(providerAttributionEnabled()).toBe(false);
			const attributed = withProviderAttribution({
				id: "m",
				api: "openai-completions",
			} as { id: string; api: string; headers?: Record<string, string> });
			expect(attributed.headers?.[PROVIDER_ATTRIBUTION_HEADER]).toBeUndefined();
			// The version itself is still resolvable — only the header is gated.
			expect(providerAttributionHeaderValue()).toBe(
				`gtrabanco/pi-nan-provider@${packageVersion()}`,
			);
		} finally {
			configureProviderAttribution(() => true);
		}
	});

	test("stripProviderAttribution removes a baked-in header and keeps the rest", () => {
		const stripped = stripProviderAttribution({
			id: "m",
			headers: {
				"X-Keep": "1",
				[PROVIDER_ATTRIBUTION_HEADER]: "gtrabanco/pi-nan-provider@1.0.0",
			} as Record<string, string>,
		});
		expect(stripped.headers).toEqual({ "X-Keep": "1" });
	});

	test("stripProviderAttribution is a no-op without a headers object", () => {
		const model = { id: "m", headers: undefined } as { id: string; headers?: Record<string, string> };
		expect(stripProviderAttribution(model)).toBe(model);
	});

	test("a provider built with the header stops surfacing it once the gate is disabled", async () => {
		configureProviderAttribution(() => true);
		const provider = await createNanCompatibleProvider({
			id: NAN_PROVIDER.id,
			name: NAN_PROVIDER.name,
			baseUrl: NAN_PROVIDER.baseUrl,
			envVars: NAN_PROVIDER.envVars,
		});
		expect(
			(provider.getAllModels?.() ?? [])[0]?.headers?.[PROVIDER_ATTRIBUTION_HEADER],
		).toBe(providerAttributionHeaderValue());

		try {
			configureProviderAttribution(() => false);
			for (const model of provider.getAllModels?.() ?? []) {
				expect(model.headers?.[PROVIDER_ATTRIBUTION_HEADER]).toBeUndefined();
			}
		} finally {
			configureProviderAttribution(() => true);
		}
	});
});

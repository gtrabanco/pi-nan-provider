/**
 * Integration test: the NaN provider exposes its image models through the
 * pi-ai provider surface, so pi's model registry can route
 * `generateImages()` (codemode and `ctx.modelRegistry.generateImages`).
 *
 * The unit-level behavior of createNanImagesApi is covered by
 * test/nan-images.test.ts; this file pins the provider wiring:
 *   - getAllModels() includes the image models (type "image", api "nan-images")
 *   - getModels() (chat) does NOT include them (the /model picker is unaffected)
 *   - provider.generateImages is wired and dispatches to the image API
 */

import { describe, expect, test } from "bun:test";
import type { ImageModel } from "@earendil-works/pi-ai";
import { createNanCompatibleProvider } from "../src/provider-factory.ts";
import { NAN_PROVIDER } from "../src/providers.ts";

const PNG_B64 = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]).toString("base64");

/** Injected fetch capturing the request and returning one PNG. */
function createGateway(): {
	fetchImpl: typeof fetch;
	lastUrl: () => string;
	lastInit: () => RequestInit | undefined;
} {
	let lastUrl = "";
	let lastInit: RequestInit | undefined;
	const fetchImpl = (async (url: unknown, init?: RequestInit) => {
		lastUrl = typeof url === "string" ? url : (url as Request).url;
		lastInit = init;
		return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return { fetchImpl, lastUrl: () => lastUrl, lastInit: () => lastInit };
}

describe("NaN provider image model wiring", () => {
	test("getAllModels() lists both NaN image models with the custom api", async () => {
		const provider = await createNanCompatibleProvider(NAN_PROVIDER, {
			fetchImpl: createGateway().fetchImpl,
		});
		const all = provider.getAllModels?.() ?? [];
		const images = all.filter((model) => model.type === "image");

		expect(images.map((model) => model.id).sort()).toEqual([
			"flux-2-klein",
			"qwen-image-2.1",
		]);
		for (const model of images) {
			expect(model.api).toBe("nan-images");
			expect(model.provider).toBe("nan");
			expect(model.baseUrl).toBe("https://api.nan.builders/v1");
			expect(model.output).toEqual(["image"]);
		}
	});

	test("getModels() stays chat-only so /model is unaffected", async () => {
		const provider = await createNanCompatibleProvider(NAN_PROVIDER, {
			fetchImpl: createGateway().fetchImpl,
		});
		const chatIds = provider.getModels().map((model) => model.id);
		expect(chatIds).not.toContain("flux-2-klein");
		expect(chatIds).not.toContain("qwen-image-2.1");
	});

	test("generateImages dispatches to the NaN image endpoint with auth", async () => {
		const gateway = createGateway();
		const provider = await createNanCompatibleProvider(NAN_PROVIDER, {
			fetchImpl: gateway.fetchImpl,
		});
		expect(typeof provider.generateImages).toBe("function");

		const model = (provider.getAllModels?.() ?? []).find(
			(entry) => entry.id === "flux-2-klein",
		) as ImageModel<"nan-images">;
		expect(model).toBeDefined();

		const result = await provider.generateImages!(
			model,
			{ input: [{ type: "text", text: "a lighthouse" }] },
			{ apiKey: "sk-test" },
		);

		expect(gateway.lastUrl()).toBe(
			"https://api.nan.builders/v1/images/generations",
		);
		expect(gateway.lastInit()!.method).toBe("POST");
		expect(
			(gateway.lastInit()!.headers as Record<string, string>).Authorization,
		).toBe("Bearer sk-test");
		const body = JSON.parse(gateway.lastInit()!.body as string) as Record<
			string,
			unknown
		>;
		expect(body.model).toBe("flux-2-klein");
		expect(body.response_format).toBe("b64_json");

		expect(result.stopReason).toBe("stop");
		expect(result.output[0]).toEqual({
			type: "image",
			data: PNG_B64,
			mimeType: "image/png",
		});
	});
});

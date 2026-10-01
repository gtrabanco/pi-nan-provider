import { describe, expect, test } from "bun:test";
import type {
	ImageContent,
	ImageModel,
	ImagesContext,
	ImagesOutputContent,
	ProviderImages,
	ProviderImagesOptions,
	StopReason,
	TextContent,
} from "@earendil-works/pi-ai";

import {
	NAN_IMAGE_API,
	NAN_IMAGE_MODELS,
	baselineImageModels,
	createNanImagesApi,
} from "../src/images.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** A minimal ImageModel fixture. */
function imageModelFixture(overrides: {
	id: string;
	name: string;
	input: ("text" | "image")[];
	output: ("text" | "image")[];
}): ImageModel<"nan-images"> {
	return {
		id: overrides.id,
		name: overrides.name,
		api: "nan-images",
		provider: "nan",
		baseUrl: "https://api.nan.builders/v1",
		type: "image",
		input: overrides.input,
		output: overrides.output,
	} as ImageModel<"nan-images">;
}

/**
 * Build a ImagesContext from plain text and optional image references.
 * Uses "as never" to bypass the compiler check that the model type is
 * registered in the pi-ai catalog (this provider's model is custom).
 */
function buildContext(texts: string[], images: ImageContent[] = []): ImagesContext {
	const input: (TextContent | ImageContent)[] = texts.map((t) => ({ type: "text", text: t }));
	input.push(...images);
	return { input } as ImagesContext;
}

/**
 * Injected fetch that records the last request and returns a JSON body.
 */
function createJsonGateway(
	body: Json,
	status = 200,
	headers: Record<string, string> = { "Content-Type": "application/json" },
): {
	fetchImpl: typeof fetch;
	lastUrl: () => string;
	lastInit: () => RequestInit | undefined;
} {
	let lastUrl = "";
	let lastInit: RequestInit | undefined;
	const fetchImpl = (async (url: unknown, init?: RequestInit) => {
		lastUrl = typeof url === "string" ? url : (url as Request).url;
		lastInit = init;
		return new Response(JSON.stringify(body), { status, headers });
	}) as unknown as typeof fetch;
	return { fetchImpl, lastUrl: () => lastUrl, lastInit: () => lastInit };
}

/**
 * Injected fetch that captures the raw request init for FormData inspection.
 */
function createFormDataGateway(body: Json): {
	fetchImpl: typeof fetch;
	lastUrl: () => string;
	lastInit: () => RequestInit | undefined;
} {
	let lastUrl = "";
	let lastInit: RequestInit | undefined;
	const fetchImpl = (async (url: unknown, init?: RequestInit) => {
		lastUrl = typeof url === "string" ? url : (url as Request).url;
		lastInit = init;
		return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	}) as unknown as typeof fetch;
	return { fetchImpl, lastUrl: () => lastUrl, lastInit: () => lastInit };
}

/** PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString("base64");

/** JPEG magic bytes: FF D8 FF E0 */
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const JPEG_B64 = Buffer.from(JPEG_BYTES).toString("base64");

/** WebP magic: "RIFF" + 4 filler bytes + "WEBP" + 4 filler bytes */
const WEBP_RAW = new Uint8Array([
	0x52, 0x49, 0x46, 0x46, // "RIFF"
	0x00, 0x00, 0x00, 0x00, // placeholder length
	0x57, 0x45, 0x42, 0x50, // "WEBP"
	0x00, 0x00, 0x00, 0x00, // filler
]);
const WEBP_B64 = Buffer.from(WEBP_RAW).toString("base64");

// ---------------------------------------------------------------------------
// 1.  CONSTANTS: NAN_IMAGE_MODELS + NAN_IMAGE_API
// ---------------------------------------------------------------------------

describe("NAN_IMAGE_API", () => {
	test('NAN_IMAGE_API === "nan-images"', () => {
		expect(NAN_IMAGE_API).toBe("nan-images");
	});
});

describe("NAN_IMAGE_MODELS", () => {
	test("has exactly two entries: flux-2-klein and qwen-image-2.1", () => {
		const ids = NAN_IMAGE_MODELS.map((m) => m.id).sort();
		expect(ids).toEqual(["flux-2-klein", "qwen-image-2.1"]);
	});

	test("flux-2-klein has input [text,image] and output [image]", () => {
		const model = NAN_IMAGE_MODELS.find((m) => m.id === "flux-2-klein");
		expect(model).toBeDefined();
		expect(model!.name).toBe("FLUX 2 Klein");
		expect(model!.input).toEqual(["text", "image"]);
		expect(model!.output).toEqual(["image"]);
	});

	test("qwen-image-2.1 has input [text] and output [image]", () => {
		const model = NAN_IMAGE_MODELS.find((m) => m.id === "qwen-image-2.1");
		expect(model).toBeDefined();
		// models.dev provider nan (checked 2026-10-01) spells the name with a hyphen.
		expect(model!.name).toBe("Qwen-Image-2.1");
		expect(model!.input).toEqual(["text"]);
		expect(model!.output).toEqual(["image"]);
	});
});

// ---------------------------------------------------------------------------
// 2.  baselineImageModels
// ---------------------------------------------------------------------------

describe("baselineImageModels", () => {
	test("maps provider, baseUrl, type and api correctly", () => {
		const source = { providerId: "my-nan" as const, baseUrl: "https://example.com/v1" as const };
		const models = baselineImageModels(source);

		expect(models.length).toBe(2);

		for (const model of models) {
			expect(model.provider).toBe("my-nan");
			expect(model.baseUrl).toBe("https://example.com/v1");
			expect(model.type).toBe("image");
			expect(model.api).toBe("nan-images");
		}

		const ids = models.map((m) => m.id);
		expect(ids).toContain("flux-2-klein");
		expect(ids).toContain("qwen-image-2.1");
	});

	test("returns independent arrays on each call", () => {
		const a = baselineImageModels({ providerId: "nan", baseUrl: "https://x.com/v1" });
		const b = baselineImageModels({ providerId: "nan", baseUrl: "https://x.com/v1" });
		expect(a).not.toBe(b);
	});
});

// ---------------------------------------------------------------------------
// 3.  text-to-image
// ---------------------------------------------------------------------------

describe("createNanImagesApi — text-to-image", () => {
	test("sends correct request and decodes PNG output", async () => {
		const gw = createJsonGateway({
			data: [{ b64_json: PNG_B64 }],
		});
		const api = createNanImagesApi({ fetchImpl: gw.fetchImpl });

		const model = imageModelFixture({
			id: "flux-2-klein",
			name: "FLUX 2 Klein",
			input: ["text", "image"],
			output: ["image"],
		});
		const context = buildContext(["a red fox"]);
		const result = await api.generateImages(model, context, { apiKey: "sk-test" });

		// Request shape
		expect(gw.lastUrl()).toBe("https://api.nan.builders/v1/images/generations");
		expect(gw.lastInit()!.method).toBe("POST");
		expect(gw.lastInit()!.headers).toEqual({
			"Content-Type": "application/json",
			Authorization: "Bearer sk-test",
		});

		const body = JSON.parse(gw.lastInit()!.body as string) as Json;
		expect(body).toEqual({
			model: "flux-2-klein",
			prompt: "a red fox",
			response_format: "b64_json",
		});

		// Result
		expect(result.stopReason).toBe("stop");
		expect(result.output.length).toBe(1);
		expect(result.output[0]).toEqual({
			type: "image",
			data: PNG_B64,
			mimeType: "image/png",
		});
	});

	test("correctly decodes JPEG output", async () => {
		const gw = createJsonGateway({ data: [{ b64_json: JPEG_B64 }] });
		const api = createNanImagesApi({ fetchImpl: gw.fetchImpl });

		const model = imageModelFixture({
			id: "flux-2-klein",
			name: "FLUX 2 Klein",
			input: ["text", "image"],
			output: ["image"],
		});
		const result = await api.generateImages(model, buildContext(["cat photo"]), { apiKey: "sk-key" });

		expect(result.output[0]).toEqual({
			type: "image",
			data: JPEG_B64,
			mimeType: "image/jpeg",
		});
	});

	test("correctly decodes WebP output", async () => {
		const gw = createJsonGateway({ data: [{ b64_json: WEBP_B64 }] });
		const api = createNanImagesApi({ fetchImpl: gw.fetchImpl });

		const model = imageModelFixture({
			id: "flux-2-klein",
			name: "FLUX 2 Klein",
			input: ["text", "image"],
			output: ["image"],
		});
		const result = await api.generateImages(model, buildContext(["silly dog"]), { apiKey: "sk-key" });

		expect(result.output[0]).toEqual({
			type: "image",
			data: WEBP_B64,
			mimeType: "image/webp",
		});
	});
});

// ---------------------------------------------------------------------------
// 4.  MIME sniffing
// ---------------------------------------------------------------------------

describe("MIME sniffing from decoded bytes", () => {
	test("PNG magic bytes → image/png", async () => {
		const gw = createJsonGateway({ data: [{ b64_json: PNG_B64 }] });
		const api = createNanImagesApi({ fetchImpl: gw.fetchImpl });

		const model = imageModelFixture({
			id: "flux-2-klein",
			name: "FLUX 2 Klein",
			input: ["text", "image"],
			output: ["image"],
		});
		const result = await api.generateImages(model, buildContext(["test"]), { apiKey: "sk-key" });
		expect(
			(result.output[0] as ImagesOutputContent & { mimeType: string }).mimeType,
		).toBe("image/png");
	});

	test("JPEG magic bytes → image/jpeg", async () => {
		const gw = createJsonGateway({ data: [{ b64_json: JPEG_B64 }] });
		const api = createNanImagesApi({ fetchImpl: gw.fetchImpl });

		const model = imageModelFixture({
			id: "flux-2-klein",
			name: "FLUX 2 Klein",
			input: ["text", "image"],
			output: ["image"],
		});
		const result = await api.generateImages(model, buildContext(["test"]), { apiKey: "sk-key" });
		expect(
			(result.output[0] as ImagesOutputContent & { mimeType: string }).mimeType,
		).toBe("image/jpeg");
	});

	test("WebP RIFF/WEBP magic → image/webp", async () => {
		const gw = createJsonGateway({ data: [{ b64_json: WEBP_B64 }] });
		const api = createNanImagesApi({ fetchImpl: gw.fetchImpl });

		const model = imageModelFixture({
			id: "flux-2-klein",
			name: "FLUX 2 Klein",
			input: ["text", "image"],
			output: ["image"],
		});
		const result = await api.generateImages(model, buildContext(["test"]), { apiKey: "sk-key" });
		expect(
			(result.output[0] as ImagesOutputContent & { mimeType: string }).mimeType,
		).toBe("image/webp");
	});
});

// ---------------------------------------------------------------------------
// 5.  missing API key
// ---------------------------------------------------------------------------

describe("missing API key", () => {
	test("yields error result with provider mention", async () => {
		const gw = createJsonGateway({});
		const api = createNanImagesApi({ fetchImpl: gw.fetchImpl });

		const model = imageModelFixture({
			id: "flux-2-klein",
			name: "FLUX 2 Klein",
			input: ["text", "image"],
			output: ["image"],
		});
		const result = await api.generateImages(model, buildContext(["test"]), {});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeDefined();
		expect(result.errorMessage).toContain("nan");
	});
});

// ---------------------------------------------------------------------------
// 6.  HTTP 403
// ---------------------------------------------------------------------------

describe("HTTP 403 response", () => {
	test("stopReason error with status in errorMessage", async () => {
		const fetchImpl = (async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
		const api = createNanImagesApi({ fetchImpl });

		const model = imageModelFixture({
			id: "flux-2-klein",
			name: "FLUX 2 Klein",
			input: ["text", "image"],
			output: ["image"],
		});
		const result = await api.generateImages(model, buildContext(["test"]), { apiKey: "sk-test" });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeDefined();
		expect(result.errorMessage).toContain("403");
	});
});

// ---------------------------------------------------------------------------
// 7.  abort
// ---------------------------------------------------------------------------

describe("abort", () => {
	test("pre-aborted signal gives stopReason aborted", async () => {
		const fetchImpl = (async () => {
			throw new Error("should not reach network");
		}) as unknown as typeof fetch;
		const api = createNanImagesApi({ fetchImpl });

		const model = imageModelFixture({
			id: "flux-2-klein",
			name: "FLUX 2 Klein",
			input: ["text", "image"],
			output: ["image"],
		});
		const signal = new AbortController();
		signal.abort();
		const result = await api.generateImages(model, buildContext(["test"]), {
			apiKey: "sk-test",
			signal: signal.signal,
		});

		expect(result.stopReason).toBe("aborted");
	});
});

// ---------------------------------------------------------------------------
// 8.  image-to-image (edit endpoint)
// ---------------------------------------------------------------------------

describe("image-to-image (edit endpoint)", () => {
	test("POST to /images/edits with FormData when model supports image input", async () => {
		const gw = createFormDataGateway({ data: [{ b64_json: PNG_B64 }] });
		const api = createNanImagesApi({ fetchImpl: gw.fetchImpl });

		const model = imageModelFixture({
			id: "flux-2-klein",
			name: "FLUX 2 Klein",
			input: ["text", "image"],
			output: ["image"],
		});
		const imageBlock: ImageContent = { type: "image", data: PNG_B64, mimeType: "image/png" };
		const context = buildContext(["edit this"], [imageBlock]);

		await api.generateImages(model, context, { apiKey: "sk-test" });

		// URL
		expect(gw.lastUrl()).toBe("https://api.nan.builders/v1/images/edits");

		const init = gw.lastInit()!;
		// Body is FormData
		expect(init.body).toBeInstanceOf(FormData);

		const form = init.body as FormData;
		// FormData fields
		expect(form.get("model")).toBe("flux-2-klein");
		expect(form.get("prompt")).toBe("edit this");
		expect(form.get("response_format")).toBe("b64_json");
		expect(form.getAll("image[]").length).toBe(1);

		// No Content-Type header — runtime sets multipart boundary automatically.
		const headers = init.headers;
		if (headers && typeof headers === "object" && !Array.isArray(headers)) {
			expect("Content-Type" in headers).toBe(false);
		}
	});

	test("FormData body is instance of FormData", async () => {
		const gw = createFormDataGateway({ data: [{ b64_json: JPEG_B64 }] });
		const api = createNanImagesApi({ fetchImpl: gw.fetchImpl });

		const model = imageModelFixture({
			id: "flux-2-klein",
			name: "FLUX 2 Klein",
			input: ["text", "image"],
			output: ["image"],
		});
		const imageBlock: ImageContent = { type: "image", data: JPEG_B64, mimeType: "image/jpeg" };
		const context = buildContext(["make it blue"], [imageBlock]);

		await api.generateImages(model, context, { apiKey: "sk-key" });

		expect(gw.lastInit()!.body).toBeInstanceOf(FormData);
	});
});

// ---------------------------------------------------------------------------
// 9.  text-only model receiving image input → error
// ---------------------------------------------------------------------------

describe("image input on text-only model", () => {
	test("error result naming the model", async () => {
		const gw = createJsonGateway({});
		const api = createNanImagesApi({ fetchImpl: gw.fetchImpl });

		const model = imageModelFixture({
			id: "qwen-image-2.1",
			name: "Qwen Image 2.1",
			input: ["text"],
			output: ["image"],
		});
		const imageBlock: ImageContent = { type: "image", data: PNG_B64, mimeType: "image/png" };
		const context = buildContext(["edit"], [imageBlock]);

		const result = await api.generateImages(model, context, { apiKey: "sk-test" });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeDefined();
		expect(result.errorMessage).toContain("qwen-image-2.1");
	});
});

// ---------------------------------------------------------------------------
// 10.  empty input (no text, no image)
// ---------------------------------------------------------------------------

describe("empty input", () => {
	test("no text and no image → error result", async () => {
		const gw = createJsonGateway({});
		const api = createNanImagesApi({ fetchImpl: gw.fetchImpl });

		const model = imageModelFixture({
			id: "flux-2-klein",
			name: "FLUX 2 Klein",
			input: ["text", "image"],
			output: ["image"],
		});
		const context = { input: [] as ImagesContext["input"] } as ImagesContext;

		const result = await api.generateImages(model, context, { apiKey: "sk-test" });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// 11.  200 with no image data
// ---------------------------------------------------------------------------

describe("200 response with no image data", () => {
	test("data array empty → error result", async () => {
		const gw = createJsonGateway({ data: [] });
		const api = createNanImagesApi({ fetchImpl: gw.fetchImpl });

		const model = imageModelFixture({
			id: "flux-2-klein",
			name: "FLUX 2 Klein",
			input: ["text", "image"],
			output: ["image"],
		});
		const result = await api.generateImages(model, buildContext(["test"]), { apiKey: "sk-test" });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// 12.  NEVER throws
// ---------------------------------------------------------------------------

describe("createNanImagesApi never throws", () => {
	test("even when fetchImpl throws", async () => {
		const fetchImpl = (async () => {
			throw new Error("network error");
		}) as unknown as typeof fetch;
		const api = createNanImagesApi({ fetchImpl });

		const model = imageModelFixture({
			id: "flux-2-klein",
			name: "FLUX 2 Klein",
			input: ["text", "image"],
			output: ["image"],
		});
		// Should not throw — must return error result
		const result = await api.generateImages(model, buildContext(["test"]), { apiKey: "sk-test" });
		expect(result.stopReason).toBe("error");
	});
});

// ---------------------------------------------------------------------------
// 13.  Default options (undefined)
// ---------------------------------------------------------------------------

describe("createNanImagesApi with no options", () => {
	test("defaults to no timeout and the fetch polyfill", async () => {
		const gw = createJsonGateway({ data: [{ b64_json: PNG_B64 }] });
		const api = createNanImagesApi({ fetchImpl: gw.fetchImpl });

		const model = imageModelFixture({
			id: "flux-2-klein",
			name: "FLUX 2 Klein",
			input: ["text", "image"],
			output: ["image"],
		});
		// undefined options should not throw
		expect(() => createNanImagesApi()).not.toThrow();
	});
});
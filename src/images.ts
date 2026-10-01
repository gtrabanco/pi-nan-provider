/**
 * NaN image generation API — custom API id, model definitions, and a
 * ProviderImages implementation talking to the OpenAI-compatible image
 * endpoints at api.nan.builders.
 *
 * NaN exposes two OpenAI-compatible image endpoints:
 *
 *   POST /v1/images/generations  — text-to-image (JSON body)
 *   POST /v1/images/edits        — image-to-image (multipart/form-data)
 *
 * Both require the inference-tier membership (403 otherwise) and share a
 * 20 req/min / 100 req/month quota separate from the chat token budget
 * (https://nan.builders/docs/models and https://nan.builders/openapi.json,
 * checked 2026-10-01).
 *
 * We register a custom API id "nan-images" so pi's model registry can route
 * generateImages calls through our implementation (createNanImagesApi), and
 * register the resulting ProviderImages via createProvider({ images: ... }).
 *
 * Style note (per repo conventions): only type-only imports from the bare
 * root "@earendil-works/pi-ai". No subpath imports — pi's extension loader
 * aliases subpaths and the whole extension fails to load. No imageErrorResult
 * import either: pi-ai exposes it only under the forbidden
 * "@earendil-works/pi-ai/utils/..." subpath, so error results are built here.
 */

import type {
	AssistantImages,
	ImageModel,
	ProviderImages,
} from "@earendil-works/pi-ai";

// ── Custom API id ──────────────────────────────────────────────────────────

/** Custom image-api id for NaN image generation. */
export const NAN_IMAGE_API = "nan-images";

// ── Model definitions ─────────────────────────────────────────────────────

/**
 * Static image-model definition carrying input/output modalities and
 * provenance notes. Kept local (not in the generated chat catalog) because
 * these are image endpoints, not chat models: NON_CHAT_MODEL_IDS still keeps
 * them out of the chat catalog, and this list is the image-side counterpart.
 */
export interface NanImageModelDefinition {
	/** Stable model id, e.g. "flux-2-klein". */
	id: string;
	/** Human-readable model name, e.g. "FLUX 2 Klein". */
	name: string;
	/** Input modalities the model accepts. */
	input: ("text" | "image")[];
	/** Output modalities the model produces. */
	output: ("text" | "image")[];
	/** Provenance notes citing sources for every capability claim. */
	notes: string[];
}

/**
 * All NaN image models known to this provider. Two entries, ordered:
 * flux-2-klein (text+image input), qwen-image-2.1 (text-only).
 */
export const NAN_IMAGE_MODELS: readonly NanImageModelDefinition[] = [
	{
		id: "flux-2-klein",
		name: "FLUX 2 Klein",
		input: ["text", "image"],
		output: ["image"],
		notes: [
			"Image generation endpoint (text-to-image and image-to-image). " +
				"Documented in https://nan.builders/docs/models and " +
				"https://nan.builders/openapi.json (checked 2026-10-01): POST " +
				"/v1/images/generations and POST /v1/images/edits (1-4 reference " +
				"images; mask unsupported). Requires inference-tier membership " +
				"(403 otherwise); image endpoints are rate-limited separately " +
				"from chat (20 req/min, 100 req/month shared with qwen-image-2.1) " +
				"and do not consume the chat token budget. models.dev provider " +
				"nan does not list flux-2-klein (checked 2026-10-01), so this is " +
				"a manual entry; per-token cost is 0 because NaN bills image " +
				"generation by request quota on the same membership model as chat.",
		],
	},
	{
		id: "qwen-image-2.1",
		name: "Qwen-Image-2.1",
		input: ["text"],
		output: ["image"],
		notes: [
			"Image generation endpoint (text-to-image only). Documented in " +
				"https://nan.builders/docs/models and " +
				"https://nan.builders/openapi.json (checked 2026-10-01): POST " +
				"/v1/images/generations. models.dev provider nan lists it " +
				"(checked 2026-10-01) with cost 0/0 and limit.output 0 (it " +
				"returns image bytes, not tokens). Same inference-tier " +
				"requirement and 100 req/month quota shared with " +
				"flux-2-klein; image-to-image (/images/edits) is not documented " +
				"for this model.",
		],
	},
] as const;

// ── Baseline models ────────────────────────────────────────────────────────

/**
 * Structural source shape (same as fetch-models.ts CatalogSource) declared
 * locally so this module has zero circular dependency on fetch-models.
 */
interface ImageCatalogSource {
	/** Provider id as registered in pi, e.g. "nan". */
	providerId: string;
	/** OpenAI-compatible base URL including version path. */
	baseUrl: string;
}

/**
 * Map every entry in NAN_IMAGE_MODELS to a pi-ai ImageModel for our custom
 * API id. Per-token cost is 0: NaN bills image generation by request quota
 * on the membership model, the same convention the generated chat catalog
 * uses for NaN's quota-based pricing.
 */
export function baselineImageModels(
	source: ImageCatalogSource,
): ImageModel<typeof NAN_IMAGE_API>[] {
	return NAN_IMAGE_MODELS.map(
		(model): ImageModel<typeof NAN_IMAGE_API> => ({
			id: model.id,
			name: model.name,
			type: "image",
			api: NAN_IMAGE_API,
			provider: source.providerId,
			baseUrl: source.baseUrl,
			input: [...model.input],
			output: [...model.output],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}),
	);
}

// ── API implementation ─────────────────────────────────────────────────────

/** Injectable options for createNanImagesApi (fetchImpl is for tests). */
export interface CreateNanImagesApiOptions {
	/** Injectable fetch for tests; defaults to globalThis.fetch. */
	fetchImpl?: typeof fetch;
	/** Default per-request timeout in ms when the caller does not supply one. */
	timeoutMs?: number;
}

/**
 * Build a ProviderImages implementation for NaN's OpenAI-compatible image
 * endpoints (POST /v1/images/generations and POST /v1/images/edits).
 *
 * We always request b64_json (not "url") so the returned images carry their
 * base64 data directly — no separate download step is needed. NaN returns
 * raw base64 with no MIME type, so the output type is sniffed from the
 * decoded magic bytes.
 *
 * Contract: never throws. Auth failures, invalid input, transport errors and
 * non-OK responses all surface as an AssistantImages with stopReason
 * "error" (or "aborted" when the caller's signal aborted).
 */
export function createNanImagesApi(
	options?: CreateNanImagesApiOptions,
): ProviderImages {
	const fetchImpl = options?.fetchImpl ?? globalThis.fetch;

	return {
		async generateImages(model, context, requestOptions) {
			const base: AssistantImages = {
				api: model.api,
				provider: model.provider,
				model: model.id,
				output: [],
				stopReason: "stop",
				timestamp: Date.now(),
			};

			try {
				// ── Auth ────────────────────────────────────────────────
				const apiKey = requestOptions?.apiKey;
				if (!apiKey) {
					throw new Error("No API key for provider: " + model.provider);
				}

				// ── Input extraction ────────────────────────────────────
				const text = context.input
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n")
					.trim();
				const referenceImages = context.input.filter(
					(block) => block.type === "image",
				);

				if (text.length === 0 && referenceImages.length === 0) {
					throw new Error(
						"Image generation requires a text prompt or a reference image",
					);
				}

				// Reference images need a model that accepts image input
				// (flux-2-klein); qwen-image-2.1 is text-to-image only.
				if (
					referenceImages.length > 0 &&
					!model.input.includes("image")
				) {
					throw new Error(
						"Model " + model.id + " does not accept image input",
					);
				}

				// ── Endpoint selection ──────────────────────────────────
				const endpoint =
					referenceImages.length > 0
						? "/images/edits"
						: "/images/generations";
				const url = model.baseUrl.replace(/\/+$/, "") + endpoint;

				// ── Headers ─────────────────────────────────────────────
				// Merge model headers with caller headers, dropping null
				// values (ProviderHeaders uses null to suppress a default).
				// Bearer auth is applied last so caller values cannot
				// override the provider credential.
				const headers: Record<string, string> = {};
				for (const [key, value] of Object.entries({
					...model.headers,
					...requestOptions?.headers,
				})) {
					if (typeof value === "string") headers[key] = value;
				}
				headers.Authorization = "Bearer " + apiKey;

				// ── Optional metadata passthrough ───────────────────────
				// n, size, seed and guidance are NaN extensions accepted on
				// both endpoints; pass them through only with the right type.
				const metadata = (requestOptions?.metadata ?? {}) as Record<
					string,
					unknown
				>;
				const optionalFields: Record<string, string | number> = {};
				if (typeof metadata.n === "number") optionalFields.n = metadata.n;
				if (typeof metadata.size === "string") optionalFields.size = metadata.size;
				if (typeof metadata.seed === "number") optionalFields.seed = metadata.seed;
				if (typeof metadata.guidance === "number") {
					optionalFields.guidance = metadata.guidance;
				}

				// ── Request body ────────────────────────────────────────
				let body: FormData | string;
				if (referenceImages.length > 0) {
					// Image-to-image: multipart/form-data. Content-Type is
					// deliberately NOT set — fetch adds the boundary.
					const form = new FormData();
					form.set("model", model.id);
					form.set("prompt", text);
					form.set("response_format", "b64_json");
					for (const [key, value] of Object.entries(optionalFields)) {
						form.set(key, String(value));
					}
					for (const image of referenceImages) {
						// Decode base64 with atob (no Buffer: the extension
						// must not assume a Node-only global).
						const bytes = Uint8Array.from(atob(image.data), (char) =>
							char.charCodeAt(0),
						);
						form.append(
							"image[]",
							new Blob([bytes], {
								type: image.mimeType || "image/png",
							}),
							"reference.png",
						);
					}
					body = form;
				} else {
					headers["Content-Type"] = "application/json";
					// fetch does not serialize plain objects: build the JSON text here.
					body = JSON.stringify({
						model: model.id,
						prompt: text,
						response_format: "b64_json",
						...optionalFields,
					});
				}

				// ── Signal (timeout + caller abort) ─────────────────────
				const timeoutMs = requestOptions?.timeoutMs ?? options?.timeoutMs;
				let signal: AbortSignal | undefined;
				if (timeoutMs) {
					const timeoutSignal = AbortSignal.timeout(timeoutMs);
					signal = requestOptions?.signal
						? AbortSignal.any([timeoutSignal, requestOptions.signal])
						: timeoutSignal;
				} else if (requestOptions?.signal) {
					signal = requestOptions.signal;
				}

				// ── HTTP call ───────────────────────────────────────────
				const response = await fetchImpl(url, {
					method: "POST",
					headers,
					body: body as RequestInit["body"],
					...(signal ? { signal } : {}),
				});

				if (!response.ok) {
					// Best-effort error body: NaN usually returns
					// {"error":{"message":"..."}} (403 for a missing
					// inference tier, 429 for the quota).
					let bodyText = "";
					try {
						bodyText = await response.text();
					} catch {
						// Ignore read errors — best effort only.
					}
					throw new Error(
						"NaN image request failed: HTTP " +
							response.status +
							(bodyText ? " " + bodyText : ""),
					);
				}

				// ── Parse response ──────────────────────────────────────
				const payload = (await response.json()) as {
					data?: Array<{ b64_json?: string }>;
				};
				for (const item of payload.data ?? []) {
					if (
						typeof item.b64_json === "string" &&
						item.b64_json.length > 0
					) {
						base.output.push({
							type: "image",
							data: item.b64_json,
							mimeType: sniffImageMimeType(item.b64_json),
						});
					}
				}
				if (base.output.length === 0) {
					throw new Error("NaN image response contained no image data");
				}

				return base;
			} catch (error) {
				base.stopReason =
					requestOptions?.signal?.aborted === true ? "aborted" : "error";
				base.errorMessage =
					error instanceof Error ? error.message : String(error);
				return base;
			}
		},
	};
}

// ── MIME-type sniffing ─────────────────────────────────────────────────────

/**
 * Sniff the MIME type from a base64-encoded image string by inspecting the
 * leading magic bytes.
 *
 * PNG:  89 50 4E 47  → "image/png"
 * JPEG: FF D8 FF     → "image/jpeg"
 * WebP: RIFF....WEBP → "image/webp"
 *
 * NaN returns raw base64 without a MIME type, so we infer it from the
 * signature instead of guessing. Falls back to "image/png" and never throws.
 */
function sniffImageMimeType(base64: string): string {
	try {
		// Only the first 16 bytes are needed to identify PNG/JPEG/WebP.
		const decoded = atob(base64.slice(0, 16));
		const bytes = new Uint8Array(decoded.length);
		for (let i = 0; i < decoded.length; i++) {
			bytes[i] = decoded.charCodeAt(i);
		}

		if (
			bytes[0] === 0x89 &&
			bytes[1] === 0x50 &&
			bytes[2] === 0x4e &&
			bytes[3] === 0x47
		) {
			return "image/png";
		}
		if (
			bytes[0] === 0xff &&
			bytes[1] === 0xd8 &&
			bytes[2] === 0xff
		) {
			return "image/jpeg";
		}
		if (
			bytes[0] === 0x52 &&
			bytes[1] === 0x49 &&
			bytes[2] === 0x46 &&
			bytes[3] === 0x46 &&
			bytes[8] === 0x57 &&
			bytes[9] === 0x45 &&
			bytes[10] === 0x42 &&
			bytes[11] === 0x50
		) {
			return "image/webp";
		}
		return "image/png";
	} catch {
		return "image/png";
	}
}

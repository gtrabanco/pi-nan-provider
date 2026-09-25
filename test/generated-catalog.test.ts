/**
 * Contract tests for the generated fallback catalog (scripts/models.generated.ts)
 * and the manual override layer (scripts/manual-overrides.ts).
 *
 * models.dev lags behind gateway capability changes; MANUAL_OVERRIDES exists
 * so a divergence can be recorded with provenance instead of hand-editing
 * the generated file. As of 2026-09-07 https://nan.builders/docs/models and
 * https://nan.builders/openapi.json are treated as the most reliable source
 * of truth (maintainer instruction); models.dev divergences from them are
 * recorded as overrides or exclusions with provenance.
 */

import { describe, expect, test } from "bun:test";
import { MANUAL_ONLY_MODELS, MANUAL_OVERRIDES } from "../scripts/manual-overrides.ts";
import { GENERATED_CATALOG_META, NAN_GENERATED_MODELS } from "../scripts/models.generated.ts";

const byId = new Map(NAN_GENERATED_MODELS.map((entry) => [entry.id, entry]));

describe("manual overrides in the generated catalog", () => {
	test("catalog matches the served community chat models (official model list minus premium glm5.3)", () => {
		// Official chat models per https://nan.builders/openapi.json (model param
		// description) and https://nan.builders/docs/models (checked 2026-09-25):
		// deepseek-v4-flash, mimo-v2.5, mimo-v2.6-flash, qwen3.8-flash,
		// glm5.3-flash, qwen3.6, gemma4, glm5.3. glm5.3 is premium-tier and
		// unemittable (no documented max output anywhere), so the static fallback
		// holds the other seven.
		expect([...byId.keys()].sort()).toEqual(
			[
				"deepseek-v4-flash",
				"gemma4",
				"glm5.3-flash",
				"mimo-v2.5",
				"mimo-v2.6-flash",
				"qwen3.6",
				"qwen3.8-flash",
			],
		);
	});

	test("mimo-v2.6-flash ships real limits instead of the 128K unknown-model placeholder", () => {
		// models.dev provider nan does not list it (checked 2026-09-25), so it is
		// emitted from MANUAL_ONLY_MODELS. Without it, the live /models merge hands
		// it UNKNOWN_MODEL_LIMITS (128,000 / 4,096, reasoning off, text-only input)
		// and pi would compact around 100K tokens instead of 1M.
		const entry = byId.get("mimo-v2.6-flash");
		expect(entry).toBeDefined();
		expect(entry!.contextWindow).toBe(1_048_576);
		expect(entry!.maxTokens).toBe(131_072);
		expect(entry!.input).toEqual(["text", "image"]);
		expect(entry!.reasoning).toBe(true);
		expect(entry!.compat?.supportsFinishReason).toBe(true);
		expect(entry!.compat?.supportsUsageInStreaming).toBe(true);
	});

	test("every manual-only model reaches the catalog, or its absence is recorded", () => {
		for (const [modelId, manual] of Object.entries(MANUAL_ONLY_MODELS)) {
			const entry = byId.get(modelId);
			if (entry) {
				// ManualModelOverride fields are optional by design, but all our
				// manual-only entries set them explicitly, so we assert non-null.
				expect(entry.contextWindow, `${modelId}.contextWindow`).toBe(manual.contextWindow!);
				expect(entry.maxTokens, `${modelId}.maxTokens`).toBe(manual.maxTokens!);
				expect(entry.input, `${modelId}.input`).toEqual(manual.input!);
				expect(entry.reasoning, `${modelId}.reasoning`).toBe(manual.reasoning!);
				// The generator prefixes the manual-only note with `manual-only:`
				// and wraps the detail in parentheses, so we check for both the
				// model ID and the manual note content as a substring.
				expect(
					entry.notes?.some((value) =>
						value.includes(`manual-only: "${modelId}"`) && value.includes(manual.note),
					),
					`${modelId} note`,
				).toBe(true);
			} else {
				// models.dev started listing it: the generator drops the manual entry and
				// records why, so nothing disappears silently.
				expect(
					GENERATED_CATALOG_META.notes.some((note) =>
						note.includes(`manual-only: "${modelId}" skipped`),
					),
					`${modelId} absence must be recorded`,
				).toBe(true);
			}
		}
	});

	test("manual-only entries never fabricate values or provenance", () => {
		for (const [modelId, manual] of Object.entries(MANUAL_ONLY_MODELS)) {
			expect(manual.note.trim().length, `${modelId} note`).toBeGreaterThan(40);
			expect(manual.input!.includes("text"), `${modelId} input must include text`).toBe(true);
			expect(manual.contextWindow!, `${modelId} contextWindow`).toBeGreaterThan(0);
			expect(manual.maxTokens!, `${modelId} maxTokens`).toBeGreaterThan(0);
		}
	});

	test("qwen3.8-flash context window follows the docs at 262K native (1M override withdrawn)", () => {
		const entry = byId.get("qwen3.8-flash");
		expect(entry).toBeDefined();
		expect(entry!.contextWindow).toBe(262_144);
		// The 1,000,000 override (maintainer-confirmed 2026-09-05) was withdrawn
		// once the docs were updated on 2026-09-07 and still said "262K token
		// context, the model's native window"; models.dev agrees at 262,144.
		expect(MANUAL_OVERRIDES["qwen3.8-flash"]).toBeUndefined();
		const note = entry!.notes?.find((value) => value.includes("withdrawn"));
		expect(note).toBeDefined();
		expect(note).toContain("262,144");
		expect(note).toContain("2026-09-07");
		expect(note).toContain("native window");
	});

	test("glm5.2 stays excluded even though models.dev re-listed it", () => {
		// Removed by the provider (2026-09-05); absent from the official chat
		// model list (openapi.json + docs, checked 2026-09-07). models.dev still
		// listed it on 2026-09-07 — the generator must exclude it, never emit it.
		expect(byId.get("glm5.2")).toBeUndefined();
		expect(
			GENERATED_CATALOG_META.notes.some(
				(note) => note.includes("glm5.2") && note.includes("provider-removed"),
			),
		).toBe(true);
	});

	test("glm5.3 premium model stays live-only (documented by models.dev, out of the static catalog)", () => {
		// Served by NaN on the premium tier and now documented by models.dev
		// (1M context / 131,072 max output, checked 2026-09-13), but deliberately
		// kept out of the static fallback so a non-premium key never sees it when
		// the live /models fetch is unavailable. Premium keys still get it live
		// via the /models refresh (conservative placeholder limits).
		expect(byId.get("glm5.3")).toBeUndefined();
		expect(
			GENERATED_CATALOG_META.notes.some(
				(note) => note.includes("glm5.3") && note.includes("premium-tier") && note.includes("live-only"),
			),
		).toBe(true);
	});

	test("glm5.3-flash context window is 1M tokens (models.dev value, no override needed)", () => {
		const entry = byId.get("glm5.3-flash");
		expect(entry).toBeDefined();
		expect(entry!.contextWindow).toBe(1_000_000);
		expect(MANUAL_OVERRIDES["glm5.3-flash"]).toBeUndefined();
	});

	test("every declared override lands on the generated entry and carries its provenance note", () => {
		for (const [modelId, override] of Object.entries(MANUAL_OVERRIDES)) {
			const entry = byId.get(modelId);
			expect(entry, `generated catalog is missing overridden model "${modelId}"`).toBeDefined();
			const { note, ...fields } = override;
			for (const [field, value] of Object.entries(fields)) {
				expect((entry as unknown as Record<string, unknown>)[field], `${modelId}.${field}`).toEqual(value);
			}
			expect(entry!.notes?.some((value) => value === note), `${modelId} note`).toBe(true);
		}
	});

	test("every generated entry treats a missing finish_reason as a retryable error (issue #2)", () => {
		// The NaN LiteLLM gateway intermittently closes SSE streams before
		// emitting finish_reason. supportsFinishReason must be true so pi-ai
		// raises the retryable "Stream ended without finish_reason" instead of
		// silently synthesizing stop/toolUse and stalling the turn.
		expect(NAN_GENERATED_MODELS.length).toBeGreaterThan(0);
		for (const entry of NAN_GENERATED_MODELS) {
			expect(entry.compat?.supportsFinishReason, entry.id).toBe(true);
		}
		// The provenance note must record the flag.
		expect(
			GENERATED_CATALOG_META.notes.some(
				(note) => note.includes("supportsFinishReason") && note.includes("true"),
			),
		).toBe(true);
	});

	test("overrides never fabricate values without a note", () => {
		// Structural guard: a field-keyed override with an empty/missing note
		// would violate the repo's no-fabrication rule.
		for (const [modelId, override] of Object.entries(MANUAL_OVERRIDES)) {
			const { note, ...fields } = override;
			if (Object.keys(fields).length > 0) {
				expect(note.trim().length, `${modelId} override note`).toBeGreaterThan(20);
			}
		}
	});
});

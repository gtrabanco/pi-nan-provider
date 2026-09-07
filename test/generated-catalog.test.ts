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
import { MANUAL_OVERRIDES } from "../scripts/manual-overrides.ts";
import { GENERATED_CATALOG_META, NAN_GENERATED_MODELS } from "../scripts/models.generated.ts";

const byId = new Map(NAN_GENERATED_MODELS.map((entry) => [entry.id, entry]));

describe("manual overrides in the generated catalog", () => {
	test("catalog matches the served community chat models (official model list minus premium glm5.3)", () => {
		// Official chat models per https://nan.builders/openapi.json (model param
		// description) and https://nan.builders/docs/models (checked 2026-09-07):
		// deepseek-v4-flash, mimo-v2.5, qwen3.8-flash, glm5.3-flash, qwen3.6,
		// gemma4, glm5.3. glm5.3 is premium-tier and unemittable (no documented
		// max output anywhere), so the static fallback holds the other six.
		expect([...byId.keys()].sort()).toEqual(
			["deepseek-v4-flash", "gemma4", "glm5.3-flash", "mimo-v2.5", "qwen3.6", "qwen3.8-flash"],
		);
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

	test("glm5.3 premium model is flagged as unemittable, not invented", () => {
		// Served by NaN on the premium tier but absent from models.dev and with
		// no documented max output tokens — must stay out of the static catalog
		// and be flagged in the metadata (no-fabrication rule).
		expect(byId.get("glm5.3")).toBeUndefined();
		expect(
			GENERATED_CATALOG_META.notes.some(
				(note) => note.includes("glm5.3") && note.includes("premium tier") && note.includes("no-fabrication"),
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

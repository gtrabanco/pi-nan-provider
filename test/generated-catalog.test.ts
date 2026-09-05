/**
 * Contract tests for the generated fallback catalog (scripts/models.generated.ts)
 * and the manual override layer (scripts/manual-overrides.ts).
 *
 * models.dev lags behind gateway capability changes; MANUAL_OVERRIDES exists
 * so a divergence can be recorded with provenance instead of hand-editing
 * the generated file. These tests pin the two 1M-context models and the
 * invariant that every override actually lands on the generated entry with
 * its provenance note.
 */

import { describe, expect, test } from "bun:test";
import { MANUAL_OVERRIDES } from "../scripts/manual-overrides.ts";
import { NAN_GENERATED_MODELS } from "../scripts/models.generated.ts";

const byId = new Map(NAN_GENERATED_MODELS.map((entry) => [entry.id, entry]));

describe("manual overrides in the generated catalog", () => {
	test("qwen3.8-flash context window is maintainer-confirmed at 1M tokens", () => {
		const entry = byId.get("qwen3.8-flash");
		expect(entry).toBeDefined();
		expect(entry!.contextWindow).toBe(1_000_000);
		const note = entry!.notes?.find((value) => value.includes("contextWindow"));
		expect(note).toBeDefined();
		expect(note).toContain("2026-09-05");
		// The note must record the contradiction with the public sources so the
		// override can be re-verified when models.dev / NaN docs catch up.
		expect(note).toContain("262,144");
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

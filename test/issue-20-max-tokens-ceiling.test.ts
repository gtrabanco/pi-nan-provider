/**
 * ACCEPTANCE TESTS — issue #20
 * "deepseek-v4-flash maxTokens must be 32,768, not 384,000"
 *
 * https://github.com/gtrabanco/pi-nan-provider/issues/20
 *
 * The bug: NaN's gateway rejects `deepseek-v4-flash` requests with
 * `max_tokens` above ~256k with HTTP 403 `permission_error` (measured:
 * 256,000 → 200; 262,143 → 403). The generated catalog declared
 * `maxTokens: 384000` (models.dev value), so every pi request to this model
 * that hit the ceiling failed with 403.
 *
 * The fix: https://nan.builders/docs/pi (the official pi setup page,
 * "the same set the NaN CLI writes") declares `maxTokens: 32768` for
 * deepseek-v4-flash. This is the documented ceiling and the authoritative
 * value. models.dev still lists 384000, so the override pins 32768 in
 * `MANUAL_OVERRIDES`.
 *
 * Provenance: docs/pi ceiling (https://nan.builders/docs/pi, checked 2026-10-02)
 * closing issue #20, the measured 403 behavior (2026-10-02: 256,000 → 200;
 * 262,143 → 403), and the previous models.dev-derived 384000 making every
 * pi request fail.
 */

import { describe, expect, test } from "bun:test";
import { MANUAL_OVERRIDES } from "../scripts/manual-overrides.ts";
import { GENERATED_CATALOG_META, NAN_GENERATED_MODELS } from "../scripts/models.generated.ts";
import { baselineModels, toModel } from "../src/fetch-models.ts";

const SOURCE = { providerId: "nan", baseUrl: "https://api.nan.builders/v1" } as const;

const byId = new Map(NAN_GENERATED_MODELS.map((entry) => [entry.id, entry]));

describe("issue #20 — deepseek-v4-flash maxTokens ceiling", () => {
	test("generated catalog entry for deepseek-v4-flash has maxTokens=32768", () => {
		const entry = byId.get("deepseek-v4-flash");
		expect(entry, "generated catalog must contain deepseek-v4-flash").toBeDefined();
		expect(entry!.maxTokens).toBe(32_768);
	});

	test("generated catalog entry for deepseek-v4-flash still has contextWindow=1000000 (unchanged)", () => {
		const entry = byId.get("deepseek-v4-flash");
		expect(entry!.contextWindow).toBe(1_000_000);
	});

	test("baseline model for deepseek-v4-flash exposes maxTokens=32768", () => {
		const baselines = baselineModels(SOURCE);
		const model = baselines.find((m) => m.id === "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(model!.maxTokens).toBe(32_768);
		expect(model!.contextWindow).toBe(1_000_000);
	});

	test("MANUAL_OVERRIDES['deepseek-v4-flash'] has maxTokens=32768 with provenance note", () => {
		const override = MANUAL_OVERRIDES["deepseek-v4-flash"];
		expect(override).toBeDefined();
		expect(override!.maxTokens).toBe(32_768);
		// The note must reference the provenance source: docs/pi URL, date, issue #20, and the measured 403 behavior.
		expect(override!.note).toContain("32768");
		expect(override!.note).toContain("docs/pi");
		expect(override!.note).toContain("2026-10-02");
		expect(override!.note).toContain("403");
		expect(override!.note).toContain("#20");
	});

	test("the note must cite the official NaN pi docs as provenance", () => {
		const override = MANUAL_OVERRIDES["deepseek-v4-flash"];
		expect(override!.note).toContain("https://nan.builders/docs/pi");
		expect(override!.note).toContain("the same set the NaN CLI writes");
	});

	test("the generated note for deepseek-v4-flash includes the maxTokens provenance paragraph", () => {
		const entry = byId.get("deepseek-v4-flash");
		expect(entry).toBeDefined();
		const maxTokensNote = entry!.notes?.find((n) => n.includes("maxTokens 32768"));
		expect(maxTokensNote, "generated entry must carry the maxTokens provenance note").toBeDefined();
		expect(maxTokensNote).toContain("#20");
		expect(maxTokensNote).toContain("2026-10-02");
	});

	test("384000 must NOT appear in the generated catalog for deepseek-v4-flash", () => {
		const entry = byId.get("deepseek-v4-flash");
		expect(entry!.maxTokens).not.toBe(384_000);
		expect(entry!.maxTokens).toBe(32_768);
	});

	test("the generated catalog still preserves the extras (models.dev) limit.output=384000 for provenance", () => {
		// extras keeps the raw models.dev data so provenance is preserved.
		const entry = byId.get("deepseek-v4-flash");
		expect(entry!.extras).toBeDefined();
		// models.dev's raw value should still be in extras for traceability.
		const extrasLimit = (entry!.extras as Record<string, unknown>)["limit"];
		if (typeof extrasLimit === "object" && extrasLimit !== null && "output" in (extrasLimit as Record<string, unknown>)) {
			expect((extrasLimit as Record<string, unknown>).output).toBe(384_000);
		}
	});
});
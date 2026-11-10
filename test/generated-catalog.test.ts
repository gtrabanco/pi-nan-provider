/**
 * Contract tests for the generated fallback catalog (scripts/models.generated.ts)
 * and the manual override layer (scripts/manual-overrides.ts).
 *
 * models.dev lags behind gateway capability changes; MANUAL_OVERRIDES exists
 * so a divergence can be recorded with provenance instead of hand-editing
 * the generated file. https://nan.builders/docs/models is the source of truth
 * for WHICH models exist and what they document (maintainer instruction,
 * reaffirmed 2026-09-29); models.dev supplies the numeric limits and any
 * divergence from the docs is recorded as an override or exclusion with
 * provenance.
 */

import { describe, expect, test } from "bun:test";
import { MANUAL_ONLY_MODELS, MANUAL_OVERRIDES } from "../scripts/manual-overrides.ts";
import { GENERATED_CATALOG_META, NAN_GENERATED_MODELS } from "../scripts/models.generated.ts";

const byId = new Map(NAN_GENERATED_MODELS.map((entry) => [entry.id, entry]));

describe("manual overrides in the generated catalog", () => {
	test("catalog matches the served NaN chat models (documented set plus the 2026-11-10 external models)", () => {
		// Official chat models per https://nan.builders/docs/models and the model
		// param description in https://nan.builders/openapi.json (checked
		// 2026-09-29): deepseek-v4-flash, mimo-v2.6-flash, qwen3.8-flash,
		// glm5.3-flash, qwen3.6, gemma4, glm5.3. mimo-v2.5 is gone from both
		// sources (removed by NaN, replaced by mimo-v2.6-flash). NaN removed
		// tier-exclusive models on 2026-11-10, so glm5.3 is a general catalog
		// model, and the same day it launched four external-provider models
		// the docs do not list yet (kimi-k3.1-pro, qwen3.8-max,
		// deepseek-v4-pro, hy4).
		expect([...byId.keys()].sort()).toEqual(
			[
				"deepseek-v4-flash",
				"deepseek-v4-pro",
				"gemma4",
				"glm5.3",
				"glm5.3-flash",
				"hy4",
				"kimi-k3.1-pro",
				"mimo-v2.6-flash",
				"qwen3.6",
				"qwen3.8-flash",
				"qwen3.8-max",
			],
		);
	});

	// S2 of odd/tasks/nan-external-models-2026-11.md: values come from NaN's pricing
	// page ("1M context"), https://nan.builders/docs/pi (maxTokens 32768 for every
	// 1M NaN model) and first-party vendor entries on models.dev; reasoning effort
	// mapping for external providers is unmeasured, so none is declared.
	const EXTERNAL_MODELS = [
		{ id: "kimi-k3.1-pro", contextWindow: 1_048_576, input: ["text", "image"] },
		{ id: "qwen3.8-max", contextWindow: 1_000_000, input: ["text", "image"] },
		{ id: "deepseek-v4-pro", contextWindow: 1_048_576, input: ["text"] },
		{ id: "hy4", contextWindow: 1_048_576, input: ["text", "image"] },
	] as const;
	for (const expected of EXTERNAL_MODELS) {
		test(`${expected.id} ships its documented capabilities with provenance (2026-11-10)`, () => {
			const entry = byId.get(expected.id);
			expect(entry).toBeDefined();
			expect(entry!.contextWindow).toBe(expected.contextWindow);
			expect(entry!.maxTokens).toBe(32_768);
			expect(entry!.input).toEqual([...expected.input]);
			expect(entry!.reasoning).toBe(true);
			expect(entry!.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			expect(entry!.reasoningEffortValues).toEqual([]);
			expect(entry!.thinkingLevelMap).toBeUndefined();
			expect(entry!.compat?.supportsFinishReason).toBe(true);
			expect(entry!.compat?.supportsUsageInStreaming).toBe(true);
			const provenance = entry!.notes?.filter((n) => n.includes("2026-11-10") && n.includes("https://")) ?? [];
			expect(provenance.length, `${expected.id} provenance note`).toBeGreaterThan(0);
		});
	}

	test("mimo-v2.5 stays excluded after NaN removed it from the docs", () => {
		// Removed by the provider: zero mentions in https://nan.builders/docs/models
		// and in the openapi.json model param description (checked 2026-09-29), and
		// models.dev provider nan dropped it as well. The generation must record the
		// reason instead of silently losing the model (mirrors the glm5.2 record).
		expect(byId.get("mimo-v2.5")).toBeUndefined();
		expect(
			GENERATED_CATALOG_META.notes.some(
				(note) => note.includes("mimo-v2.5") && note.includes("provider-removed"),
			),
		).toBe(true);
	});

	test("mimo-v2.6-flash ships real limits instead of the 128K unknown-model placeholder", () => {
		// It entered the catalog through MANUAL_ONLY_MODELS when models.dev did
		// not list it (2026-09-25); models.dev started listing it on 2026-09-29
		// with the same limits, so the entry now comes from models.dev and the
		// manual note rides on it. Either way the live /models merge must resolve
		// it to real capabilities: otherwise it hands it UNKNOWN_MODEL_LIMITS
		// (128,000 / 4,096, reasoning off, text-only input) and pi would compact
		// around 100K tokens instead of 1M.
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
				// The generator records a `manual-only: "<id>"` line and carries the
				// manual note either inside that line (as its detail) or as its own
				// entry (the override note), so the provenance is never dropped.
				expect(
					entry.notes?.some((value) => value.includes(`manual-only: "${modelId}"`)),
					`${modelId} manual-only line`,
				).toBe(true);
				expect(
					entry.notes?.some((value) => value.includes(manual.note)),
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

	test("qwen3.8-flash context window follows the docs at 1M (1,048,576 tokens)", () => {
		const entry = byId.get("qwen3.8-flash");
		expect(entry).toBeDefined();
		expect(entry!.contextWindow).toBe(1_048_576);
		// The docs are the source of truth (maintainer instruction: docs win over
		// models.dev, which a user updates later). The docs state "1M token
		// context (1,048,576 tokens)" for this model, checked 2026-10-14;
		// models.dev still lists 262,144, so the override pins the documented
		// value until models.dev catches up.
		const note = MANUAL_OVERRIDES["qwen3.8-flash"]?.note;
		expect(note).toBeDefined();
		expect(note).toContain("1,048,576");
		expect(note).toContain("2026-10-14");
		expect(note).toContain("docs");
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

	test("glm5.3 is a general catalog model with its documented capabilities (no tier gating since 2026-11-10)", () => {
		// NaN announced on 2026-11-10 that there are no tier-exclusive models any
		// more, so glm5.3 left the premium live-only path and ships in the static
		// catalog with the values it carried there (NaN docs, checked 2026-10-14):
		// models.dev lists it text-only at 1,000,000 context, so the override pins
		// the docs values.
		const entry = byId.get("glm5.3");
		expect(entry).toBeDefined();
		expect(entry!.name).toBe("GLM 5.3");
		expect(entry!.contextWindow).toBe(1_048_576);
		expect(entry!.maxTokens).toBe(131_072);
		expect(entry!.input).toEqual(["text", "image"]);
		expect(entry!.reasoning).toBe(true);
		expect(entry!.reasoningEffortValues).toEqual(["low", "medium", "high", "max"]);
		expect(entry!.thinkingLevelMap).toEqual({ off: "low" });
		expect(
			GENERATED_CATALOG_META.notes.some((note) => note.startsWith("live-only:")),
			"no live-only exclusion is recorded any more",
		).toBe(false);
	});

	test("glm5.3-flash context window follows the docs at 1M (1,048,576 tokens)", () => {
		const entry = byId.get("glm5.3-flash");
		expect(entry).toBeDefined();
		expect(entry!.contextWindow).toBe(1_048_576);
		// The docs state "1M token context" (checked 2026-10-14); models.dev lists
		// the rounded 1,000,000, which the override corrects to the documented
		// window. The override also carries thinkingLevelMap (issue #16).
		expect(MANUAL_OVERRIDES["glm5.3-flash"]?.contextWindow).toBe(1_048_576);
		expect(MANUAL_OVERRIDES["glm5.3-flash"]?.thinkingLevelMap?.off).toBe("minimal");
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

	// Issue #16: thinkingLevelMap must be declared on models that need
	// reasoning suppression when pi maps reasoning:"off" → undefined.
	test("deepseek-v4-flash has thinkingLevelMap.off='none' (issue #16, measured 2026-09-27)", () => {
		const entry = byId.get("deepseek-v4-flash");
		expect(entry).toBeDefined();
		expect(entry!.thinkingLevelMap?.off).toBe("none");
		// The note must cite issue #16.
		expect(
			entry!.notes?.some((n) => n.includes("issue #16") || n.includes("#16")),
			"note must cite issue #16",
		).toBe(true);
	});

	test("glm5.3-flash has thinkingLevelMap.off='minimal' (issue #16, measured 2026-09-27)", () => {
		const entry = byId.get("glm5.3-flash");
		expect(entry).toBeDefined();
		expect(entry!.thinkingLevelMap?.off).toBe("minimal");
		// The note must cite issue #16.
		expect(
			entry!.notes?.some((n) => n.includes("issue #16") || n.includes("#16")),
			"note must cite issue #16",
		).toBe(true);
	});

	// Issue #16 gap: qwen3.6 and gemma4 reason by default (16,384-token budget)
	// when no reasoning_effort is sent, so `thinking: off` must map to `none`.
	for (const modelId of ["qwen3.6", "gemma4"]) {
		test(`${modelId} has thinkingLevelMap.off='none' (issue #16, NaN docs 2026-10-01)`, () => {
			const entry = byId.get(modelId);
			expect(entry).toBeDefined();
			expect(entry!.thinkingLevelMap?.off).toBe("none");
			expect(
				entry!.notes?.some((n) => n.includes("issue #16") || n.includes("#16")),
				`${modelId} note must cite issue #16`,
			).toBe(true);
		});
	}

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

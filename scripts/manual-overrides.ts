/**
 * MANUAL_OVERRIDES — build-time corrections applied over the models.dev data
 * by scripts/generate-models.ts before emitting scripts/models.generated.ts.
 *
 * models.dev lags behind gateway-side capability changes (context windows,
 * max output tokens, modalities). When a served value diverges from
 * models.dev, record it here instead of hand-editing the generated file.
 *
 * Provenance rules (mirrors AGENTS.md):
 * - `note` is REQUIRED and must state where the value was confirmed
 *   (URL and/or who confirmed it, plus the date) — and, when the override
 *   contradicts a public source, that source and its value, so the entry
 *   can be re-verified later.
 * - Never guess a number. If no confirmation source exists, leave the
 *   models.dev value in place.
 *
 * Fields override the models.dev-derived entry one-for-one:
 * name, reasoning, input, cost, contextWindow, maxTokens.
 */

export interface ManualModelOverride {
	/** Display name override. */
	name?: string;
	/** Reasoning support override. */
	reasoning?: boolean;
	/** pi-representable input modalities override. */
	input?: ("text" | "image")[];
	/** Per-token cost override (USD/Mtok; NaN is membership-quota based, so 0 unless confirmed otherwise). */
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** Context window override (tokens). */
	contextWindow?: number;
	/** Max output tokens override. */
	maxTokens?: number;
	/** Required provenance note; emitted verbatim onto the generated entry. */
	note: string;
}

export const MANUAL_OVERRIDES: Record<string, ManualModelOverride> = {
	"deepseek-v4-flash": {
		input: ["text", "image"],
		note: "input includes image: NaN serves the Vision-Exp variant (confirmed at https://nan.builders/docs/models, 'takes images as input'); models.dev provider nan lists text only.",
	},
	"qwen3.8-flash": {
		contextWindow: 1_000_000,
		note: "contextWindow 1,000,000: maintainer-confirmed against api.nan.builders (2026-09-05); both models.dev and https://nan.builders/docs/models still listed 262,144 ('262K token context, the model's native window') as of 2026-09-05 — re-verify against the gateway/docs when they update.",
	},
};

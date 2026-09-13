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
 *
 * An override may also act as a pin — a value models.dev already agrees with,
 * kept so an upstream regression cannot silently drop a confirmed capability.
 * A pin's note must say it is a pin; never present it as a divergence.
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
		note: "input includes image: NaN serves the Vision-Exp variant ('takes images as input', https://nan.builders/docs/models; the image_url content-parts in https://nan.builders/openapi.json list deepseek-v4-flash among the vision models). models.dev provider nan also lists text+image now (DeepSeek V4.1 Flash entry, checked 2026-09-13; its 2026-09-07 snapshot listed text only), so this override is kept as a pin for the vision capability rather than as a divergence.",
	},
};

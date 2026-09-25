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
	/** Reasoning effort values as declared by NaN docs. An empty array means the parameter is accepted but depth is model-managed (not adjustable by the user). */
	reasoningEffortValues?: string[];
	/** Required provenance note; emitted verbatim onto the generated entry. */
	note: string;
}

/**
 * Reasoning effort values sourced from the NaN docs (https://nan.builders/docs/models
 * #controlling-reasoning, checked 2026-09-25).
 *
 * models.dev has NO `reasoning_effort_values` field — only `reasoning_options`
 * (which is [{type:"toggle"}] or []), so this mapping must be hand-maintained
 * from the docs. The values flow through MANUAL_OVERRIDES.reasoningEffortValues
 * and appear in GeneratedModelEntry.reasoningEffortValues, where the pi
 * model-selector can read them to show the correct granularity.
 *
 * Per-model contract from the docs:
 * - glm5.3, glm5.3-flash: fully controllable (low/medium/high/max)
 * - qwen3.6, gemma4: none/minimal skip reasoning, others cap depth
 * - deepseek-v4-flash: any value accepted but model decides per-request
 * - qwen3.8-flash, mimo-v2.5, mimo-v2.6-flash: accepted, depth not adjustable
 *
 * A model with reasoning_effort_values=[] means the parameter is accepted but
 * the model manages its own reasoning depth — it is never an error.
 */
export const REASONING_EFFORT_VALUES: Record<string, string[]> = {
	"glm5.3": ["low", "medium", "high", "max"],
	"glm5.3-flash": ["low", "medium", "high", "max"],
	"qwen3.6": ["none", "minimal", "low", "medium", "high", "max"],
	"gemma4": ["none", "minimal", "low", "medium", "high", "max"],
};

/**
 * Models that NaN serves but models.dev provider nan hasn't listed yet.
 * Mirrors the generator's MANUAL_ONLY_MODEL_IDS — kept in sync so the
 * generator and the tests share the same source.
 */
export const MANUAL_ONLY_MODEL_IDS: Record<string, string> = {
	"mimo-v2.6-flash":
		"omnimodal model (text, image, audio input) served by NaN, not yet listed on models.dev provider nan (checked 2026-09-25); included so the live /models refresh does not hand it UNKNOWN_MODEL_LIMITS. Same limits as mimo-v2.5: 1,048,576 / 131,072 / 1.0B monthly quota per member. Reasoning: accepted, depth not adjustable. Tool calling: yes. Streaming: yes. Input modalities (pi-representable): text, image (audio not representable in pi's Model type).",
};

/**
 * Manual-only model entries with the full override shape for test assertions.
 * Mirrors MANUAL_ONLY_MODEL_IDS so the generator and the tests share the
 * same set of models.
 */
export const MANUAL_ONLY_MODELS: Record<string, ManualModelOverride> = {
	"mimo-v2.6-flash": {
		input: ["text", "image"],
		reasoning: true,
		reasoningEffortValues: [],
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		note: "omnimodal model (text, image, audio input) served by NaN, not yet listed on models.dev provider nan (checked 2026-09-25); included so the live /models refresh does not hand it UNKNOWN_MODEL_LIMITS. Same limits as mimo-v2.5: 1,048,576 / 131,072 / 1.0B monthly quota per member. Reasoning: accepted, depth not adjustable. Tool calling: yes. Streaming: yes. Input modalities (pi-representable): text, image (audio not representable in pi's Model type).",
	},
};

export const MANUAL_OVERRIDES: Record<string, ManualModelOverride> = {
	"deepseek-v4-flash": {
		input: ["text", "image"],
		// Any value accepted but model decides per-request (no effect).
		reasoningEffortValues: [],
		note: "input includes image: NaN serves the Vision-Exp variant ('takes images as input', https://nan.builders/docs/models; the image_url content-parts in https://nan.builders/openapi.json list deepseek-v4-flash among the vision models). models.dev provider nan also lists text+image now (DeepSeek V4.1 Flash entry, checked 2026-09-13; its 2026-09-07 snapshot listed text only), so this override is kept as a pin for the vision capability rather than as a divergence. reasoning_effort_values=[]: the model decides per-request how much to reason (https://nan.builders/docs/models, checked 2026-09-25).",
	},
};

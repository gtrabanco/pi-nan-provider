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
	/**
	 * Mapping from pi-ai's user-facing thinking levels to model-specific effort
	 * strings. Only the "off" key is needed to suppress runaway reasoning.
	 * When `reasoning: "off"` maps to undefined in pi-ai, thinkingLevelMap.off
	 * supplies the effort value that NaN understands (e.g. "none" or "minimal").
	 */
	thinkingLevelMap?: Partial<Record<string, string | null>>;
	/** Required provenance note; emitted verbatim onto the generated entry. */
	note: string;
}

/**
 * Manual reasoning effort values sourced from the NaN docs
 * (https://nan.builders/docs/models #controlling-reasoning, checked 2026-09-29).
 *
 * models.dev has NO `reasoning_effort_values` field — only `reasoning_options`
 * (which is [{type:"toggle"}] or []), so this mapping must be hand-maintained
 * from the docs. The values flow through MANUAL_OVERRIDES.reasoningEffortValues
 * and appear in GeneratedModelEntry.reasoningEffortValues, where the pi
 * model-selector can read them to show the correct granularity.
 *
 * Per-model contract from the docs:
 * - glm5.3, glm5.3-flash: fully controllable (low/medium/high/max)
 *   + minimal also accepted (issue #16, measured 2026-09-27): minimal
 *     yields 38 reasoning tokens vs 2,288 for high — the docs simply
 *     omitted it because it was not originally advertised, but it IS
 *     accepted and effective by the gateway.
 * - qwen3.6, gemma4: none/minimal skip reasoning, others cap depth
 * - deepseek-v4-flash: any value accepted but only "none" deterministically
 *   disables reasoning (issue #16, measured 2026-09-27); every other value
 *   (minimal/low/medium/high/omitted) leaves 13-14K reasoning tokens with
 *   runaway reasoning and finish_reason:"length" with ZERO answer. Since only
 *   "none" has a measurable effect, the catalog declares ["none"].
 * - qwen3.8-flash, mimo-v2.6-flash: accepted, depth not adjustable
 *
 * (mimo-v2.5, which used to share that last row, was removed by NaN — absent
 * from the docs and from openapi.json, checked 2026-09-29.)
 *
 * A model with reasoning_effort_values=[] means the parameter is accepted but
 * the model manages its own reasoning depth — it is never an error.
 */
export const REASONING_EFFORT_VALUES: Record<string, string[]> = {
	"glm5.3": ["low", "medium", "high", "max"],
	"glm5.3-flash": ["minimal", "low", "medium", "high", "max"],
	"qwen3.6": ["none", "minimal", "low", "medium", "high", "max"],
	"gemma4": ["none", "minimal", "low", "medium", "high", "max"],
};

/**
 * Provenance for the manual-only mimo-v2.6-flash entry, shared by
 * MANUAL_ONLY_MODEL_IDS (generator) and MANUAL_ONLY_MODELS (tests) so both
 * sides assert the exact same string.
 */
const MANUAL_ONLY_NOTE =
	"omnimodal model (text, image, audio input) served by NaN; limits and modalities from https://nan.builders/docs/models#mimo-v2-6-flash (checked 2026-09-25, quotas re-checked 2026-09-29): 1,048,576 context / 131,072 max output / 1.0B monthly quota per member. Reasoning: accepted, depth not adjustable (docs table, checked 2026-09-29). Tool calling: yes. Streaming: yes. Input modalities (pi-representable): text, image (audio not representable in pi's Model type). Fallback entry: emitted only while models.dev provider nan does not list the model — models.dev started listing it on 2026-09-29, so the generator then keeps the models.dev values and attaches this note to that entry instead of emitting a second one.";

/**
 * Models NaN serves that models.dev provider nan may not list. Mirrors the
 * generator's MANUAL_ONLY_MODEL_IDS — kept in sync so the generator and the
 * tests share the same source. An entry stops being emitted as soon as
 * models.dev lists the model; the note above then rides on the models.dev
 * entry, so the manual data never vanishes silently.
 */
export const MANUAL_ONLY_MODEL_IDS: Record<string, string> = {
	"mimo-v2.6-flash": MANUAL_ONLY_NOTE,
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
		note: MANUAL_ONLY_NOTE,
	},
};

/**
 * Manual overrides keyed by model id. Fields override the models.dev-derived
 * entry one-for-one. Every override carries a provenance note.
 *
 * Issue #16 (measured 2026-09-27 against live gateway, repro included):
 * - deepseek-v4-flash: reasoning_effort_values=["none"] (only "none" suppresses);
 *   thinkingLevelMap={off:"none"} (supplies reasoning_effort when pi maps
 *   reasoning:"off" → undefined).
 * - glm5.3-flash: reasoningEffortValues includes "minimal" (not documented but
 *   effective); thinkingLevelMap={off:"minimal"} (supplies reasoning_effort
 *   when pi maps reasoning:"off" → undefined).
 * - qwen3.6, gemma4: the NaN docs already document `none` as "skip the
 *   reasoning phase entirely" and state that with no parameter the model
 *   defaults to reasoning ON (16,384-token budget), so off must send
 *   `none` explicitly — thinkingLevelMap={off:"none"} (NaN docs
 *   #controlling-reasoning, checked 2026-10-01). No measurement needed: the
 *   docs are explicit about both the default and the `none` behavior.
 */
export const MANUAL_OVERRIDES: Record<string, ManualModelOverride> = {
	"deepseek-v4-flash": {
		input: ["text", "image"],
		maxTokens: 32_768,
		reasoningEffortValues: ["none"],
		thinkingLevelMap: { off: "none" },
		note:
			"input includes image: NaN serves the Vision-Exp variant ('takes images as input', https://nan.builders/docs/models; the image_url content-parts in https://nan.builders/openapi.json list deepseek-v4-flash among the vision models). models.dev provider nan also lists text+image now (DeepSeek V4.1 Flash entry, checked 2026-09-13; its 2026-09-07 snapshot listed text only), so this override is kept as a pin for the vision capability rather than as a divergence. " +
			"maxTokens 32768 per the official NaN pi docs (https://nan.builders/docs/pi, 'the same set the NaN CLI writes', checked 2026-10-02) closing issue #20 — the gateway now rejects max_tokens above ~256k for this model with 403 permission_error (measured 2026-10-02: 256,000 → 200; 262,143 → 403), and the previous models.dev-derived 384000 made every pi request fail since pi-ai sends max_tokens = model.maxTokens when no cap is set. models.dev still lists 384000, so this override pins the documented value. " +
			"reasoning_effort_values=[\"none\"] (issue #16, measured 2026-09-27 against live gateway, repro included in the issue): only \"none\" deterministically disables reasoning (0 reasoning tokens, answer produced). Every other value leaves 13-14K reasoning tokens and causes runaway reasoning (finish_reason:\"length\" with ZERO answer text). The catalog declares only [\"none\"] because the remaining values are useless noise. " +
			"thinkingLevelMap { off: \"none\" } (issue #16, measured 2026-09-27): when pi maps reasoning:\"off\" to reasoningEffort:undefined, the thinkingLevelMap.off=\"none\" supplies the effort so the gateway receives reasoning_effort:\"none\" and does NOT enter runaway reasoning mode.",
	},
	"glm5.3-flash": {
		thinkingLevelMap: { off: "minimal" },
		note:
			"thinkingLevelMap { off: \"minimal\" } (issue #16, measured 2026-09-27 against live gateway, repro included in the issue): when pi maps reasoning:\"off\" to reasoningEffort:undefined, the thinkingLevelMap.off=\"minimal\" supplies the effort so the gateway receives reasoning_effort:\"minimal\" (38 reasoning tokens + answer). Note: \"none\" does NOT suppress reasoning on glm5.3-flash (13,382 tokens) — only \"minimal\" was measured to be effective. " +
			"reasoning_effort_values includes \"minimal\" (not documented by NaN docs but accepted and effective by the gateway, issue #16).",
	},
	"qwen3.6": {
		thinkingLevelMap: { off: "none" },
		note:
			"thinkingLevelMap { off: \"none\" } (issue #16): NaN docs state that with no reasoning_effort parameter every model uses its own default and that default is reasoning ON for qwen3.6 (16,384-token budget), while `none` and `minimal` skip the reasoning phase entirely (https://nan.builders/docs/models#controlling-reasoning, checked 2026-10-01). pi maps reasoning:\"off\" to reasoningEffort:undefined, so without this map `thinking: off` sent no parameter and the model reasoned anyway; the map sends reasoning_effort:\"none\" and actually disables reasoning.",
	},
	"gemma4": {
		thinkingLevelMap: { off: "none" },
		note:
			"thinkingLevelMap { off: \"none\" } (issue #16): NaN docs state that with no reasoning_effort parameter gemma4 defaults to reasoning ON (16,384-token budget), while `none`/`minimal` skip reasoning entirely (https://nan.builders/docs/models#controlling-reasoning, checked 2026-10-01). pi maps reasoning:\"off\" to reasoningEffort:undefined, so without this map `thinking: off` sent no parameter and the model reasoned anyway; the map sends reasoning_effort:\"none\" and actually disables reasoning.",
	},
};

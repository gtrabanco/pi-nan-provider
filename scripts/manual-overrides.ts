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
 * Per-model contract from the docs, corrected by live measurement where the
 * two disagree (maintainer instruction: the measurement wins over the docs):
 * - glm5.3, glm5.3-flash: fully controllable (low/medium/high/max)
 *   + minimal also accepted (issue #16, measured 2026-09-27): minimal
 *     yields 38 reasoning tokens vs 2,288 for high — the docs simply
 *     omitted it because it was not originally advertised, but it IS
 *     accepted and effective by the gateway.
 * - qwen3.6, gemma4: none/minimal skip reasoning, others cap depth
 *   (2,048 / 8,192 / 16,384 / 32,768).
 * - deepseek-v4-flash: `none` reproducibly disables reasoning (0 reasoning
 *   tokens, full answer); every other value — `minimal`, `low`, `high` and
 *   omitting the parameter — leaves it ON (issue #16, 2026-09-27,
 *   re-confirmed live 2026-10-14: none 0 / low 57 / omitted 63 reasoning
 *   tokens). The docs say "any value (no effect)"; the measurement wins, so
 *   the catalog declares only ["none"].
 * - mimo-v2.6-flash: the docs list it as "accepted, depth not adjustable",
 *   but the live re-probe (2026-10-14) shows `none` → 0 reasoning tokens
 *   while `low` → 22 and omission → 17. Adjustable at the off end, so it
 *   carries `thinkingLevelMap { off: "none" }`.
 * - qwen3.8-flash: the docs say "accepted, depth not adjustable"; the live
 *   probe measured 0 reasoning tokens for `none` (2026-10-14) but no other
 *   value was sampled, so no `thinkingLevelMap` is declared — the docs state
 *   its default is reasoning ON, so `off` sends nothing and the model decides.
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
	"omnimodal model (text, image, audio input) served by NaN; limits and modalities from https://nan.builders/docs/models#mimo-v2-6-flash (checked 2026-09-25, quotas re-checked 2026-09-29): 1,048,576 context / 131,072 max output / 1.0B monthly quota per member. Tool calling: yes. Streaming: yes. Input modalities (pi-representable): text, image (audio not representable in pi's Model type). Fallback entry: emitted only while models.dev provider nan does not list the model — models.dev started listing it on 2026-09-29, so the generator then keeps the models.dev values and attaches this note to that entry instead of emitting a second one.";

/**
 * NaN external-provider models launched 2026-11-10 (ZDR, served through
 * external providers). models.dev provider nan does not list them, the NaN
 * docs/openapi do not mention them yet, but the live `GET /v1/models` does
 * (checked 2026-11-10, a non-premium key sees all four). Values per spec S2 of
 * odd/tasks/nan-external-models-2026-11.md; nothing here is a guess:
 * - contextWindow: NaN's pricing page card says "1M context" for each model
 *   (maintainer screenshot, 2026-11-10); NaN's convention for 1M is 1,048,576
 *   (https://nan.builders/docs/pi). qwen3.8-max uses the first-party vendor value
 *   1,000,000 (models.dev provider alibaba), the smaller of the two.
 * - maxTokens 32,768: https://nan.builders/docs/pi declares maxTokens 32768 for
 *   every 1M-context NaN model; every vendor limit is >= 65,536 (models.dev
 *   moonshotai / alibaba / deepseek / tencent-tokenhub), and NaN's gateway
 *   already rejected a high max_tokens once (issue #20).
 * - input: first-party vendor modalities on models.dev (moonshotai/kimi-k3.1-pro,
 *   alibaba/qwen3.8-max, deepseek/deepseek-v4-pro, tencent-tokenhub/hy4)
 *   restricted to pi's text/image.
 * - reasoning true: all four are reasoning models per their vendors.
 *   reasoningEffortValues [] and NO thinkingLevelMap: how NaN's gateway
 *   translates reasoning_effort for external providers is unmeasured.
 * - cost 0: maintainer decision (NaN is quota/credit based).
 */
const EXTERNAL_MODEL_NOTE_SUFFIX =
	" Existence: live GET https://api.nan.builders/v1/models (checked 2026-11-10); the docs https://nan.builders/docs/models, https://nan.builders/docs/pi and https://nan.builders/openapi.json do not list it yet. reasoningEffortValues [] and no thinkingLevelMap: the gateway's reasoning_effort handling for external providers is unmeasured. cost 0 per maintainer decision.";

const EXTERNAL_MODELS: Record<string, ManualModelOverride> = {
	"kimi-k3.1-pro": {
		name: "Kimi K3.1 Pro",
		input: ["text", "image"],
		reasoning: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 32_768,
		reasoningEffortValues: [],
		note:
			"NaN external-provider model launched 2026-11-10. contextWindow 1,048,576: NaN pricing page card '1M context' (maintainer screenshot, 2026-11-10) with NaN's 1M = 1,048,576 convention (https://nan.builders/docs/pi). maxTokens 32,768: https://nan.builders/docs/pi declares 32768 for every 1M-context NaN model (vendor limit 1,048,576 on models.dev provider moonshotai). input text+image per models.dev provider moonshotai (kimi-k3.1-pro), reasoning model per the vendor." +
			EXTERNAL_MODEL_NOTE_SUFFIX,
	},
	"qwen3.8-max": {
		name: "Qwen3.8 Max",
		input: ["text", "image"],
		reasoning: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 32_768,
		reasoningEffortValues: [],
		note:
			"NaN external-provider model launched 2026-11-10. contextWindow 1,000,000: NaN pricing page card says '1M context' (maintainer screenshot, 2026-11-10); the first-party vendor value on models.dev provider alibaba (qwen3.8-max) is 1,000,000, the smaller of it and NaN's 1M = 1,048,576 convention (https://nan.builders/docs/pi), so the vendor value is used. maxTokens 32,768: https://nan.builders/docs/pi declares 32768 for every 1M-context NaN model (vendor limit 131,072 on models.dev provider alibaba). input text+image per models.dev provider alibaba (qwen3.8-max), reasoning model per the vendor." +
			EXTERNAL_MODEL_NOTE_SUFFIX,
	},
	"deepseek-v4-pro": {
		name: "DeepSeek V4-Pro (0813 version)",
		input: ["text"],
		reasoning: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 32_768,
		reasoningEffortValues: [],
		note:
			"NaN external-provider model launched 2026-11-10 (NaN pricing page name 'DeepSeek V4-Pro (0813 version)'). contextWindow 1,048,576: NaN pricing page card '1M context' (maintainer screenshot, 2026-11-10) with NaN's 1M = 1,048,576 convention (https://nan.builders/docs/pi). maxTokens 32,768: https://nan.builders/docs/pi declares 32768 for every 1M-context NaN model (vendor limit 393,216 on models.dev provider deepseek). input text only per models.dev provider deepseek (deepseek-v4-pro), reasoning model per the vendor." +
			EXTERNAL_MODEL_NOTE_SUFFIX,
	},
	hy4: {
		name: "Hy4",
		input: ["text", "image"],
		reasoning: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 32_768,
		reasoningEffortValues: [],
		note:
			"NaN external-provider model launched 2026-11-10. contextWindow 1,048,576: NaN pricing page card '1M context' (maintainer screenshot, 2026-11-10) with NaN's 1M = 1,048,576 convention (https://nan.builders/docs/pi). maxTokens 32,768: https://nan.builders/docs/pi declares 32768 for every 1M-context NaN model (vendor limit 65,536 on models.dev provider tencent-tokenhub). input text+image per models.dev provider tencent-tokenhub (hy4), reasoning model per the vendor." +
			EXTERNAL_MODEL_NOTE_SUFFIX,
	},
};

const EXTERNAL_MODEL_DETAIL =
	"NaN external-provider model launched 2026-11-10, listed by the live GET /v1/models but absent from models.dev provider nan and the NaN docs";

/**
 * Models NaN serves that models.dev provider nan may not list. Mirrors the
 * generator's MANUAL_ONLY_MODEL_IDS — kept in sync so the generator and the
 * tests share the same source. An entry stops being emitted as soon as
 * models.dev lists the model; the note above then rides on the models.dev
 * entry, so the manual data never vanishes silently.
 */
export const MANUAL_ONLY_MODEL_IDS: Record<string, string> = {
	"mimo-v2.6-flash": MANUAL_ONLY_NOTE,
	...Object.fromEntries(Object.keys(EXTERNAL_MODELS).map((id) => [id, EXTERNAL_MODEL_DETAIL])),
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
	...EXTERNAL_MODELS,
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
	...EXTERNAL_MODELS,
	"glm5.3": {
		name: "GLM 5.3",
		input: ["text", "image"],
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		reasoningEffortValues: ["low", "medium", "high", "max"],
		thinkingLevelMap: { off: "low" },
		note:
			"general catalog model since 2026-11-10: NaN announced it no longer has tier-exclusive models ('a partir de ahora ya NO habrá modelos exclusivos por tier'), and the live GET https://api.nan.builders/v1/models lists glm5.3 for a non-premium key (checked 2026-11-10); it used to be premium live-only. The values are the ones it carried as live-only, from https://nan.builders/docs/models (checked 2026-10-14; docs win over models.dev): contextWindow 1,048,576 ('1M token context'; models.dev lists the rounded 1,000,000); input text+image (multimodal; pi represents only text and image — models.dev lists text only, a stale divergence); maxTokens 131,072 (the confirmed maximum models.dev documents; the docs give the same 131K figure for glm5.3-flash and no lower bound); reasoningEffortValues low/medium/high/max per the docs' effort list; name 'GLM 5.3' per the docs (models.dev says 'GLM-5.3'). thinkingLevelMap { off: \"low\" }: the docs list low as the shallowest level, so `thinking: off` sends the shallowest supported effort; glm5.3 itself was never measured (issue #16 covered glm5.3-flash, whose shallowest effective value is 'minimal'), 'low' is the documented floor.",
	},
	"qwen3.8-flash": {
		contextWindow: 1_048_576,
		note:
			"contextWindow 1,048,576: NaN docs state '1M token context (1,048,576 tokens)' and 'Max answer 131K tokens' (https://nan.builders/docs/models, checked 2026-10-14) — models.dev still lists 262,144. The earlier override was withdrawn 2026-09-07 when the docs read '262K token context, the model's native window'; the docs now state 1M and they are the source of truth (maintainer instruction: docs win over models.dev, which a user updates later). maxTokens stays 131,072, which models.dev already matches and the docs confirm as the 131K max answer.",
	},
	"deepseek-v4-flash": {
		input: ["text", "image"],
		contextWindow: 1_048_576,
		maxTokens: 32_768,
		reasoningEffortValues: ["none"],
		thinkingLevelMap: { off: "none" },
		note:
			"contextWindow 1,048,576: NaN docs state '1M token context' for this model (https://nan.builders/docs/models, checked 2026-10-14). models.dev lists 1,000,000, a rounded form of the same window; the docs value is authoritative (maintainer instruction: docs win over models.dev, which a user updates later). " +
			"input includes image: NaN serves the Vision-Exp variant ('takes images as input', https://nan.builders/docs/models; the image_url content-parts in https://nan.builders/openapi.json list deepseek-v4-flash among the vision models). models.dev provider nan also lists text+image now (DeepSeek V4.1 Flash entry, checked 2026-09-13), so this stays a pin for the vision capability rather than a divergence. " +
			"maxTokens 32768 per the official NaN pi docs (https://nan.builders/docs/pi, 'the same set the NaN CLI writes', checked 2026-10-02) closing issue #20 — the gateway now rejects max_tokens above ~256k for this model with 403 permission_error (measured 2026-10-02: 256,000 → 200; 262,143 → 403), and the previous models.dev-derived 384000 made every pi request fail since pi-ai sends max_tokens = model.maxTokens when no cap is set. models.dev still lists 384000, so this override pins the documented value. " +
			"reasoning_effort_values=[\"none\"] (issue #16, measured 2026-09-27 against live gateway, repro included in the issue): only \"none\" deterministically disables reasoning (0 reasoning tokens, answer produced). Every other value leaves 13-14K reasoning tokens and causes runaway reasoning (finish_reason:\"length\" with ZERO answer text). The catalog declares only [\"none\"] because the remaining values are useless noise. " +
			"docs vs measurement (re-probed live 2026-10-14): https://nan.builders/docs/models#controlling-reasoning documents the parameter as 'any value (no effect) — the model decides per request', but the live gateway contradicts that: `none` gave 0 reasoning tokens / 0 reasoning chars / a 134-char answer, while `low` gave 57 reasoning tokens and omitting the parameter gave 63 (`minimal` gave 109). The docs are stale here; the measurement wins (maintainer instruction), so the measured behavior is kept. " +
			"thinkingLevelMap { off: \"none\" } (issue #16, measured 2026-09-27): when pi maps reasoning:\"off\" to reasoningEffort:undefined, the thinkingLevelMap.off=\"none\" supplies the effort so the gateway receives reasoning_effort:\"none\" and does NOT enter runaway reasoning mode.",
	},
	"glm5.3-flash": {
		contextWindow: 1_048_576,
		thinkingLevelMap: { off: "minimal" },
		note:
			"contextWindow 1,048,576: NaN docs state '1M token context' for this model (https://nan.builders/docs/models, checked 2026-10-14). models.dev lists 1,000,000, a rounded form of the same window; the docs value is authoritative (maintainer instruction: docs win over models.dev, which a user updates later). " +
			"thinkingLevelMap { off: \"minimal\" } (issue #16, measured 2026-09-27 against live gateway, repro included in the issue): when pi maps reasoning:\"off\" to reasoningEffort:undefined, the thinkingLevelMap.off=\"minimal\" supplies the effort so the gateway receives reasoning_effort:\"minimal\" (38 reasoning tokens + answer). Note: \"none\" does NOT suppress reasoning on glm5.3-flash (13,382 tokens) — only \"minimal\" was measured to be effective. " +
			"reasoning_effort_values includes \"minimal\" (the docs' glm row lists low/medium/high/max, but the 2026-09-27 measurement shows minimal is accepted and effective, issue #16).",
	},
	"mimo-v2.6-flash": {
		thinkingLevelMap: { off: "none" },
		note:
			"thinkingLevelMap { off: \"none\" } (live re-probe 2026-10-14): the docs list this model as 'accepted, depth not adjustable', but the gateway makes the parameter effective at the off end — `none` gave 0 reasoning tokens / a full answer, while `low` gave 22 reasoning tokens and omitting the parameter gave 17. Measured behavior wins over the docs, so `thinking: off` now sends reasoning_effort:\"none\" and actually disables reasoning. No other level was sampled, so only `off` is mapped.",
	},
	"qwen3.6": {
		thinkingLevelMap: { off: "none" },		note:
			"thinkingLevelMap { off: \"none\" } (issue #16): NaN docs state that with no reasoning_effort parameter every model uses its own default and that default is reasoning ON for qwen3.6 (16,384-token budget), while `none` and `minimal` skip the reasoning phase entirely (https://nan.builders/docs/models#controlling-reasoning, checked 2026-10-01). pi maps reasoning:\"off\" to reasoningEffort:undefined, so without this map `thinking: off` sent no parameter and the model reasoned anyway; the map sends reasoning_effort:\"none\" and actually disables reasoning.",
	},
	"gemma4": {
		thinkingLevelMap: { off: "none" },
		note:
			"thinkingLevelMap { off: \"none\" } (issue #16): NaN docs state that with no reasoning_effort parameter gemma4 defaults to reasoning ON (16,384-token budget), while `none`/`minimal` skip reasoning entirely (https://nan.builders/docs/models#controlling-reasoning, checked 2026-10-01). pi maps reasoning:\"off\" to reasoningEffort:undefined, so without this map `thinking: off` sent no parameter and the model reasoned anyway; the map sends reasoning_effort:\"none\" and actually disables reasoning.",
	},
};

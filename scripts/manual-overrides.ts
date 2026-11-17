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
 * name, reasoning, input, cost, contextWindow, maxTokens, reasoningEffortValues,
 * thinkingLevelMap. `maxTokensField` is the exception: it lands on the entry's
 * `compat` (see the field docs below).
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
	/**
	 * Compat max-tokens request field override, applied over NAN_COMPAT.
	 * The default for every NaN model is the classic `max_tokens` field
	 * (LiteLLM-confirmed); a model where `max_tokens` does not bound the
	 * reasoning phase sends `max_completion_tokens` instead. The strict-schema
	 * sanitizer renames `max_completion_tokens` back to `max_tokens` by default
	 * (NaN's published OpenAPI schema only documents `max_tokens`), so a model
	 * carrying `"max_completion_tokens"` here is also exempted from that rename
	 * at request time (SanitizerOptions.preserveMaxCompletionTokens, wired from
	 * the model's effective compat in src/provider-factory.ts).
	 */
	maxTokensField?: "max_tokens" | "max_completion_tokens";
	/** Required provenance note; emitted verbatim onto the generated entry. */
	note: string;
}

/**
 * Reasoning effort values are NOT a separate table: every model declares its own
 * `reasoningEffortValues` (and `thinkingLevelMap`) inside MANUAL_OVERRIDES below,
 * next to the provenance note that justifies the list. models.dev exposes no
 * `reasoning_effort_values` field — only `reasoning_options` — so these lists
 * are hand-maintained from https://nan.builders/docs/models#controlling-reasoning.
 *
 * One source only: `scripts/generate-models.ts` reads them from the override and
 * has no fallback map of its own.
 *
 * A model with `reasoningEffortValues: []` accepts the parameter but manages its
 * own reasoning depth — it is never an error to send a value. `thinkingLevelMap.off`
 * is the load-bearing field: pi maps `reasoning: "off"` to `reasoningEffort:
 * undefined`, and pi-ai only emits `reasoning_effort` when that map supplies a
 * value. The effort list itself is catalog documentation (pi and pi-ai do not
 * read it; checked against pi-ai/pi 1.5.1).
 *
 * `xhigh` and `max` need an entry of their own. pi-ai treats both as OPT-IN:
 * `getSupportedThinkingLevels()` only lists them when the map carries a non-null
 * entry (pi-ai 1.5.1 `dist/models.js`, and its README: "`xhigh` and `max` are
 * opt-in and require a non-null map entry"). Without it pi clamps a requested
 * `max` down to `high` and the gateway never sees it, even though NaN accepts it.
 * So every model whose docs declare a ladder up to `max` carries the identity
 * entries `{ xhigh: "xhigh", max: "max" }`: the strings are what pi-ai would
 * send anyway, so the map only widens what pi offers. Models whose docs document
 * nothing but `none` plus a default (`hy4`, `hy4-flash`, `qwen3.8-max`) and the
 * two outside the reasoning contract (`kimi-k3.1-pro`, `deepseek-v4-pro`) keep
 * `off` alone and stay at `off`…`high`.
 */

/**
 * Provenance for the manual-only mimo-v2.6-flash entry, shared by
 * MANUAL_ONLY_MODEL_IDS (generator) and MANUAL_ONLY_MODELS (tests) so both
 * sides assert the exact same string.
 */
const MANUAL_ONLY_NOTE =
	"omnimodal model (text, image, audio input) served by NaN; limits and modalities from https://nan.builders/docs/models#mimo-v2-6-flash (checked 2026-09-25, quotas re-checked 2026-09-29): 1,048,576 context / 131,072 max output / 1.0B monthly quota per member. Tool calling: yes. Streaming: yes. Input modalities (pi-representable): text, image (audio not representable in pi's Model type). Fallback entry: emitted only while models.dev provider nan does not list the model — models.dev started listing it on 2026-09-29, so the generator then keeps the models.dev values and attaches this note to that entry instead of emitting a second one.";

/**
 * NaN's larger models (the NaN docs' own label). Four of them entered the
 * catalog on 2026-11-10 as "external, undocumented" — ZDR models served
 * through external providers — and `qwen4-max`/`hy4-flash` are newer still.
 *
 * https://nan.builders/docs/models now documents every one of them (checked
 * 2026-11-17): context, "Max answer", input modalities and reasoning behaviour.
 * models.dev provider `nan` lists the four from 2026-11-10 but neither
 * `qwen4-max` nor `hy4-flash`, so the whole block keeps its entries: they are
 * what makes these values survive a models.dev refresh, and the manual-only
 * detail keeps the two undocumented ids in the catalog even though models.dev
 * has no row for them at all.
 *
 * Values and their sources (docs win; models.dev first-party vendor entries
 * only break ties the docs leave open — the 1M = 1,048,576 vs 1,000,000 one):
 * - qwen4-max: 1M context (vendor 1,000,000), "Max answer 131K", text+image,
 *   `reasoning_effort` none…max with `none` off, `max_tokens` bounds the total.
 * - hy4-flash: 1M context, "Max answer 64K", text+image, reasons by default with
 *   no default level, `none` turns it off, `max_tokens` bounds the total.
 * - hy4: 1M context, "Max answer 64K", text+image, default level `low`,
 *   aliases mapped.
 * - qwen3.8-max: 1M context (vendor 1,000,000), "Max answer 131K", text+image,
 *   `none` off, and `max_completion_tokens` caps the total while `max_tokens`
 *   bounds only the visible answer (issue #34's quota failure mode).
 * - kimi-k3.1-pro: 1M context, "Max answer 1M", text+image, reasoning model
 *   with no documented level contract and aliases NOT mapped.
 * - deepseek-v4-pro: 1M context, "Max answer 393K", text only, same caveat.
 * - cost 0: maintainer decision (NaN bills credits, not per-token USD).
 */
const LARGER_MODEL_NOTE_SUFFIX =
	" Cost 0 per maintainer decision (NaN bills credits, not per-token USD).";

const LARGER_MODELS: Record<string, ManualModelOverride> = {
	"qwen4-max": {
		name: "Qwen4 Max",
		input: ["text", "image"],
		reasoning: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		reasoningEffortValues: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
		thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
		note:
			"Qwen4 Max, Alibaba's Qwen 4 flagship, documented in https://nan.builders/docs/models (checked 2026-11-17) and listed by the live GET https://api.nan.builders/v1/models (checked 2026-11-17); models.dev provider nan does not list it, so it enters as a manual-only entry. contextWindow 1,000,000: the card says '1M token context' and both first-party vendor entries on models.dev (vercel/alibaba/qwen4-max and openrouter/qwen/qwen4-max) say 1,000,000 — the smaller of that and NaN's 1M = 1,048,576 convention (https://nan.builders/docs/pi), the same rule qwen3.8-max follows. maxTokens 131,072: the card says 'Max answer 131K tokens' and the reasoning section says 'max_tokens bounds the total, reasoning plus answer, up to 131,000'. input text+image and reasoning true per the card. Reasoning: the card says 'reasoning_effort: none turns it off · minimal to max', and the reasoning section repeats that none turns it off on this model, so reasoningEffortValues declares the documented ladder and thinkingLevelMap { off: 'none' } supplies the off switch when pi maps reasoning:'off' to undefined." +
			LARGER_MODEL_NOTE_SUFFIX,
	},
	"hy4-flash": {
		name: "Hy4 Flash",
		input: ["text", "image"],
		reasoning: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		reasoningEffortValues: ["none"],
		thinkingLevelMap: { off: "none" },
		note:
			"Hy4 Flash, Tencent's fast Hunyuan 4, documented in https://nan.builders/docs/models (checked 2026-11-17) and listed by the live GET https://api.nan.builders/v1/models (checked 2026-11-17); models.dev provider nan does not list it, so it enters as a manual-only entry. contextWindow 1,048,576: the card says '1M token context' and NaN's 1M convention is 1,048,576 (https://nan.builders/docs/pi), which the first-party models.dev entry openrouter/tencent/hy4-flash also reports. maxTokens 65,536: the card says 'Max answer 64K tokens' (64K = 65,536), and its reasoning section says 'max_tokens bounds reasoning plus answer, up to 64,000', so the classic max_tokens field stays. input text+image and reasoning true per the card ('Tool calling and reasoning'). The docs keep this model out of the effort table ('Reasons by default, with no default level applied ... To turn reasoning off send reasoning_effort: none; the model ignores enable_thinking on its own'), so reasoningEffortValues declares only the documented off value and thinkingLevelMap { off: 'none' } puts it on the wire." +
			LARGER_MODEL_NOTE_SUFFIX,
	},
	"kimi-k3.1-pro": {
		name: "Kimi K3.1 Pro",
		input: ["text", "image"],
		reasoning: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 1_048_576,
		reasoningEffortValues: [],
		note:
			"Kimi K3.1 Pro, documented in https://nan.builders/docs/models (checked 2026-11-17; models.dev provider nan lists it since 2026-11-10). contextWindow 1,048,576 ('1M token context') and maxTokens 1,048,576 ('Max answer 1M tokens', which models.dev nan reports as limit.output) — pi-ai clamps the outgoing budget with clampMaxTokensToContext, so declaring the documented maximum never sends an over-context max_tokens. input text+image per the card. Reasoning: the card only says 'Reasoning model', and the docs keep this model out of the effort contract while stating that the `none` aliases are NOT mapped on it, so no reasoningEffortValues and no thinkingLevelMap are declared: pi sends no reasoning_effort and the model's own behaviour decides." +
			LARGER_MODEL_NOTE_SUFFIX,
	},
	"qwen3.8-max": {
		name: "Qwen3.8 Max",
		input: ["text", "image"],
		reasoning: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		maxTokensField: "max_completion_tokens",
		reasoningEffortValues: ["none"],
		thinkingLevelMap: { off: "none" },
		note:
			"Qwen3.8 Max, documented in https://nan.builders/docs/models (checked 2026-11-17; models.dev provider nan lists it since 2026-11-10). contextWindow 1,000,000: the card says '1M token context' and the first-party vendor value on models.dev provider alibaba (qwen3.8-max) is 1,000,000 — the smaller of that and NaN's 1M = 1,048,576 convention (https://nan.builders/docs/pi). maxTokens 131,072: the card says 'Max answer 131K tokens'. maxTokensField 'max_completion_tokens': the docs state that on this model 'max_tokens only bounds the visible answer: the reasoning comes on top of it. To cap the total (reasoning plus answer, and so the cost) use max_completion_tokens' — the quota blowout issue #34 fixed for qwen3.8-flash, same fix, same sanitizer exemption (SanitizerOptions.preserveMaxCompletionTokens, wired from compat.maxTokensField in src/provider-factory.ts). input text+image per the card. Reasoning: the docs say 'none turns it off' for this model, so reasoningEffortValues declares 'none' and thinkingLevelMap { off: 'none' } sends it when pi maps reasoning:'off' to undefined." +
			LARGER_MODEL_NOTE_SUFFIX,
	},
	"deepseek-v4-pro": {
		name: "DeepSeek V4-Pro (0813 version)",
		input: ["text"],
		reasoning: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 393_216,
		reasoningEffortValues: [],
		note:
			"DeepSeek V4-Pro (0813 version), documented in https://nan.builders/docs/models (checked 2026-11-17; models.dev provider nan lists it since 2026-11-10). contextWindow 1,048,576 ('1M token context'). maxTokens 393,216: the card says 'Max answer 393K tokens', the same 393,216 the docs clamp deepseek-v4-flash to; models.dev nan reports 384,000, so the docs value wins (maintainer instruction: docs are the source of truth). input text only per the card ('text generation & chat · reasoning'). Reasoning: the card only says 'Reasoning model', and the docs state the `none` aliases are NOT mapped on this model, so no reasoningEffortValues and no thinkingLevelMap are declared." +
			LARGER_MODEL_NOTE_SUFFIX,
	},
	hy4: {
		name: "Hy4",
		input: ["text", "image"],
		reasoning: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		reasoningEffortValues: ["none"],
		thinkingLevelMap: { off: "none" },
		note:
			"Hy4, Tencent's Hunyuan 4, documented in https://nan.builders/docs/models (checked 2026-11-17; models.dev provider nan lists it since 2026-11-10). contextWindow 1,048,576 ('1M token context'). maxTokens 65,536: the card says 'Max answer 64K tokens' and models.dev provider nan reports the same 65,536, so it is no longer the flat 32,768 default. input text+image, reasoning true. Reasoning: the card says 'Reasons by default; if you send no reasoning_effort (nor an alias) we apply low, and your own value always wins', and the aliases ARE mapped on this model, so thinkingLevelMap { off: 'none' } supplies the documented off switch ('To turn reasoning off, send none ... it works on every model except GLM'). No other level is documented for it, so reasoningEffortValues declares only 'none'." +
			LARGER_MODEL_NOTE_SUFFIX,
	},
};

const LARGER_MODEL_DETAIL =
	"NaN larger model documented in https://nan.builders/docs/models (checked 2026-11-17) and listed by the live GET https://api.nan.builders/v1/models (checked 2026-11-17), but absent from models.dev provider nan";

/**
 * Models NaN serves that models.dev provider nan may not list. Mirrors the
 * generator's MANUAL_ONLY_MODEL_IDS — kept in sync so the generator and the
 * tests share the same source. An entry stops being emitted as soon as
 * models.dev lists the model; the note above then rides on the models.dev
 * entry, so the manual data never vanishes silently.
 */
export const MANUAL_ONLY_MODEL_IDS: Record<string, string> = {
	"mimo-v2.6-flash": MANUAL_ONLY_NOTE,
	...Object.fromEntries(Object.keys(LARGER_MODELS).map((id) => [id, LARGER_MODEL_DETAIL])),
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
	...LARGER_MODELS,
};

/**
 * Manual overrides keyed by model id. Fields override the models.dev-derived
 * entry one-for-one. Every override carries a provenance note.
 *
 * Every model declares its own `reasoningEffortValues` here (models.dev has no
 * such field), and the ones pi must be able to switch off also declare
 * `thinkingLevelMap.off`: pi maps `reasoning: "off"` to `reasoningEffort:
 * undefined` and pi-ai only emits `reasoning_effort` when that map supplies a
 * value, so the map is what makes `thinking: off` reach the gateway.
 *
 * Per-model contract (https://nan.builders/docs/models#controlling-reasoning,
 * checked 2026-11-17), with the 2026-09-27/2026-10-14 measurements recorded on
 * the entries they still govern:
 * - qwen3.6, gemma4: `none`/`minimal` skip reasoning, the rest cap the phase
 *   (2,048 / 8,192 / 16,384 / 32,768 tokens).
 * - deepseek-v4-flash: `none` disables reasoning (measured: 0 reasoning
 *   tokens with a full answer), the rest only steer it (measured 57 / 63 / 109
 *   reasoning tokens for low / omitted / minimal).
 * - mimo-v2.6-flash: `none` off; `minimal` is applied as `low`, `xhigh` as
 *   `max`.
 * - glm5.3, glm5.3-flash: cannot stop reasoning; `none` is applied as
 *   `minimal`, which is what `off` maps to.
 * - qwen3.8-flash, qwen4-max: `none` off (fully), `minimal`…`max` steer.
 * - hy4: reasons by default, the gateway applies `low` when no level is sent;
 *   `none` off.
 * - hy4-flash: reasons by default with no default level; `none` off.
 * - qwen3.8-max: `none` off.
 * - kimi-k3.1-pro, deepseek-v4-pro: the docs keep them out of the contract and
 *   the `none` aliases are not mapped on them, so nothing is declared and
 *   nothing is sent.
 */
export const MANUAL_OVERRIDES: Record<string, ManualModelOverride> = {
	...LARGER_MODELS,
	"glm5.3": {
		name: "GLM 5.3",
		input: ["text"],
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		reasoningEffortValues: ["minimal", "low", "medium", "high", "xhigh", "max"],
		thinkingLevelMap: { off: "minimal", xhigh: "xhigh", max: "max" },
		note:
			"general catalog model since 2026-11-10: NaN announced it no longer has tier-exclusive models ('a partir de ahora ya NO habrá modelos exclusivos por tier'), and the live GET https://api.nan.builders/v1/models lists glm5.3 for a non-premium key (checked 2026-11-10). " +
			"input text only: the model card says 'Text only: text in, text out, with no image, audio, video or file input; a request carrying one answers 400, earlier turns of the conversation included', and https://nan.builders/docs/pi declares the same 'input': ['text'] (https://nan.builders/docs/models, checked 2026-11-17). The earlier override declared text+image from the 2026-10-14 card; models.dev also lists it text-only now, so this is a correction of a stale value, not a divergence. " +
			"contextWindow 1,048,576 ('1M token context'). maxTokens 131,072: models.dev's documented maximum; the docs' own pi/OpenCode blocks publish 32,768 and describe that field as 'a client-side budget rather than a server cap' (https://nan.builders/docs/opencode), so the larger model maximum stays. " +
			"reasoningEffortValues minimal..max and thinkingLevelMap { off: 'minimal' }: the card says 'reasoning_effort: minimal to max; always reasons, none is applied as minimal' (checked 2026-11-17), so `thinking: off` sends the shortest reasoning the gateway honours. The previous map sent 'low' because the stale docs listed low as the floor. name 'GLM 5.3' per the docs (models.dev says 'GLM-5.3').",
	},
	"qwen3.8-flash": {
		contextWindow: 1_048_576,
		maxTokensField: "max_completion_tokens",
		reasoningEffortValues: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
		thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
		note:
			"contextWindow 1,048,576: NaN docs state '1M token context (1,048,576 tokens)' and 'Max answer 131K tokens' (https://nan.builders/docs/models, checked 2026-11-17) — models.dev still lists 262,144. The earlier override was withdrawn 2026-09-07 when the docs read '262K token context, the model's native window'; the docs now state 1M and they are the source of truth (maintainer instruction: docs win over models.dev, which a user updates later). maxTokens stays 131,072, which models.dev already matches and the docs confirm as the 131K max answer. " +
			"maxTokensField 'max_completion_tokens' (issue #34, NaN maintainer confirmation received 2026-11-11, quoted verbatim in the issue): on this model max_tokens does NOT bound the reasoning phase, the excess bills against the quota (it explained the 796M tokens against the 500M cap in the 2026-09-27 /v1/usage survey), and max_completion_tokens IS respected as the interim bound. The published OpenAPI schema still documents only max_tokens, so the strict-schema sanitizer exempts this model from its max_completion_tokens→max_tokens rename at request time (SanitizerOptions.preserveMaxCompletionTokens, wired from compat.maxTokensField in src/provider-factory.ts). REVERT: once NaN ships their prepared gateway fix, remove this override — test/issue-34-max-completion-tokens.test.ts is the tripwire. " +
			"reasoningEffortValues none..max and thinkingLevelMap { off: 'none' }: the card says 'Reasoning on by default (reasoning_effort: none turns it off · minimal to max)' and the contract table says 'Off. No reasoning tokens' for `none` (https://nan.builders/docs/models, checked 2026-11-17), so `thinking: off` now actually disables reasoning. The earlier note said the parameter was 'accepted, depth not adjustable' with no map, which was true of the 2026-10-14 docs; the model card and the contract table now state the opposite and the docs win.",
	},
	"deepseek-v4-flash": {
		input: ["text", "image"],
		contextWindow: 1_048_576,
		maxTokens: 32_768,
		reasoningEffortValues: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
		thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
		note:
			"contextWindow 1,048,576: NaN docs state '1M token context' for this model (https://nan.builders/docs/models, checked 2026-11-17). models.dev lists 1,000,000, a rounded form of the same window; the docs value is authoritative (maintainer instruction: docs win over models.dev, which a user updates later). " +
			"input includes image: NaN serves the Vision-Exp variant ('takes images as input', https://nan.builders/docs/models; the image_url content-parts in https://nan.builders/openapi.json list deepseek-v4-flash among the vision models). models.dev provider nan also lists text+image, so this stays a pin for the vision capability rather than a divergence. " +
			"maxTokens 32768 per the official NaN pi docs (https://nan.builders/docs/pi, 'the same set the NaN CLI writes', checked 2026-10-02) closing issue #20 — the gateway rejects max_tokens above ~256k for this model with 403 permission_error (measured 2026-10-02: 256,000 → 200; 262,143 → 403), and the previous models.dev-derived 384000 made every pi request fail because pi-ai sends max_tokens = model.maxTokens by default. models.dev still lists 384000, so this override pins the documented value. " +
			"reasoningEffortValues: the docs say 'none turns it off · minimal to max' and the contract table says the other values 'steer how much it reasons. They are hints the model follows, not hard caps' (https://nan.builders/docs/models#controlling-reasoning, checked 2026-11-17), so the documented ladder is declared. The measurement behind issue #16 stays the load-bearing fact and is unchanged: only \"none\" suppresses reasoning (0 reasoning tokens with a full answer; `low` 57, omitted 63, `minimal` 109 — re-probed live 2026-10-14), which is why thinkingLevelMap.off is \"none\". " +
			"thinkingLevelMap { off: \"none\" } (issue #16, measured 2026-09-27): when pi maps reasoning:\"off\" to reasoningEffort:undefined, the thinkingLevelMap.off=\"none\" supplies the effort so the gateway receives reasoning_effort:\"none\" and does NOT enter runaway reasoning mode.",
	},
	"glm5.3-flash": {
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		reasoningEffortValues: ["minimal", "low", "medium", "high", "xhigh", "max"],
		thinkingLevelMap: { off: "minimal", xhigh: "xhigh", max: "max" },
		note:
			"contextWindow 1,048,576 ('1M token context') and maxTokens 131,072: the docs state that an output budget above this model's maximum is lowered to 131072, so 131,072 is its documented ceiling (https://nan.builders/docs/models, checked 2026-11-17); models.dev lists the rounded 1,000,000 window. " +
			"thinkingLevelMap { off: \"minimal\" }: the card says 'reasoning_effort: minimal to max; always reasons, none is applied as minimal' — the gateway never stops reasoning on this model. issue #16 measured the same effect on 2026-09-27: 'minimal' yields ~38 reasoning tokens with an answer, while 'none' does not suppress it (13,382 tokens). " +
			"reasoningEffortValues minimal..max per the card, xhigh included (the docs' value ladder runs none, minimal, low, medium, high, xhigh, max).",
	},
	"mimo-v2.6-flash": {
		reasoningEffortValues: ["none", "low", "medium", "high", "max"],
		thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
		note:
			"reasoningEffortValues none/low/medium/high/max: the card says 'reasoning_effort: none turns it off · low to max', and the contract table says 'minimal is applied as low and xhigh as max' (https://nan.builders/docs/models#controlling-reasoning, checked 2026-11-17), so only the values with their own meaning are declared. " +
			"thinkingLevelMap { off: \"none\" } (live re-probe 2026-10-14): the 2026-10-14 docs called the parameter 'accepted, depth not adjustable', but the gateway makes it effective at the off end — `none` gave 0 reasoning tokens / a full answer, while `low` gave 22 reasoning tokens and omitting the parameter gave 17. Measured behavior wins over the docs, so `thinking: off` sends reasoning_effort:\"none\" and actually disables reasoning.",
	},
	"qwen3.6": {
		reasoningEffortValues: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
		thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
		note:
			"thinkingLevelMap { off: \"none\" } (issue #16): NaN docs state that with no reasoning_effort parameter every model uses its own default and that default is reasoning ON for qwen3.6 (16,384-token budget), while `none` and `minimal` skip the reasoning phase entirely (https://nan.builders/docs/models#controlling-reasoning, checked 2026-11-17). pi maps reasoning:\"off\" to reasoningEffort:undefined, so without this map `thinking: off` sent no parameter and the model reasoned anyway; the map sends reasoning_effort:\"none\" and actually disables reasoning. " +
			"reasoningEffortValues: the contract table documents the whole ladder (low 2,048, medium 8,192, high 16,384, xhigh and max 32,768 reasoning tokens on Chat Completions).",
	},
	"gemma4": {
		reasoningEffortValues: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
		thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
		note:
			"thinkingLevelMap { off: \"none\" } (issue #16): NaN docs state that with no reasoning_effort parameter gemma4 defaults to reasoning ON (16,384-token budget), while `none`/`minimal` skip reasoning entirely (https://nan.builders/docs/models#controlling-reasoning, checked 2026-11-17). pi maps reasoning:\"off\" to reasoningEffort:undefined, so without this map `thinking: off` sent no parameter and the model reasoned anyway; the map sends reasoning_effort:\"none\" and actually disables reasoning. " +
			"reasoningEffortValues: the contract table documents the whole ladder (low 2,048, medium 8,192, high 16,384, xhigh and max 32,768 reasoning tokens on Chat Completions).",
	},
};

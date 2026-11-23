/**
 * MODEL_FACTS — the manual layer of the exported model-facts catalog
 * (issue #47).
 *
 * Same posture as `MANUAL_OVERRIDES`: this is the place a hand-maintained fact
 * enters the build, with provenance, instead of being transcribed from README
 * prose by a consumer. `scripts/generate-models.ts` validates these
 * declarations against the catalog it just generated (every catalog id
 * declared, no ghost ids, every value inside its documented union, every cell
 * sourced), and `src/model-facts.ts` projects them into the frozen public
 * record.
 *
 * The carried capabilities (context window, max tokens, cost, modalities,
 * reasoning map, compat) are NOT repeated here — they are read from the
 * generated catalog entry, which already carries its own provenance notes.
 * Only the eight facts this issue promotes out of prose are declared.
 *
 * Sources (`sources` ids) resolve through `NAN_FACT_SOURCES` in
 * `src/model-facts-core.ts`:
 * - `docs` / `docs-reasoning` / `docs-cross-model`: https://nan.builders/docs/models
 *   (checked 2026-11-23). `docs-cross-model` marks a statement made on the
 *   deepseek-v4-flash card about the GLM models, qwen3.6 and gemma4.
 * - `model-guide`: https://nan.builders/model-guide (the NaN community guide
 *   that publishes a cache rate per model).
 * - `measured-36`: the qwen3.8-flash 2026-11-18 probe recorded in issue #36 —
 *   a measurement beats the docs, which still describe the pre-fix exception.
 * - `none`: no positive claim (the `unmeasured` sentinel, or a field the
 *   catalog does not declare).
 *
 * Per-model evidence, all from the sources above:
 * - Tool protocol: the docs spell it on every card — "Tool calling (XML
 *   format)" on qwen3.8-flash, qwen3.6 and gemma4, "Tool calling (function
 *   calling)" on the other ten.
 * - `max_tokens` semantics: the docs' reasoning section says the output budget
 *   "is used exactly as you send it on every model … Reasoning tokens are spent
 *   from that same budget", and names qwen3.8-max as the model where
 *   "`max_tokens` only bounds the visible answer". qwen3.8-flash is the same
 *   exception on paper, but the 2026-11-18 probe (max_tokens=64 →
 *   completion_tokens=64, all reasoning) measured the fixed behaviour, so that
 *   cell follows the measurement.
 * - Thinking budget: the docs make `thinking_budget`/`thinking_token_budget` a
 *   hard 1–32768 cap on qwen3.6, gemma4 and qwen3.8-flash, state it "is not
 *   honoured on this model" for qwen3.8-max, and keep every other model out of
 *   the contract ("depending on the model it is rejected with a 400 or
 *   ignored") — which is `unmeasured`, not `ignored`.
 * - Cache mode: the model guide publishes a cache rate for eleven models and no
 *   opt-in parameter is documented anywhere, so the cache engages
 *   automatically; qwen3.6 and gemma4 have no published rate and stay
 *   `unmeasured`.
 * - Billing class: the docs' Billing row reads "credits · larger model" on the
 *   six larger models and "credits" on the rest; no chat model is quota-billed.
 * - Structured output: documented per model (json_object and/or json_schema);
 *   silence is `unmeasured`, never a guessed `true`.
 * - Parallel tool calls: nothing documents or measures several tool calls per
 *   assistant turn, so every cell is `unmeasured`.
 * - Cold ceiling: the only measurement is endpoint-wide, so every model carries
 *   `unmeasured` and the number ships as `NAN_ENDPOINT_FACTS`.
 */

import type { ModelFactsDeclaration, ModelFactsDeclarations, NanFactSource, NanNewFactCell } from "../src/model-facts-core.ts";

/**
 * Default provenance per cell. A model overrides only the cells whose evidence
 * differs from "documented on its own card, with a published cache rate".
 */
const BASE_SOURCES: Readonly<Record<NanNewFactCell, NanFactSource>> = {
	toolCalling: "docs",
	maxTokensSemantics: "docs",
	thinkingBudget: "none",
	coldCeilingTokens: "none",
	cacheMode: "model-guide",
	billingClass: "docs",
	parallelToolCalls: "none",
	structuredOutput: "none",
};

/** Compact declaration: the eight values, with provenance defaulting to BASE_SOURCES. */
function declaration(
	facts: Omit<ModelFactsDeclaration, "sources">,
	sources: Partial<Record<NanNewFactCell, NanFactSource>> = {},
): ModelFactsDeclaration {
	return { ...facts, sources: { ...BASE_SOURCES, ...sources } };
}

/**
 * Per-model declarations, keyed by catalog id. A model missing here fails the
 * build (`bun run generate-models`) and the test corpus.
 */
export const MODEL_FACTS: ModelFactsDeclarations = {
	"deepseek-v4-flash": declaration(
		{
			toolCalling: "openai-tools",
			maxTokensSemantics: "bounds-total",
			thinkingBudget: "unmeasured",
			coldCeilingTokens: "unmeasured",
			cacheMode: "automatic",
			billingClass: "credit-standard",
			parallelToolCalls: "unmeasured",
			structuredOutput: true,
		},
		{ structuredOutput: "docs" },
	),
	"deepseek-v4-pro": declaration({
		toolCalling: "openai-tools",
		maxTokensSemantics: "bounds-total",
		thinkingBudget: "unmeasured",
		coldCeilingTokens: "unmeasured",
		cacheMode: "automatic",
		billingClass: "credit-larger",
		parallelToolCalls: "unmeasured",
		structuredOutput: "unmeasured",
	}),
	gemma4: declaration(
		{
			toolCalling: "xml",
			maxTokensSemantics: "bounds-total",
			thinkingBudget: "honoured",
			coldCeilingTokens: "unmeasured",
			cacheMode: "unmeasured",
			billingClass: "credit-standard",
			parallelToolCalls: "unmeasured",
			structuredOutput: true,
		},
		{ thinkingBudget: "docs-reasoning", cacheMode: "none", structuredOutput: "docs-cross-model" },
	),
	"glm5.3": declaration(
		{
			toolCalling: "openai-tools",
			maxTokensSemantics: "bounds-total",
			thinkingBudget: "unmeasured",
			coldCeilingTokens: "unmeasured",
			cacheMode: "automatic",
			billingClass: "credit-larger",
			parallelToolCalls: "unmeasured",
			structuredOutput: true,
		},
		{ structuredOutput: "docs-cross-model" },
	),
	"glm5.3-flash": declaration(
		{
			toolCalling: "openai-tools",
			maxTokensSemantics: "bounds-total",
			thinkingBudget: "unmeasured",
			coldCeilingTokens: "unmeasured",
			cacheMode: "automatic",
			billingClass: "credit-standard",
			parallelToolCalls: "unmeasured",
			structuredOutput: true,
		},
		{ structuredOutput: "docs-cross-model" },
	),
	hy4: declaration({
		toolCalling: "openai-tools",
		maxTokensSemantics: "bounds-total",
		thinkingBudget: "unmeasured",
		coldCeilingTokens: "unmeasured",
		cacheMode: "automatic",
		billingClass: "credit-larger",
		parallelToolCalls: "unmeasured",
		structuredOutput: "unmeasured",
	}),
	"hy4-flash": declaration(
		{
			toolCalling: "openai-tools",
			maxTokensSemantics: "bounds-total",
			thinkingBudget: "unmeasured",
			coldCeilingTokens: "unmeasured",
			cacheMode: "automatic",
			billingClass: "credit-standard",
			parallelToolCalls: "unmeasured",
			structuredOutput: true,
		},
		{ structuredOutput: "docs" },
	),
	"kimi-k3.1-pro": declaration({
		toolCalling: "openai-tools",
		maxTokensSemantics: "bounds-total",
		thinkingBudget: "unmeasured",
		coldCeilingTokens: "unmeasured",
		cacheMode: "automatic",
		billingClass: "credit-larger",
		parallelToolCalls: "unmeasured",
		structuredOutput: "unmeasured",
	}),
	"mimo-v2.6-flash": declaration({
		toolCalling: "openai-tools",
		maxTokensSemantics: "bounds-total",
		thinkingBudget: "unmeasured",
		coldCeilingTokens: "unmeasured",
		cacheMode: "automatic",
		billingClass: "credit-standard",
		parallelToolCalls: "unmeasured",
		structuredOutput: "unmeasured",
	}),
	"qwen3.6": declaration(
		{
			toolCalling: "xml",
			maxTokensSemantics: "bounds-total",
			thinkingBudget: "honoured",
			coldCeilingTokens: "unmeasured",
			cacheMode: "unmeasured",
			billingClass: "credit-standard",
			parallelToolCalls: "unmeasured",
			structuredOutput: true,
		},
		{ thinkingBudget: "docs-reasoning", cacheMode: "none", structuredOutput: "docs-cross-model" },
	),
	"qwen3.8-flash": declaration(
		{
			toolCalling: "xml",
			maxTokensSemantics: "bounds-total",
			thinkingBudget: "honoured",
			coldCeilingTokens: "unmeasured",
			cacheMode: "automatic",
			billingClass: "credit-standard",
			parallelToolCalls: "unmeasured",
			structuredOutput: "unmeasured",
		},
		{ thinkingBudget: "docs-reasoning", maxTokensSemantics: "measured-36" },
	),
	"qwen3.8-max": declaration(
		{
			toolCalling: "openai-tools",
			maxTokensSemantics: "bounds-visible-answer",
			thinkingBudget: "ignored",
			coldCeilingTokens: "unmeasured",
			cacheMode: "automatic",
			billingClass: "credit-larger",
			parallelToolCalls: "unmeasured",
			structuredOutput: "unmeasured",
		},
		{ maxTokensSemantics: "docs-reasoning", thinkingBudget: "docs-reasoning" },
	),
	"qwen4-max": declaration(
		{
			toolCalling: "openai-tools",
			maxTokensSemantics: "bounds-total",
			thinkingBudget: "unmeasured",
			coldCeilingTokens: "unmeasured",
			cacheMode: "automatic",
			billingClass: "credit-larger",
			parallelToolCalls: "unmeasured",
			structuredOutput: true,
		},
		{ structuredOutput: "docs" },
	),
};

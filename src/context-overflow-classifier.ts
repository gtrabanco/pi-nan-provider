/**
 * NaN-aware context-overflow classification.
 *
 * Root cause (pi-ai, still present on 0.85.1 / main): when history is replayed
 * into a DIFFERENT model, `transformMessages` downgrades every non-redacted
 * `thinking` block to plain `text` verbatim, with no size bound — and nothing
 * bounds the SUM across messages. Switching from a 1M-context model
 * (`glm5.3-flash`, `deepseek-v4-flash`) to a 262K one (`qwen3.6`) can therefore
 * push the request past the destination window (see
 * `src/cross-model-thinking-guard.ts` for the primary mitigation, which drops
 * that replayed reasoning before pi-ai converts it).
 *
 * When the request still overflows — the guard is disabled
 * (`NAN_THINKING_GUARD=0`), the trace is not a `thinking` block (large tool
 * outputs, images), or the destination window is simply smaller — NaN's LiteLLM
 * gateway answers the generic
 *   HTTP 400 `Invalid request. Check your request parameters.`
 * instead of naming the context overflow. pi's auto-compaction keys on pi-ai's
 * `isContextOverflow()`, whose documented patterns do NOT match that text, so
 * the session wedges permanently at the ceiling (the issue's upstream
 * earendil-works/pi#9409, "Sessions wedge permanently at the context ceiling on
 * reasoning models").
 *
 * This module makes the package **re-check the request size on the way out**
 * (one of the two upstream fixes the tracking issue names). After the request is
 * sent and the gateway answers, if
 *   - the terminal assistant message is an error whose text carries NaN's
 *     generic 400 marker, AND
 *   - the request we sent was estimated to exceed the model's context window,
 * then the error message is rewritten into a form that matches pi-ai's
 * documented overflow patterns, so pi compacts and retries instead of wedging.
 * The original provider text is preserved in the rewritten message. The
 * reclassification is deliberately conservative: a generic 400 on a
 * within-window request is left untouched, so unrelated 400s are never
 * mislabelled as overflow.
 *
 * Estimation ratio: the same chars/3.47 the issue's offline session measurements
 * use (`chars/3.47 + ~31K tools + ~12K system`). The system prompt and tool
 * schemas are counted explicitly, so the constant is only applied to the
 * message/character budget. This is a heuristic for deciding whether a generic
 * 400 is plausibly an overflow — it never fabricates model metadata.
 */

import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreams,
} from "@earendil-works/pi-ai";

/** The exact generic body NaN's gateway returns for an over-window request. */
export const NAN_GENERIC_BAD_REQUEST = "Invalid request. Check your request parameters.";

/**
 * Characters per token used for the request-size estimate. Same ratio as the
 * issue's offline measurements (chars/3.47); a conservative, provider-agnostic
 * heuristic, never a capability claim.
 */
export const ESTIMATED_CHARS_PER_TOKEN = 3.47;

/**
 * Estimate the input tokens of an outgoing request from its character size.
 * Returns 0 when the context cannot be serialized (nothing is reclassified).
 */
export function estimateRequestTokens(
	context: Pick<Context, "systemPrompt" | "messages" | "tools"> | undefined,
): number {
	if (!context) return 0;
	const systemChars = typeof context.systemPrompt === "string" ? context.systemPrompt.length : 0;
	const toolsChars = safeJsonLength(context.tools);
	const messagesChars = safeJsonLength(context.messages);
	const total = systemChars + toolsChars + messagesChars;
	if (!Number.isFinite(total) || total <= 0) return 0;
	return Math.ceil(total / ESTIMATED_CHARS_PER_TOKEN);
}

function safeJsonLength(value: unknown): number {
	if (value === undefined || value === null) return 0;
	if (Array.isArray(value) && value.length === 0) return 0;
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}

/**
 * True when a terminal error message carries NaN's generic-400 marker (with or
 * without the `400: {...}` wrapper pi-ai adds).
 */
export function isGenericNanBadRequest(message: Pick<AssistantMessage, "errorMessage"> | undefined): boolean {
	return typeof message?.errorMessage === "string" && message.errorMessage.includes(NAN_GENERIC_BAD_REQUEST);
}

/**
 * Reclassify a terminal assistant error as a context overflow when — and only
 * when — NaN returned its generic 400 for a request estimated to exceed the
 * model's context window. Mutates and returns the message (the same object
 * flows through the error event and `result()`).
 */
export function classifyContextOverflowError<T extends AssistantMessage>(
	message: T,
	model: Pick<Model<"openai-completions">, "contextWindow"> | { contextWindow?: number } | undefined,
	estimatedInputTokens: number,
): T {
	if (message.stopReason !== "error") return message;
	if (!isGenericNanBadRequest(message)) return message;
	const contextWindow = model?.contextWindow ?? 0;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return message;
	if (!Number.isFinite(estimatedInputTokens) || estimatedInputTokens <= contextWindow) return message;

	message.errorMessage =
		`Requested token count exceeds the model's maximum context length of ${contextWindow} tokens ` +
		`(estimated ${Math.ceil(estimatedInputTokens)} input tokens). ` +
		`NaN's gateway answered HTTP 400 "${NAN_GENERIC_BAD_REQUEST}" instead of naming the overflow, ` +
		`so the context must be compacted before retrying.`;
	return message;
}

/**
 * Wrap a provider stream so its terminal error is classified against the size
 * of the request that produced it. Both the `error` event and `result()` yield
 * the same (mutated) message, so iterating consumers and `result()`-only
 * consumers agree.
 */
export function classifyStreamContextOverflow(
	stream: AssistantMessageEventStream,
	model: { contextWindow?: number } | undefined,
	estimatedInputTokens: number,
): AssistantMessageEventStream {
	const rewrite = (message: AssistantMessage | undefined): AssistantMessage | undefined => {
		if (message) classifyContextOverflowError(message, model, estimatedInputTokens);
		return message;
	};
	const resultPromise = stream.result().then(rewrite);

	return new Proxy(stream, {
		get(target, property, receiver) {
			if (property === "result") return () => resultPromise;
			if (property === Symbol.asyncIterator) {
				return () => {
					const iterator = target[Symbol.asyncIterator]();
					return {
						async next() {
							const step = await iterator.next();
							if (!step.done && step.value?.type === "error") rewrite(step.value.error);
							return step;
						},
						async return(value?: unknown) {
							return iterator.return ? iterator.return(value) : { done: true, value };
						},
						async throw(error?: unknown) {
							if (iterator.throw) return iterator.throw(error);
							throw error;
						},
						[Symbol.asyncIterator]() {
							return this;
						},
					};
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as AssistantMessageEventStream;
}

/**
 * Wrap every `stream`/`streamSimple` call so a NaN over-window request whose
 * gateway answer is the opaque generic 400 is surfaced as a context overflow.
 */
export function withContextOverflowClassification(api: ProviderStreams): ProviderStreams {
	return {
		...api,
		stream: (model, context, options) =>
			classifyStreamContextOverflow(api.stream(model, context, options), model, estimateRequestTokens(context)),
		streamSimple: (model, context, options) =>
			classifyStreamContextOverflow(api.streamSimple(model, context, options), model, estimateRequestTokens(context)),
	};
}

/**
 * NaN-aware context-overflow classification.
 *
 * Root cause (pi-ai, verified on 0.87.1): when history is replayed
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
 * sent and the gateway answers, two independent branches reclassify:
 *
 * 1. **HTTP 400 branch** — keys on the **model's context window**. When the
 *    terminal error carries NaN's generic 400 marker AND the estimated input
 *    tokens exceed the destination model's `contextWindow`, the message is
 *    rewritten. A 400 may be caused by other schema violations, so the rewrite
 *    conservatively requires the request to be over the window.
 *
 * 2. **HTTP 524 branch** — keys on a **fixed cold-cache ceiling**
 *    (`NAN_COLD_CACHE_CEILING_TOKENS`, 200,000). Cloudflare's 524
 *    origin_response_timeout fires when a large cold prompt hangs past the 120s
 *    proxy read timeout. A 524 on an over-ceiling request is an overflow
 *    masquerading as a timeout; a 524 under the ceiling is a genuine transient
 *    timeout. The ceiling is a *practical endpoint limit* (Cloudflare 120s vs
 *    cold-prompt prefill), NOT a model capability — so the model's
 *    `contextWindow` is irrelevant to the 524 reclassify decision. The rewritten
 *    message still mentions the model window for user clarity, but the
 *    overflow-classification hinges only on the ceiling.
 *
 * The original provider text is preserved in rewritten messages. The
 * reclassification is deliberately conservative so unrelated errors are never
 * mislabelled as overflow.
 *
 * ---
 *
 * Cold-cache 524 (issue #18): large COLD prompts (≳1 MB body / ~220k tokens) to
 * https://api.nan.builders/v1/chat/completions hang past Cloudflare's 120s Proxy
 * Read Timeout → HTTP 524 origin_response_timeout with JSON body
 *   {"status":524,"error_name":"origin_response_timeout","retryable":true,...}
 * (sometimes a Cloudflare HTML page for even larger bodies). Measured: cold
 * 208,036 tokens (960 KB) succeeds (TTFT 12.9 s); ~220k and ~286k tokens cold
 * → 524 at ~126 s. pi-ai classifies 524 as RETRYABLE (retrying an identical cold
 * payload always fails) and its `isContextOverflow()` matches nothing, so the
 * session wedges. When the error is a 524 AND the estimated input tokens exceed
 * `NAN_COLD_CACHE_CEILING_TOKENS`, the error is rewritten into a pi-recognizable
 * overflow message so pi compacts and retries instead of wedging. The original
 * provider text is preserved. A 524 on a small request (under the ceiling) is
 * left untouched — it is a genuine transient timeout.
 *
 * Estimation ratio: the same chars/3.47 the issue's offline session measurements
 * use (`chars/3.47 + ~31K tools + ~12K system`). The system prompt and tool
 * schemas are counted explicitly, so the constant is only applied to the
 * message/character budget. This is a heuristic for deciding whether a generic
 * 400 / 524 is plausibly an overflow — it never fabricates model metadata.
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
 * Cloudflare 524 origin_response_timeout cold-cache ceiling (tokens).
 *
 * Measured (issue #18 repro): cold 208,036 tokens (960 KB) succeeds
 * (TTFT 12.9 s); ~220k and ~286k tokens cold → 524 at ~126 s. 200,000 is a
 * conservative midpoint — well below the working 208k measurement — so the
 * working cold cache path is not affected while larger cold requests hit this
 * rewrite. This is a practical endpoint ceiling (Cloudflare 120s proxy read
 * timeout vs cold prompt prefill), NOT a model capability — contextWindow in
 * the catalog must NOT change.
 */
export const NAN_COLD_CACHE_CEILING_TOKENS = 200_000;

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
 * True when a terminal error message carries a Cloudflare 524
 * origin_response_timeout marker. Matches the 524 status followed by either
 * `origin_response_timeout` in the JSON body, or Cloudflare HTML markers
 * (`Error 524` / `A timeout occurred`). Conservative: only these known
 * markers are matched, not any arbitrary 524 response.
 */
function isCloudflare524(message: Pick<AssistantMessage, "errorMessage"> | undefined): boolean {
	const text = message?.errorMessage;
	if (typeof text !== "string") return false;
	// Match the status code + origin_response_timeout JSON body.
	if (text.includes("524") && text.includes("origin_response_timeout")) return true;
	// Cloudflare HTML error page variant (occurs for very large bodies).
	if (text.includes("524") && (text.includes("Error 524") || text.includes("A timeout occurred"))) return true;
	return false;
}

/**
 * Reclassify a terminal assistant error as a context overflow when — and only
 * when — NaN returned its generic 400 for a request estimated to exceed the
 * model's context window, OR when a Cloudflare 524 fires for an over-ceiling
 * cold request. Mutates and returns the message (the same object flows through
 * the error event and `result()`).
 *
 * The two error paths use independent thresholds:
 * - 400: estimated > contextWindow  (conservative; a 400 may be schema-related)
 * - 524: estimated > CEILING        (a 524 is either overflow or transient;
 *                                    the ceiling is the discriminator)
 */
export function classifyContextOverflowError<T extends AssistantMessage>(
	message: T,
	model: Pick<Model<"openai-completions">, "contextWindow"> | { contextWindow?: number } | undefined,
	estimatedInputTokens: number,
): T {
	if (message.stopReason !== "error") return message;

	const contextWindow = model?.contextWindow;
	const hasValidWindow = Number.isFinite(contextWindow) && contextWindow! > 0;

	// --- 400 branch: keys on the model's context window ---
	if (isGenericNanBadRequest(message) && hasValidWindow
		&& Number.isFinite(estimatedInputTokens)
		&& estimatedInputTokens > contextWindow!) {
		message.errorMessage =
			`Requested token count exceeds the model's maximum context length of ${contextWindow!} tokens ` +
			`(estimated ${Math.ceil(estimatedInputTokens)} input tokens). ` +
			`NaN's gateway answered HTTP 400 "${NAN_GENERIC_BAD_REQUEST}" instead of naming the overflow, ` +
			`so the context must be compacted before retrying.`;
		return message;
	}

	// --- 524 branch: keys on the cold-cache ceiling only ---
	// A 524 origin_response_timeout on an over-ceiling request means the edge
	// timed out while prefilling a large cold prompt — it is an overflow, not a
	// transient error. Small-requests that hit 524 are genuine timeouts.
	if (isCloudflare524(message)
		&& Number.isFinite(estimatedInputTokens)
		&& estimatedInputTokens > NAN_COLD_CACHE_CEILING_TOKENS) {
		const windowClause = hasValidWindow
			? ` (declared model window: ${contextWindow!} tokens)`
			: "";
		message.errorMessage =
			`Requested token count exceeds the maximum context length of ${NAN_COLD_CACHE_CEILING_TOKENS} tokens ` +
			`servable with a cold prompt cache through NaN's endpoint` +
			windowClause +
			`, so the context must be compacted before retrying. ` +
			`(estimated ${Math.ceil(estimatedInputTokens)} input tokens; ` +
			`Cloudflare answers HTTP 524 origin_response_timeout past the 120s proxy read timeout). ` +
			`Original error: ${message.errorMessage}.`;
		return message;
	}

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
/**
 * NaN reasoning-only stream guard (issue #21).
 *
 * Problem: NaN's gateway closes a streaming turn that produced ONLY reasoning
 * (no content, no tool calls) at 60,000 reasoning chars or 420 seconds:
 * `finish_reason: "length"` on an empty delta, followed by a final usage chunk
 * (estimated, unbilled) carrying `nan_truncation: { reason: "reasoning_only_stream" }`.
 * Through pi-ai this maps to `stopReason: "length"` with no text — indistinguishable
 * from a real output-limit cut, never retried, and the turn is silently wasted.
 *
 * Solution: intercept the raw stream chunks via the `onProviderStreamEvent`
 * hook (pi-ai's openai-completions calls `options?.onProviderStreamEvent?.(chunk,
 * model)` for every raw chunk — including the final usage-only chunk, which is
 * where NaN attaches `nan_truncation`) and detect the
 * `nan_truncation.reason === "reasoning_only_stream"` marker. When seen,
 * rewrite the terminal message (both the async-iterator `done`/`error` events and
 * `result()`) to `stopReason: "error"` with an errorMessage containing the word
 * "timeout", so pi-ai's `RETRYABLE_PROVIDER_ERROR_PATTERN` treats it as retryable.
 *
 * The rewrite is **never** applied when the marker was not observed on that stream —
 * a legitimate `length` (real output cut with content) and the issue-#16 runaway
 * `length` (no marker) must pass through untouched.
 *
 * Composition: `withReasoningOnlyStreamGuard` is the **innermost** of the three
 * wrapper layers in `src/provider-factory.ts` (inside both the sanitizer and the
 * overflow classifier) so that:
 * 1. The sanitizer still runs first (payload goes out clean).
 * 2. The classifier's error rewrites still apply on top of our rewrite.
 * 3. The guard's marker detection runs on the *raw* chunk.
 *
 * NOTE: the observation hook MUST be `onProviderStreamEvent` (response chunks),
 * NOT `onPayload` — `onPayload` receives the OUTGOING request params
 * (openai-completions.js:188) and would never carry `nan_truncation`.
 *
 * In practice, the composition line is:
 * ```
 * withContextOverflowClassification(
 *   withReasoningOnlyStreamGuard(
 *     wrapApiForStrictSanitization(apiFactory())
 *   )
 * )
 * ```
 */

import type {
	AssistantMessage,
	AssistantMessageEventStream,
	ProviderStreams,
} from "@earendil-works/pi-ai";

/** The JSON key under which NaN attaches the truncation metadata. */
export const NAN_TRUNCATION_MARKER = "nan_truncation";

/** The value of `reason` when NaN closes a reasoning-only stream. */
export const REASONING_ONLY_STREAM_REASON = "reasoning_only_stream";

/**
 * Check whether a raw stream chunk carries the reasoning-only stream marker.
 *
 * Pure function — useful for unit tests and for reasoning about chunk shapes
 * without needing the full guard wrapper.
 */
export function isReasoningOnlyStreamChunk(chunk: unknown): boolean {
	if (typeof chunk !== "object" || chunk === null) return false;
	const obj = chunk as Record<string, unknown>;
	const truncation = obj[NAN_TRUNCATION_MARKER];
	if (typeof truncation !== "object" || truncation === null) return false;
	return (truncation as Record<string, unknown>)?.reason === REASONING_ONLY_STREAM_REASON;
}

/** The rewrite applied to a terminal message when the marker was observed. */
const REASONING_ONLY_REWRITE: Partial<AssistantMessage> = {
	stopReason: "error" as const,
	errorMessage:
		"NaN timed out the stream before any answer content (reasoning-only stream guard: 420 s / 60,000-character limit; the turn was not billed). Original finish_reason: length.",
};

/**
 * Rewrite the terminal assistant message when the reasoning-only stream marker
 * was observed during this stream.  Only rewrites when `stopReason === "length"`
 * AND the marker was set — everything else passes through untouched.
 *
 * Mutates and returns the same message object so that both the async-iterator
 * consumers and `result()`-only consumers see the rewrite (pi-ai yields the
 * same object through the `"done"` event's `message` field and through `result()`).
 */
function rewriteReasoningOnlyMessage(
	message: AssistantMessage | undefined,
	observedMarker: boolean,
): AssistantMessage | undefined {
	if (!observedMarker || !message) return message;
	if (message.stopReason !== "length") return message;

	// Only rewrite a terminal "length" that came with the nan_truncation marker.
	// Preserve all existing fields: reasoning/thinking blocks, usage, responseId.
	message.stopReason = "error";
	message.errorMessage = REASONING_ONLY_REWRITE.errorMessage!;
	return message;
}

/**
 * Wrap a stream so its terminal message is rewritten when the reasoning-only
 * stream marker was observed. Uses a Proxy to intercept both the async-iterator
 * `"error"`/`"done"` events and the `result()` call, mirroring the
 * `classifyStreamContextOverflow` technique.
 */
function rewriteStream(
	stream: AssistantMessageEventStream,
	observedMarker: () => boolean,
): AssistantMessageEventStream {
	const rewrite = (message: AssistantMessage | undefined): AssistantMessage | undefined =>
		rewriteReasoningOnlyMessage(message, observedMarker());
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
 * Wrap every `stream`/`streamSimple` call so a NaN reasoning-only stream that
 * terminates with `stopReason: "length"` (but carries the
 * `nan_truncation.reason: "reasoning_only_stream"` marker) is surfaced as a
 * retryable error instead of a silent waste.
 *
 * The guard chains an `onProviderStreamEvent` hook that detects the raw chunk
 * marker and sets a closure-local flag. The `done` event's `message` and the
 * `result()` promise both receive the rewritten terminal message.
 *
 * Any caller-supplied `onProviderStreamEvent` is preserved and chained **after**
 * the guard's marker detection, so the caller always sees the same chunks it
 * would have without the guard — the guard only reads, never mutates the chunk.
 *
 * @see src/provider-factory.ts for composition
 * @see Issue #21
 */
export function withReasoningOnlyStreamGuard(api: ProviderStreams): ProviderStreams {
	return {
		...api,
		stream: (model, context, options) => {
			let observedMarker = false;
			const withGuardedOptions = { ...((options ?? {}) as Record<string, unknown>) };

			const userOnStreamEvent = withGuardedOptions.onProviderStreamEvent;
			withGuardedOptions.onProviderStreamEvent = async (chunk: unknown, modelHint: unknown) => {
				if (isReasoningOnlyStreamChunk(chunk)) {
					observedMarker = true;
				}
				if (typeof userOnStreamEvent === "function") {
					await userOnStreamEvent(chunk, modelHint);
				}
			};

			const stream = api.stream(model, context, withGuardedOptions as typeof options);
			return rewriteStream(stream, () => observedMarker);
		},
		streamSimple: (model, context, options) => {
			let observedMarker = false;
			const withGuardedOptions = { ...((options ?? {}) as Record<string, unknown>) };

			const userOnStreamEvent = withGuardedOptions.onProviderStreamEvent;
			withGuardedOptions.onProviderStreamEvent = async (chunk: unknown, modelHint: unknown) => {
				if (isReasoningOnlyStreamChunk(chunk)) {
					observedMarker = true;
				}
				if (typeof userOnStreamEvent === "function") {
					await userOnStreamEvent(chunk, modelHint);
				}
			};

			const stream = api.streamSimple(model, context, withGuardedOptions as typeof options);
			return rewriteStream(stream, () => observedMarker);
		},
	};
}
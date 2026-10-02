import { describe, expect, test } from "bun:test";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	ProviderStreams,
} from "@earendil-works/pi-ai";

import {
	REASONING_ONLY_STREAM_REASON,
	NAN_TRUNCATION_MARKER,
	isReasoningOnlyStreamChunk,
	withReasoningOnlyStreamGuard,
} from "../src/reasoning-only-stream-guard.ts";

// ── Helper: build a minimal AssistantMessage ──────────────────────────────

function makeMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		provider: "nan",
		api: "openai-completions",
		model: "qwen3.6",
		content: [],
		usage: {
			input: 1000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		timestamp: 1,
		...overrides,
	} as AssistantMessage;
}

// ── Helper: build a minimal Model with the fields the guard cares about ──

function makeModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "qwen3.6",
		name: "qwen3.6",
		reasoning: [] as string[],
		contextWindow: 262_144,
		maxTokens: 8192,
		...overrides,
	};
}

// ── Unit: isReasoningOnlyStreamChunk ──────────────────────────────────────

describe("isReasoningOnlyStreamChunk", () => {
	test("returns true when chunk is the nan_truncation marker with reasoning_only_stream", () => {
		expect(
			isReasoningOnlyStreamChunk({
				nan_truncation: { reason: "reasoning_only_stream" },
			}),
		).toBe(true);
	});

	test("returns false for other nan_truncation reasons", () => {
		expect(
			isReasoningOnlyStreamChunk({
				nan_truncation: { reason: "some_other_reason" },
			}),
		).toBe(false);
	});

	test("returns false when nan_truncation is absent", () => {
		expect(isReasoningOnlyStreamChunk({ content: "hello" })).toBe(false);
		expect(isReasoningOnlyStreamChunk({ finish_reason: "length" })).toBe(false);
	});

	test("returns false for null, undefined, primitives, and non-objects", () => {
		expect(isReasoningOnlyStreamChunk(null)).toBe(false);
		expect(isReasoningOnlyStreamChunk(undefined)).toBe(false);
		expect(isReasoningOnlyStreamChunk("string")).toBe(false);
		expect(isReasoningOnlyStreamChunk(123)).toBe(false);
		expect(isReasoningOnlyStreamChunk(true)).toBe(false);
		expect(isReasoningOnlyStreamChunk([])).toBe(false);
	});

	test("exports the expected constant values", () => {
		expect(NAN_TRUNCATION_MARKER).toBe("nan_truncation");
		expect(REASONING_ONLY_STREAM_REASON).toBe("reasoning_only_stream");
	});
});

// ── Integration: the guard rewrites terminal "length" when marker is seen ─

describe("withReasoningOnlyStreamGuard — rewritten path", () => {
	test("rewrites stopReason 'length' to 'error' with timeout message when the marker chunk was emitted", async () => {
		const message = makeMessage({
			model: "deepseek-v4-flash",
			stopReason: "length" as AssistantMessage["stopReason"],
		} as never);

		const streamingChunk = {
			nan_truncation: { reason: "reasoning_only_stream" },
		};

		const fakeStream = {
			[Symbol.asyncIterator]: async function* () {
				yield { type: "text", text: "", reason: undefined };
				yield { type: "text", text: "", reason: undefined };
				yield { type: "done" as const, reason: "length", message };
			},
			result: async () => message,
		} as unknown as AssistantMessageEventStream;

		let capturedMarker = false;

		const fakeApi: ProviderStreams = {
			stream: (_model, _context, options) => {
				const userOnPayload = options?.onProviderStreamEvent as ((payload: unknown) => unknown) | undefined;
				if (userOnPayload) {
					userOnPayload(streamingChunk);
					capturedMarker = true;
				}
				return fakeStream;
			},
			streamSimple: () => fakeStream,
		};

		const wrapped = withReasoningOnlyStreamGuard(fakeApi);
		const model = makeModel({ id: "deepseek-v4-flash" });
		const context = { messages: [], systemPrompt: "", tools: [] } as never;

		await wrapped.stream(model as never, context, {});

		expect(capturedMarker).toBe(true);

		// The marker was seen -> rewrite should have occurred.
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("timed out");
		expect(message.errorMessage).toContain("reasoning-only stream guard");
	});

	test("preserves usage and responseId when rewriting", async () => {
		const usageSnapshot = { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1000 };
		const message = makeMessage({
			model: "glm5.3-flash",
			responseId: "resp-456",
			stopReason: "length" as AssistantMessage["stopReason"],
			usage: { ...usageSnapshot, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		} as never);

		const streamingChunk = { nan_truncation: { reason: "reasoning_only_stream" } };

		const fakeStream = {
			[Symbol.asyncIterator]: async function* () {
				yield { type: "done" as const, reason: "length", message };
			},
			result: async () => message,
		} as unknown as AssistantMessageEventStream;

		let capturedMarker = false;

		const fakeApi: ProviderStreams = {
			stream: (_model, _context, options) => {
				const userOnPayload = options?.onProviderStreamEvent as ((payload: unknown) => unknown) | undefined;
				if (userOnPayload) {
					userOnPayload(streamingChunk);
					capturedMarker = true;
				}
				return fakeStream;
			},
			streamSimple: () => fakeStream,
		};

		const wrapped = withReasoningOnlyStreamGuard(fakeApi);
		const model = makeModel({ id: "glm5.3-flash" });
		const context = { messages: [], systemPrompt: "", tools: [] } as never;

		await wrapped.stream(model as never, context, {});

		expect(capturedMarker).toBe(true);

		// Rewritten message should keep usage and responseId.
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("timed out");
		expect(message.usage).toEqual(expect.objectContaining(usageSnapshot));
		expect(message.responseId).toBe("resp-456");
	});

	test("result() also returns the rewritten message", async () => {
		const message = makeMessage({
			model: "qwen3.6",
			stopReason: "length" as AssistantMessage["stopReason"],
		} as never);

		const streamingChunk = { nan_truncation: { reason: "reasoning_only_stream" } };

		const fakeStream = {
			[Symbol.asyncIterator]: async function* () {
				yield { type: "done" as const, reason: "length", message };
			},
			result: async () => message,
		} as unknown as AssistantMessageEventStream;

		let capturedMarker = false;

		const fakeApi: ProviderStreams = {
			stream: (_model, _context, options) => {
				const userOnPayload = options?.onProviderStreamEvent as ((payload: unknown) => unknown) | undefined;
				if (userOnPayload) {
					userOnPayload(streamingChunk);
					capturedMarker = true;
				}
				return fakeStream;
			},
			streamSimple: () => fakeStream,
		};

		const wrapped = withReasoningOnlyStreamGuard(fakeApi);
		const model = makeModel({ id: "qwen3.6" });
		const context = { messages: [], systemPrompt: "", tools: [] } as never;

		const resultStream = wrapped.stream(model as never, context, {});

		expect(capturedMarker).toBe(true);

		// result() should also see the rewritten message (same object).
		const final = await resultStream.result();
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toContain("timed out");
	});

	test("rewrites the error event in the async iterator too", async () => {
		const error = makeMessage({
			model: "mimo-v2.6-flash",
			stopReason: "length" as AssistantMessage["stopReason"],
		} as never);

		const streamingChunk = { nan_truncation: { reason: "reasoning_only_stream" } };

		const fakeStream = {
			[Symbol.asyncIterator]: async function* () {
				yield { type: "error" as const, reason: "error", error };
			},
			result: async () => error,
		} as unknown as AssistantMessageEventStream;

		let capturedMarker = false;

		const fakeApi: ProviderStreams = {
			stream: (_model, _context, options) => {
				const userOnPayload = options?.onProviderStreamEvent as ((payload: unknown) => unknown) | undefined;
				if (userOnPayload) {
					userOnPayload(streamingChunk);
					capturedMarker = true;
				}
				return fakeStream;
			},
			streamSimple: () => fakeStream,
		};

		const wrapped = withReasoningOnlyStreamGuard(fakeApi);
		const model = makeModel({ id: "mimo-v2.6-flash" });
		const context = { messages: [], systemPrompt: "", tools: [] } as never;

		const resultStream = wrapped.stream(model as never, context, {});

		expect(capturedMarker).toBe(true);

		// Consume the iterator - the error event should be rewritten.
		for await (const event of resultStream) {
			if ((event as { type: string }).type === "error") {
				const err = (event as { error: AssistantMessage }).error;
				expect(err.stopReason).toBe("error");
				expect(err.errorMessage).toContain("timed out");
			}
		}
	});
});

// ── Negative: no marker -> no rewrite ──────────────────────────────────────

describe("withReasoningOnlyStreamGuard — negative: no rewrite without marker", () => {
	test("a real length cut (no nan_truncation) stays untouched", async () => {
		const message = makeMessage({
			model: "qwen3.6",
			content: [{ type: "text", text: "Hello, " }],
			stopReason: "length" as AssistantMessage["stopReason"],
		} as never);

		const fakeStream = {
			[Symbol.asyncIterator]: async function* () {
				yield { type: "text", text: "Hello, ", reason: undefined };
				yield { type: "done" as const, reason: "length", message };
			},
			result: async () => message,
		} as unknown as AssistantMessageEventStream;

		const fakeApi: ProviderStreams = {
			stream: () => fakeStream,
			streamSimple: () => fakeStream,
		};

		const wrapped = withReasoningOnlyStreamGuard(fakeApi);
		const model = makeModel({ id: "qwen3.6" });
		const context = { messages: [], systemPrompt: "", tools: [] } as never;

		await wrapped.stream(model as never, context, {});

		// The message should be untouched.
		expect(message.stopReason).toBe("length");
		expect(message.errorMessage).toBeUndefined();
	});

	test("streamSimple without the marker is also untouched", async () => {
		const message = makeMessage({
			model: "deepseek-v4-flash",
			stopReason: "length" as AssistantMessage["stopReason"],
		} as never);

		const fakeStream = {
			[Symbol.asyncIterator]: async function* () {
				yield { type: "done" as const, reason: "length", message };
			},
			result: async () => message,
		} as unknown as AssistantMessageEventStream;

		const fakeApi: ProviderStreams = {
			stream: () => fakeStream,
			streamSimple: () => fakeStream,
		};

		const wrapped = withReasoningOnlyStreamGuard(fakeApi);
		const model = makeModel({ id: "deepseek-v4-flash" });
		const context = { messages: [], systemPrompt: "", tools: [] } as never;

		await wrapped.streamSimple(model as never, context, {});

		expect(message.stopReason).toBe("length");
	});

	test("stopReason 'stop' is never rewritten", async () => {
		const message = makeMessage({
			model: "gemma4",
			content: [{ type: "text", text: "Done." }],
			stopReason: "stop" as AssistantMessage["stopReason"],
		} as never);

		const streamingChunk = { nan_truncation: { reason: "reasoning_only_stream" } };

		const fakeStream = {
			[Symbol.asyncIterator]: async function* () {
				yield { type: "done" as const, reason: "stop", message };
			},
			result: async () => message,
		} as unknown as AssistantMessageEventStream;

		const fakeApi: ProviderStreams = {
			stream: (_model, _context, options) => {
				const userOnPayload = options?.onProviderStreamEvent as ((payload: unknown) => unknown) | undefined;
				if (userOnPayload) {
					userOnPayload(streamingChunk);
				}
				return fakeStream;
			},
			streamSimple: () => fakeStream,
		};

		const wrapped = withReasoningOnlyStreamGuard(fakeApi);
		const model = makeModel({ id: "gemma4" });
		const context = { messages: [], systemPrompt: "", tools: [] } as never;

		await wrapped.stream(model as never, context, {});

		// Even WITH the marker, stopReason "stop" is never rewritten.
		expect(message.stopReason).toBe("stop");
	});
});

// ── Options chaining: caller hook still fires ────────────────────────────

describe("withReasoningOnlyStreamGuard — options chaining", () => {
	test("a caller-provided onProviderStreamEvent still gets called via the guard", async () => {
		let callerCalled = false;
		let callerPayload: unknown = null;

		const message = makeMessage({
			model: "qwen3.6",
			stopReason: "length" as AssistantMessage["stopReason"],
		} as never);

		const streamingChunk = { nan_truncation: { reason: "reasoning_only_stream" } };

		const fakeStream = {
			[Symbol.asyncIterator]: async function* () {
				yield { type: "done" as const, reason: "length", message };
			},
			result: async () => message,
		} as unknown as AssistantMessageEventStream;

		const fakeApi: ProviderStreams = {
			stream: (_model, _context, options) => {
				// The guard has already wrapped options.onProviderStreamEvent.  pi-ai calls
				// the user's onProviderStreamEvent with each chunk.  We simulate that by
				// calling it ourselves here with the marker chunk.
				const userOnPayload = options?.onProviderStreamEvent as ((payload: unknown) => unknown) | undefined;
				if (userOnPayload) {
					userOnPayload(streamingChunk);
					callerCalled = true;
					callerPayload = streamingChunk;
				}
				return fakeStream;
			},
			streamSimple: () => fakeStream,
		};

		const wrapped = withReasoningOnlyStreamGuard(fakeApi);
		const model = makeModel({ id: "qwen3.6" });
		const context = { messages: [], systemPrompt: "", tools: [] } as never;

		await wrapped.stream(model as never, context, {});

		// The caller's hook must have been invoked.
		expect(callerCalled).toBe(true);
		expect(callerPayload).toEqual(streamingChunk);
	});
});

/**
 * ACCEPTANCE TESTS — issue #18
 * "Large COLD prompts (≳1 MB body / ~220k tokens) to NaN hang past Cloudflare's
 * 120s Proxy Read Timeout → HTTP 524 origin_response_timeout, wedging the session."
 *
 * https://github.com/gtrabanco/pi-nan-provider/issues/18
 *
 * The bug: a cold request with a large body (~220k+ tokens) hits Cloudflare's
 * 120 s Proxy Read Timeout. The gateway answers
 *   HTTP 524 `{"status":524,"error_name":"origin_response_timeout","retryable":true,...}`
 * (sometimes a Cloudflare HTML error page for even larger bodies). pi-ai's
 * streaming proxy bubbles this as an AssistantMessage with stopReason "error"
 * and an errorMessage that starts with `524: {"status":524,...}`.
 * pi-ai classifies 524 as RETRYABLE (retrying an identical cold payload always
 * fails) and its `isContextOverflow()` matches nothing, so the session wedges.
 *
 * The fix mirrors the existing issue #3 classifier: after the request goes out
 * and the gateway answers, if the terminal error is a 524 AND the estimated
 * request tokens exceed a cold-cache ceiling, rewrite the error into a
 * pi-recognizable overflow message so pi compacts and retries.
 *
 * A conservative ceiling (200k tokens) was chosen so the working cold measurement
 * at 208,036 tokens is NOT affected, while ~220k and larger cold requests hit the
 * rewrite path.
 */

import { describe, expect, test } from "bun:test";
import { isContextOverflow, normalizeContext } from "@earendil-works/pi-ai";
import {
	classifyContextOverflowError,
	classifyStreamContextOverflow,
	estimateRequestTokens,
	ESTIMATED_CHARS_PER_TOKEN,
	isGenericNanBadRequest,
	NAN_COLD_CACHE_CEILING_TOKENS,
	withContextOverflowClassification,
} from "../src/context-overflow-classifier.ts";
import type { AssistantMessage, AssistantMessageEventStream, ProviderStreams } from "@earendil-works/pi-ai";

/**
 * A Cloudflare 524 origin_response_timeout body as pi-ai's provider error
 * formatter produces it: the numeric status code followed by the JSON body.
 */
function cloudflare524MessageBody(): string {
	return JSON.stringify({
		status: 524,
		error_name: "origin_response_timeout",
		retryable: true,
		retry_after: 120,
		message: "A timeout occurred",
	});
}

/**
 * A Cloudflare HTML-page error body for 524 (occurs for very large bodies).
 */
function cloudflare524HtmlMessage(): string {
	return '<!DOCTYPE html><html><head><title>Error 524</title></head>' +
		'<body><h1>Error 524</h1><p>A timeout occurred</p></body></html>';
}

function errorMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		provider: "nan",
		api: "openai-completions",
		model: "qwen3.6",
		content: [],
		usage: {
			input: 300_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 300_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "524: " + cloudflare524MessageBody(),
		timestamp: 1,
		...overrides,
	} as AssistantMessage;
}

const WINDOW = 262_144; // qwen3.6 context window

describe("issue #18 — COLD-cache 524 classifier", () => {
	test("NAN_COLD_CACHE_CEILING_TOKENS is a documented constant", () => {
		expect(NAN_COLD_CACHE_CEILING_TOKENS).toBe(200_000);
		// Must be exported as a plain number, not a function.
		expect(typeof NAN_COLD_CACHE_CEILING_TOKENS).toBe("number");
	});

	test("a 524 origin_response_timeout on an over-ceiling request is reclassified as overflow", () => {
		// Estimated tokens exceed both the model's window AND the cold-cache ceiling.
		const message = errorMessage();
		const estimated = WINDOW + 10_000; // clearly over the 200k ceiling too
		const result = classifyContextOverflowError(message, { contextWindow: WINDOW }, estimated);
		expect(result).toBe(message);

		// Must match pi-ai's overflow patterns so pi can compact.
		expect(isContextOverflow(message, WINDOW)).toBe(true);
		// The original provider text (524 body) must be preserved in the rewritten message.
		expect(message.errorMessage).toContain("524");
		expect(message.errorMessage).toContain("origin_response_timeout");
		// Must mention the ceiling (200000) as the limit, not the model window.
		expect(message.errorMessage).toContain("200000");
		// Must mention the declared window.
		expect(message.errorMessage).toContain("declared model window");
		// Must NOT falsely claim the estimate exceeds the model window.
		expect(message.errorMessage).not.toContain("maximum context length of " + WINDOW);
	});

	test("a 524 on a below-ceiling request is left untouched (transient timeout stays transient)", () => {
		// Estimated tokens are below the cold-cache ceiling — this is a genuine transient
		// timeout on a small request, must NOT be mislabelled as overflow.
		const message = errorMessage();
		const before = message.errorMessage;
		// 100 chars is ~29 tokens, well below the 200k ceiling.
		classifyContextOverflowError(message, { contextWindow: WINDOW }, 29);
		expect(message.errorMessage).toBe(before);
		expect(isContextOverflow(message, WINDOW)).toBe(false);
	});

	test("a Cloudflare HTML-page 524 on an over-ceiling request is also rewritten", () => {
		const message = {
			role: "assistant" as const,
			provider: "nan" as const,
			api: "openai-completions" as const,
			model: "qwen3.6" as const,
			content: [] as never[],
			usage: {
				input: 300_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 300_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "524: " + cloudflare524HtmlMessage(),
			timestamp: 1,
		} as AssistantMessage;

		classifyContextOverflowError(message, { contextWindow: WINDOW }, WINDOW + 10_000);
		expect(isContextOverflow(message, WINDOW)).toBe(true);
		// Must mention 524 or "timeout" since the original body had that.
		expect(message.errorMessage).toContain("524");
	});

	test("the 400 path is unchanged — no regression", () => {
		const GENERIC_400 = "Invalid request. Check your request parameters.";
		const message = {
			role: "assistant" as const,
			provider: "nan" as const,
			api: "openai-completions" as const,
			model: "qwen3.6" as const,
			content: [] as never[],
			usage: {
				input: 300_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 300_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "400: {\"message\":\"" + GENERIC_400 + "\",\"type\":\"invalid_request_error\"}",
			timestamp: 1,
		} as AssistantMessage;

		classifyContextOverflowError(message, { contextWindow: WINDOW }, WINDOW + 10_000);
		expect(isContextOverflow(message, WINDOW)).toBe(true);
		expect(message.errorMessage).toContain(GENERIC_400);
	});

	test("estimated tokens between contextWindow and ceiling: still rewrites if over ceiling", () => {
		// With WINDOW=262144, estimated=300k > contextWindow(262k) > ceiling(200k) → rewrite.
		// 400 branch fires on window; 524 would also fire but 400 takes first branch.
		const message = errorMessage();
		classifyContextOverflowError(message, { contextWindow: 150_000 }, 200_001);
		expect(isContextOverflow(message, 150_000)).toBe(true);
	});

	test("estimated tokens between ceiling and contextWindow: 524 IS reclassified", () => {
		// 524 keys on the ceiling ONLY, not the model window. A 524 with
		// estimated=210k tokens and contextWindow=262k IS reclassified because
		// 210k > 200k ceiling. This was the bug (issue #18): the global guard
		// blocked the 524 branch when estimated < contextWindow.
		const message = errorMessage();
		// 210k is > ceiling (200k) but < WINDOW (262k) — 524 must still rewrite.
		classifyContextOverflowError(message, { contextWindow: WINDOW }, 210_000);
		expect(isContextOverflow(message, WINDOW)).toBe(true);
		expect(message.errorMessage).toContain("524");
		expect(message.errorMessage).toContain("origin_response_timeout");
	});

	test("524 rewritten message does not falsely claim exceeding the model window", () => {
		// When estimated tokens are below the model's contextWindow but above the
		// ceiling, the 524 rewrite must NOT say the request exceeds the model's
		// window — it should mention the ceiling and the declared window separately.
		// Use a 1M-window model (like glm5.3-flash / deepseek-v4-flash).
		const message = errorMessage();
		const bigWindow = 1_000_000;
		// 300k is well below 1M window but above 200k ceiling.
		classifyContextOverflowError(message, { contextWindow: bigWindow }, 300_000);
		expect(isContextOverflow(message, bigWindow)).toBe(true);
		// Must mention the ceiling (200000) as the limit, not the model window.
		expect(message.errorMessage).toContain("200000");
		// Must mention the declared model window as context, not as the limit.
		expect(message.errorMessage).toContain("declared model window: 1000000");
		// Must NOT claim the estimate exceeds the 1M window.
		expect(message.errorMessage).not.toContain("maximum context length of 1000000");
		// Must match pi-ai's overflow pattern.
		expect(isContextOverflow(message, bigWindow)).toBe(true);
	});

	test("524 on a non-error stopReason is untouched", () => {
		const message = errorMessage({ stopReason: "stop" as const });
		const before = message.errorMessage;
		classifyContextOverflowError(message, { contextWindow: WINDOW }, WINDOW + 10_000);
		expect(message.errorMessage).toBe(before);
	});

	test("a 524 that lacks origin_response_timeout markers is left alone", () => {
		// A plain 524 with no origin_response_timeout or "A timeout occurred" / "Error 524" markers.
		const message = {
			role: "assistant" as const,
			provider: "nan" as const,
			api: "openai-completions" as const,
			model: "qwen3.6" as const,
			content: [] as never[],
			usage: {
				input: 300_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 300_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "524: some other 524 thing",
			timestamp: 1,
		} as AssistantMessage;
		const before = message.errorMessage;
		classifyContextOverflowError(message, { contextWindow: WINDOW }, WINDOW + 10_000);
		expect(message.errorMessage).toBe(before);
	});
});

describe("issue #18 — stream proxy flows the 524 rewrite through error+result()", async () => {
	test("classifyStreamContextOverflow rewrites a 524 error event and result() on an over-ceiling request", async () => {
		const message = errorMessage();
		const stream = {
			result: async () => message,
			[Symbol.asyncIterator]: async function* () {
				yield { type: "error", reason: "error", error: message };
			},
		} as unknown as AssistantMessageEventStream;

		const wrapped = classifyStreamContextOverflow(stream, { contextWindow: WINDOW }, WINDOW + 10_000);
		for await (const event of wrapped) {
			expect((event as { type: string }).type).toBe("error");
		}
		const final = await wrapped.result();
		expect(isContextOverflow(final, WINDOW)).toBe(true);
		expect(final.errorMessage).toContain("524");
		expect(final.errorMessage).toContain("origin_response_timeout");
	});

	test("a 524 below the ceiling does NOT get rewritten through the stream proxy", async () => {
		const message = errorMessage();
		const before = message.errorMessage;
		const stream = {
			result: async () => message,
			[Symbol.asyncIterator]: async function* () {
				yield { type: "error", reason: "error", error: message };
			},
		} as unknown as AssistantMessageEventStream;

		const wrapped = classifyStreamContextOverflow(stream, { contextWindow: WINDOW }, 29);
		for await (const event of wrapped) {
			expect((event as { type: string }).type).toBe("error");
		}
		const final = await wrapped.result();
		expect(final.errorMessage).toBe(before);
		expect(isContextOverflow(final, WINDOW)).toBe(false);
	});
});

describe("issue #18 — withContextOverflowClassification wiring", () => {
	test("the structural wrapper preserves the api surface", () => {
		const calls: string[] = [];
		const fake = {
			stream: () => {
				calls.push("stream");
				return {} as AssistantMessageEventStream;
			},
			streamSimple: () => {
				calls.push("streamSimple");
				return {} as AssistantMessageEventStream;
			},
			fetchDeferred: () => {
				calls.push("fetchDeferred");
				return {} as AssistantMessageEventStream;
			},
		} as unknown as ProviderStreams;
		const wrapped = withContextOverflowClassification(fake);
		expect(typeof wrapped.stream).toBe("function");
		expect(typeof wrapped.streamSimple).toBe("function");
		expect(typeof wrapped.fetchDeferred).toBe("function");
	});
});
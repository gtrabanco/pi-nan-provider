import { describe, expect, test } from "bun:test";
import { isContextOverflow } from "@earendil-works/pi-ai";
import {
	classifyContextOverflowError,
	classifyStreamContextOverflow,
	estimateRequestTokens,
	ESTIMATED_CHARS_PER_TOKEN,
	isGenericNanBadRequest,
	NAN_GENERIC_BAD_REQUEST,
	withContextOverflowClassification,
} from "../src/context-overflow-classifier.ts";
import type { AssistantMessage, AssistantMessageEventStream, ProviderStreams } from "@earendil-works/pi-ai";

const GENERIC_400_WRAPPED = `400: {"message":"${NAN_GENERIC_BAD_REQUEST}","type":"invalid_request_error"}`;

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
		errorMessage: GENERIC_400_WRAPPED,
		timestamp: 1,
		...overrides,
	} as AssistantMessage;
}

const WINDOW = 262_144;

describe("estimateRequestTokens", () => {
	test("counts system prompt, tool schemas and message bodies at the documented ratio", () => {
		const systemPrompt = "s".repeat(3_470);
		const messages = [{ role: "user", content: "m".repeat(3_470) }];
		const tools = [{ name: "bash", description: "t".repeat(3_470) }];
		const chars =
			systemPrompt.length + JSON.stringify(messages).length + JSON.stringify(tools).length;
		expect(estimateRequestTokens({ systemPrompt, messages, tools } as never)).toBe(
			Math.ceil(chars / ESTIMATED_CHARS_PER_TOKEN),
		);
		expect(ESTIMATED_CHARS_PER_TOKEN).toBe(3.47);
	});

	test("returns 0 for an empty or unserializable context instead of over-claiming", () => {
		expect(estimateRequestTokens(undefined)).toBe(0);
		expect(estimateRequestTokens({ systemPrompt: "", messages: [], tools: [] })).toBe(0);
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(estimateRequestTokens({ messages: [circular] as never })).toBe(0);
	});
});

describe("isGenericNanBadRequest", () => {
	test("matches NaN's generic 400 with or without pi-ai's status wrapper", () => {
		expect(isGenericNanBadRequest({ errorMessage: NAN_GENERIC_BAD_REQUEST })).toBe(true);
		expect(isGenericNanBadRequest({ errorMessage: GENERIC_400_WRAPPED })).toBe(true);
	});

	test("does not match unrelated errors or a missing message", () => {
		expect(isGenericNanBadRequest({ errorMessage: "Stream ended without finish_reason" })).toBe(false);
		expect(isGenericNanBadRequest({ errorMessage: "" })).toBe(false);
		expect(isGenericNanBadRequest(undefined)).toBe(false);
	});
});

describe("classifyContextOverflowError", () => {
	test("reclassifies an over-window generic 400 into a pi-recognizable context overflow", () => {
		const message = errorMessage();
		const result = classifyContextOverflowError(message, { contextWindow: WINDOW }, WINDOW + 1);
		expect(result).toBe(message);
		expect(isContextOverflow(message, WINDOW)).toBe(true);
		// The original provider text is preserved, never silently discarded.
		expect(message.errorMessage).toContain(NAN_GENERIC_BAD_REQUEST);
	});

	test("leaves a generic 400 on a within-window request untouched", () => {
		const message = errorMessage();
		const before = message.errorMessage;
		classifyContextOverflowError(message, { contextWindow: WINDOW }, WINDOW);
		expect(message.errorMessage).toBe(before);
		expect(isContextOverflow(message, WINDOW)).toBe(false);
	});

	test("leaves non-error stops and non-generic errors untouched", () => {
		const stop = errorMessage({
			stopReason: "stop" as AssistantMessage["stopReason"],
			usage: { ...errorMessage().usage, input: 0, totalTokens: 0 },
		});
		classifyContextOverflowError(stop, { contextWindow: WINDOW }, WINDOW + 1);
		expect(isContextOverflow(stop, WINDOW)).toBe(false);

		const unrelated = errorMessage({ errorMessage: "400: rate limit exceeded" });
		classifyContextOverflowError(unrelated, { contextWindow: WINDOW }, WINDOW + 1);
		expect(unrelated.errorMessage).toBe("400: rate limit exceeded");
		expect(isContextOverflow(unrelated, WINDOW)).toBe(false);
	});

	test("never reclassifies without a finite positive context window", () => {
		for (const model of [undefined, {}, { contextWindow: 0 }, { contextWindow: Number.NaN }]) {
			const message = errorMessage();
			const before = message.errorMessage;
			classifyContextOverflowError(message, model as never, WINDOW + 1);
			expect(message.errorMessage).toBe(before);
			expect(isContextOverflow(message, WINDOW)).toBe(false);
		}
	});
});

describe("classifyStreamContextOverflow / withContextOverflowClassification", () => {
	test("the structural wrapper preserves the api surface and only names classification for stream calls", () => {
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

	test("classifyStreamContextOverflow rewrites the terminal error event and result()", async () => {
		const message = errorMessage();
		const stream = {
			result: async () => message,
			[Symbol.asyncIterator]: async function* () {
				yield { type: "error", reason: "error", error: message };
			},
		} as unknown as AssistantMessageEventStream;

		const wrapped = classifyStreamContextOverflow(stream, { contextWindow: WINDOW }, WINDOW + 1);
		for await (const event of wrapped) {
			expect((event as { type: string }).type).toBe("error");
		}
		const final = await wrapped.result();
		expect(isContextOverflow(final, WINDOW)).toBe(true);
	});
});

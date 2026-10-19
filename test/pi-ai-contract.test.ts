/**
 * CONTRACT TESTS — pi-ai behaviors this package's correctness depends on.
 *
 * These pin the upstream behaviors recorded as "Verified API facts" in
 * AGENTS.md. When one fails, an upstream pi-ai release changed behavior the
 * package silently relies on — re-verify against the new release before
 * touching package code:
 *
 *  1. `transformMessages` DROPS cross-model `thinking` blocks (pi-ai 1.3.0,
 *     upstream fix for https://github.com/gtrabanco/pi-nan-provider/issues/3).
 *     The version-gated cross-model guard only targets hosts older than 1.3.0
 *     because of this exact contract.
 *  2. A stream chunk carrying reasoning AND answer together (LiteLLM-style,
 *     #10926) yields a thinking block that PRECEDES the text block — otherwise
 *     NaN users see the model's reasoning pasted after its answer.
 *
 * The other two load-bearing contracts already have dedicated wire-level
 * tests: `stream_options.include_usage` (test/issue-7-streaming-usage-default.test.ts)
 * and `thinkingLevelMap.off` → `reasoning_effort` (test/issue-16-thinking-level-map.test.ts).
 */

import { describe, expect, test } from "bun:test";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { normalizeContext } from "@earendil-works/pi-ai";
import { baselineModels } from "../src/fetch-models.ts";
import { createNanCompatibleProvider } from "../src/provider-factory.ts";
import { NAN_PROVIDER } from "../src/providers.ts";

const SOURCE = { providerId: "nan", baseUrl: NAN_PROVIDER.baseUrl } as const;

function modelFor(id: string): ReturnType<typeof baselineModels>[number] {
	const model = baselineModels(SOURCE).find((candidate) => candidate.id === id);
	if (!model) throw new Error(`catalog model not found: ${id}`);
	return model;
}

const TARGET = modelFor("qwen3.6");
const OTHER = modelFor("glm5.3-flash");

interface TestMessage {
	role: string;
	provider?: string;
	api?: string;
	model?: string;
	content?: Array<Record<string, unknown>>;
	[key: string]: unknown;
}

describe("contract: transformMessages drops cross-model thinking (pi-ai >= 1.3.0, issue #3 upstream fix)", () => {
	test("a previous model's thinking block is removed when replayed into another model", () => {
		const messages: TestMessage[] = [
			{
				role: "assistant",
				provider: "nan",
				api: "openai-completions",
				model: OTHER.id,
				content: [
					{ type: "thinking", thinking: "long reasoning trace" },
					{ type: "text", text: "the answer" },
				],
			},
			{ role: "user", content: [{ type: "text", text: "continue" }] },
		];
		const result = transformMessages(messages as never, TARGET as never) as unknown as TestMessage[];
		const first = result[0]!;
		expect(first.content?.map((block) => block.type)).toEqual(["text"]);
		expect((first.content?.[0] as { text?: string }).text).toBe("the answer");
	});

	test("same-model thinking survives replay (signatures and continuity depend on it)", () => {
		const messages: TestMessage[] = [
			{
				role: "assistant",
				provider: "nan",
				api: "openai-completions",
				model: TARGET.id,
				content: [
					{ type: "thinking", thinking: "my own reasoning" },
					{ type: "text", text: "the answer" },
				],
			},
		];
		const result = transformMessages(messages as never, TARGET as never) as unknown as TestMessage[];
		expect(result[0]!.content?.map((block) => block.type)).toEqual(["thinking", "text"]);
	});

	test("cross-model thinking is dropped even when signed or redacted", () => {
		// pi 1.3.0 semantics: the isSameModel check fires BEFORE the signed/redacted
		// preservation branch, so a foreign model's opaque blocks are dropped too.
		const messages: TestMessage[] = [
			{
				role: "assistant",
				provider: "nan",
				api: "openai-completions",
				model: OTHER.id,
				content: [
					{ type: "thinking", thinking: "opaque", thinkingSignature: "sig" },
					{ type: "thinking", thinking: "redacted", redacted: true },
					{ type: "text", text: "the answer" },
				],
			},
		];
		const result = transformMessages(messages as never, TARGET as never) as unknown as TestMessage[];
		expect(result[0]!.content?.map((block) => block.type)).toEqual(["text"]);
	});
});

/** An SSE stream whose FIRST content delta carries reasoning and answer together. */
function sameChunkSse(reasoning: string, answer: string): Response {
	const encoder = new TextEncoder();
	const chunk = {
		id: "1",
		object: "chat.completion.chunk",
		created: 1,
		model: TARGET.id,
		choices: [
			{
				index: 0,
				delta: { role: "assistant", reasoning_content: reasoning, content: answer },
			},
		],
	};
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
				controller.enqueue(
					encoder.encode(
						`data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"${TARGET.id}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
					),
				);
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

describe("contract: reasoning + content in the same chunk stays ordered thinking-then-text (upstream #10926)", () => {
	test("LiteLLM-style aggregated delta produces a thinking block BEFORE the text block", async () => {
		const provider = await createNanCompatibleProvider(NAN_PROVIDER);
		const messages: TestMessage[] = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
		];
		const stream = provider.stream(
			TARGET,
			normalizeContext({ messages: messages as never }),
			{
				apiKey: "sk-test",
				fetch: (async () => sameChunkSse("why I think so", "the visible answer")) as unknown as typeof fetch,
			},
		);
		const final = (await stream.result()) as unknown as {
			content?: Array<{ type: string; thinking?: string; text?: string }>;
		};

		const blocks = final.content ?? [];
		const thinkingBlock = blocks.find((block) => block.type === "thinking");
		const textBlock = blocks.find((block) => block.type === "text");
		expect(thinkingBlock).toBeDefined();
		expect(textBlock).toBeDefined();
		expect(blocks.indexOf(textBlock!)).toBeGreaterThan(blocks.indexOf(thinkingBlock!));
		expect(thinkingBlock!.thinking).toBe("why I think so");
		expect(textBlock!.text).toBe("the visible answer");
	});
});

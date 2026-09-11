import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	crossModelThinkingGuardEnabled,
	NAN_THINKING_GUARD_ENV,
	stripCrossModelThinking,
} from "../src/cross-model-thinking-guard.ts";
import { registerCrossModelThinkingGuard } from "../src/index.ts";
import { PROVIDERS } from "../src/providers.ts";

const NAN_IDS = new Set(PROVIDERS.map((p) => p.id));
const TARGET = { provider: "nan", api: "openai-completions", id: "qwen3.6" };
const OPTIONS = { providerIds: NAN_IDS };

interface TestBlock {
	type?: string;
	thinking?: unknown;
	thinkingSignature?: string;
	text?: string;
	id?: string;
	name?: string;
	redacted?: boolean;
	[key: string]: unknown;
}

interface TestMessage {
	role?: string;
	provider?: string;
	api?: string;
	model?: string;
	content?: TestBlock[];
	[key: string]: unknown;
}

function assistant(overrides: Partial<TestMessage> = {}): TestMessage {
	return {
		role: "assistant",
		provider: "nan",
		api: "openai-completions",
		// A neutral SOURCE model: the guard drops reasoning from any model that is
		// not the target. No model is forced or special-cased.
		model: "other-model",
		content: [{ type: "thinking", thinking: "x".repeat(100), thinkingSignature: "sig" }],
		...overrides,
	};
}

function typesOf(message: TestMessage | undefined): string[] {
	return (message?.content ?? []).map((block) => block.type ?? "?");
}

describe("stripCrossModelThinking", () => {
	test("drops a cross-model thinking block", () => {
		const result = stripCrossModelThinking([assistant()], TARGET, OPTIONS);
		expect(typesOf(result[0])).toEqual([]);
	});

	test("preserves sibling text and tool-call blocks", () => {
		const message = assistant({
			content: [
				{ type: "thinking", thinking: "y".repeat(50), thinkingSignature: "keep-me" },
				{ type: "text", text: "answer" },
				{ type: "toolCall", id: "call_1", name: "bash", arguments: {} },
			],
		});
		const content = stripCrossModelThinking([message], TARGET, OPTIONS)[0]!.content!;
		expect(content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "toolCall", id: "call_1", name: "bash", arguments: {} },
		]);
	});

	test("keeps tool calls when the message was thinking + tool calls only", () => {
		const message = assistant({
			content: [
				{ type: "thinking", thinking: "lots of reasoning" },
				{ type: "toolCall", id: "call_9", name: "bash", arguments: { command: "ls" } },
			],
		});
		const result = stripCrossModelThinking([message], TARGET, OPTIONS)[0]!;
		expect(typesOf(result)).toEqual(["toolCall"]);
	});

	test("drops every thinking block when several are present", () => {
		const message = assistant({
			content: [
				{ type: "thinking", thinking: "a" },
				{ type: "text", text: "mid" },
				{ type: "thinking", thinking: "b" },
			],
		});
		expect(typesOf(stripCrossModelThinking([message], TARGET, OPTIONS)[0])).toEqual(["text"]);
	});

	test("never mutates the input message or its blocks", () => {
		const message = assistant();
		stripCrossModelThinking([message], TARGET, OPTIONS);
		expect(message.content).toEqual([{ type: "thinking", thinking: "x".repeat(100), thinkingSignature: "sig" }]);
	});

	test("returns the same array reference when there is nothing to drop", () => {
		const messages = [assistant({ content: [{ type: "text", text: "no reasoning here" }] })];
		expect(stripCrossModelThinking(messages, TARGET, OPTIONS)).toBe(messages);
	});

	test("leaves same-model reasoning untouched", () => {
		const messages = [assistant({ model: "qwen3.6" })];
		expect(stripCrossModelThinking(messages, TARGET, OPTIONS)).toBe(messages);
	});

	test("drops reasoning from ANY previous model — no model is special-cased", () => {
		for (const source of ["deepseek-v4-flash", "mimo-v2.5", "gemma4", "guessed-model", "", undefined]) {
			expect(typesOf(stripCrossModelThinking([assistant({ model: source })], TARGET, OPTIONS)[0])).toEqual([]);
		}
	});

	test("treats an assistant message with no model metadata as cross-model", () => {
		const message: TestMessage = { role: "assistant", content: [{ type: "thinking", thinking: "z" }] };
		expect(typesOf(stripCrossModelThinking([message], TARGET, OPTIONS)[0])).toEqual([]);
	});

	test("ignores a target whose provider is not registered by this package", () => {
		const messages = [assistant()];
		expect(stripCrossModelThinking(messages, { provider: "anthropic", api: "anthropic-messages", id: "claude" }, OPTIONS)).toBe(messages);
	});

	test("ignores an undefined target (model not resolved yet)", () => {
		const messages = [assistant()];
		expect(stripCrossModelThinking(messages, undefined, OPTIONS)).toBe(messages);
	});

	test("leaves non-assistant messages untouched", () => {
		const messages = [{ role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: "x".repeat(100) }] }];
		expect(stripCrossModelThinking(messages, TARGET, OPTIONS)).toBe(messages);
	});

	test("measured effect: removes 30%+ of a realistic multi-message session", () => {
		// Mirrors the observed composition: reasoning is a large share of the context.
		const messages = Array.from({ length: 40 }, (_, i) =>
			assistant({
				model: i % 2 === 0 ? "glm5.3-flash" : "deepseek-v4-flash",
				content: [
					{ type: "thinking", thinking: "r".repeat(9_000) },
					{ type: "text", text: "answer ".repeat(200) },
					{ type: "toolCall", id: `call_${i}`, name: "bash", arguments: {} },
				],
			}),
		);
		const before = JSON.stringify(messages).length;
		const after = JSON.stringify(stripCrossModelThinking(messages, TARGET, OPTIONS)).length;
		const thinkingChars = 40 * 9_000;
		expect(after).toBeLessThan(before - thinkingChars + 200);
	});
});

describe("crossModelThinkingGuardEnabled", () => {
	test("is enabled by default", () => {
		expect(crossModelThinkingGuardEnabled({})).toBe(true);
		expect(crossModelThinkingGuardEnabled({ [NAN_THINKING_GUARD_ENV]: "1" })).toBe(true);
	});

	test("can be explicitly disabled", () => {
		for (const value of ["0", "false", "FALSE", "no", "off", " off "]) {
			expect(crossModelThinkingGuardEnabled({ [NAN_THINKING_GUARD_ENV]: value })).toBe(false);
		}
	});
});

describe("registerCrossModelThinkingGuard (extension wiring)", () => {
	type Handler = (event: { type: "context"; messages: TestMessage[] }, ctx: { model?: unknown }) => { messages?: TestMessage[] } | undefined;

	function capture(): Handler {
		let handler: Handler | undefined;
		const pi = {
			on: (name: string, fn: Handler) => {
				if (name === "context") handler = fn;
			},
		} as unknown as ExtensionAPI;
		registerCrossModelThinkingGuard(pi);
		return handler!;
	}

	test("registers a context handler that strips cross-model reasoning for a NaN target", () => {
		const handler = capture();
		const message = assistant({ content: [{ type: "thinking", thinking: "big" }, { type: "text", text: "keep" }] });
		const result = handler({ type: "context", messages: [message] }, { model: TARGET });
		expect(typesOf(result!.messages![0])).toEqual(["text"]);
	});

	test("returns nothing (no context rewrite) for a non-NaN target", () => {
		const handler = capture();
		expect(handler({ type: "context", messages: [assistant()] }, { model: { provider: "anthropic", api: "anthropic-messages", id: "claude" } })).toBeUndefined();
	});

	test("returns nothing when the guard is disabled by env", () => {
		const handler = capture();
		const previous = process.env[NAN_THINKING_GUARD_ENV];
		process.env[NAN_THINKING_GUARD_ENV] = "0";
		try {
			expect(handler({ type: "context", messages: [assistant()] }, { model: TARGET })).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env[NAN_THINKING_GUARD_ENV];
			else process.env[NAN_THINKING_GUARD_ENV] = previous;
		}
	});
});

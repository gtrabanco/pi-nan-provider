import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	boundCrossModelThinking,
	CROSS_MODEL_THINKING_TRUNCATION_MARKER,
	crossModelThinkingGuardEnabled,
	MAX_CROSS_MODEL_THINKING_CHARS,
	NAN_THINKING_GUARD_ENV,
} from "../src/cross-model-thinking-guard.ts";
import { registerCrossModelThinkingGuard } from "../src/index.ts";
import { PROVIDERS } from "../src/providers.ts";

const NAN_IDS = new Set(PROVIDERS.map((p) => p.id));
const TARGET = { provider: "nan", api: "openai-completions", id: "qwen3.6" };
const OPTIONS = { providerIds: NAN_IDS, maxCharsPerBlock: 10 };

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
		model: "glm5.3-flash",
		content: [{ type: "thinking", thinking: "x".repeat(100), thinkingSignature: "sig" }],
		...overrides,
	};
}

/** The single thinking block of the first returned message. */
function thinkingOf(message: TestMessage | undefined): string {
	return (message?.content?.[0] as { thinking: string }).thinking;
}

describe("boundCrossModelThinking", () => {
	test("truncates an oversized cross-model thinking block to the cap plus a visible marker", () => {
		const result = boundCrossModelThinking([assistant()], TARGET, OPTIONS);
		const block = result[0]!.content![0] as { thinking: string };
		expect(block.thinking).toBe("x".repeat(10) + CROSS_MODEL_THINKING_TRUNCATION_MARKER);
		expect(block.thinking.length).toBeGreaterThan(10);
	});

	test("preserves the block signature and sibling blocks", () => {
		const message = assistant({
			content: [
				{ type: "thinking", thinking: "y".repeat(50), thinkingSignature: "keep-me" },
				{ type: "text", text: "answer" },
				{ type: "toolCall", id: "call_1", name: "bash", arguments: {} },
			],
		});
		const content = boundCrossModelThinking([message], TARGET, OPTIONS)[0]!.content!;
		expect((content[0] as { thinkingSignature: string }).thinkingSignature).toBe("keep-me");
		expect(content[1]).toEqual({ type: "text", text: "answer" });
		expect(content[2]).toEqual({ type: "toolCall", id: "call_1", name: "bash", arguments: {} });
	});

	test("never mutates the input message or its blocks", () => {
		const message = assistant();
		boundCrossModelThinking([message], TARGET, OPTIONS);
		expect((message.content![0] as { thinking: string }).thinking).toBe("x".repeat(100));
	});

	test("returns the same array reference when a cross-model block is already within the cap", () => {
		const messages = [assistant({ content: [{ type: "thinking", thinking: "short" }] })];
		expect(boundCrossModelThinking(messages, TARGET, OPTIONS)).toBe(messages);
	});

	test("leaves same-model replay untouched even when oversized", () => {
		const messages = [assistant({ model: "qwen3.6" })];
		expect(boundCrossModelThinking(messages, TARGET, OPTIONS)).toBe(messages);
	});

	test("ignores a target whose provider is not registered by this package", () => {
		const messages = [assistant()];
		expect(boundCrossModelThinking(messages, { provider: "anthropic", api: "anthropic-messages", id: "claude" }, OPTIONS)).toBe(messages);
	});

	test("ignores an undefined target (model not resolved yet)", () => {
		const messages = [assistant()];
		expect(boundCrossModelThinking(messages, undefined, OPTIONS)).toBe(messages);
	});

	test("treats an assistant message with no model metadata as cross-model", () => {
		const message: TestMessage = { role: "assistant", content: [{ type: "thinking", thinking: "z".repeat(40) }] };
		expect(thinkingOf(boundCrossModelThinking([message], TARGET, OPTIONS)[0])).toBe("z".repeat(10) + CROSS_MODEL_THINKING_TRUNCATION_MARKER);
	});

	test("leaves non-assistant messages untouched", () => {
		const messages = [{ role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: "x".repeat(100) }] }];
		expect(boundCrossModelThinking(messages, TARGET, OPTIONS)).toBe(messages);
	});

	test("leaves non-string/redacted thinking blocks untouched", () => {
		const messages = [assistant({ content: [{ type: "thinking", redacted: true }, { type: "thinking", thinking: undefined }] })];
		expect(boundCrossModelThinking(messages, TARGET, OPTIONS)).toBe(messages);
	});

	test("truncates only the oversized block when several are present", () => {
		const message = assistant({
			content: [
				{ type: "thinking", thinking: "small" },
				{ type: "thinking", thinking: "L".repeat(30) },
			],
		});
		const content = boundCrossModelThinking([message], TARGET, OPTIONS)[0]!.content!;
		expect(content[0]!.thinking).toBe("small");
		expect(content[1]!.thinking).toBe("L".repeat(10) + CROSS_MODEL_THINKING_TRUNCATION_MARKER);
	});

	test("uses the documented default cap when none is passed", () => {
		const huge = "h".repeat(MAX_CROSS_MODEL_THINKING_CHARS + 5_000);
		const message = assistant({ content: [{ type: "thinking", thinking: huge }] });
		expect(thinkingOf(boundCrossModelThinking([message], TARGET, { providerIds: NAN_IDS })[0])).toBe(
			huge.slice(0, MAX_CROSS_MODEL_THINKING_CHARS) + CROSS_MODEL_THINKING_TRUNCATION_MARKER,
		);
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

	test("registers a context handler that bounds cross-model thinking for a NaN target", () => {
		const handler = capture();
		const message = assistant({ content: [{ type: "thinking", thinking: "x".repeat(MAX_CROSS_MODEL_THINKING_CHARS + 500) }] });
		const result = handler({ type: "context", messages: [message] }, { model: TARGET });
		expect(thinkingOf(result!.messages![0])).toBe("x".repeat(MAX_CROSS_MODEL_THINKING_CHARS) + CROSS_MODEL_THINKING_TRUNCATION_MARKER);
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

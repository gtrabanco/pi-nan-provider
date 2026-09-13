/**
 * ACCEPTANCE TESTS — issue #3
 * "Tracking: upstream pi fix for cross-model thinking replay inflating the
 * request (NaN 400 on model switch)".
 *
 * https://github.com/gtrabanco/pi-nan-provider/issues/3
 *
 * The bug: pi-ai's `transformMessages` downgrades a previous model's `thinking`
 * blocks to plain assistant text with **no size bound** when history is replayed
 * into a different model. Switching from a 1M-context model (glm5.3-flash,
 * deepseek-v4-flash) to a 262K one (`qwen3.6`) therefore overflows the window,
 * and NaN's LiteLLM gateway answers the generic
 *   HTTP 400 `Invalid request. Check your request parameters.`
 * instead of naming the context overflow.
 *
 * Two layers are required to actually fix the user-visible failure:
 *
 *  1. `src/cross-model-thinking-guard.ts` drops the replayed cross-model
 *     reasoning before pi-ai converts it (the primary mitigation), so the
 *     request usually fits.
 *  2. The provider must **re-check the request size on the way out**: when a
 *     request still exceeds the target model's context window and the gateway
 *     answers the generic 400, that error has to be surfaced as a recognizable
 *     context overflow. pi's auto-compaction keys on pi-ai's
 *     `isContextOverflow()`; the generic text does not match it, so today the
 *     session wedges permanently at the ceiling (upstream
 *     earendil-works/pi#9409, listed by the issue). Reclassifying the error lets
 *     pi compact and retry instead of stalling.
 *
 * These tests are FROZEN acceptance criteria. They drive the real pi-ai
 * `openai-completions` adapter end-to-end through the real provider and a mock
 * NaN gateway (no network; fetch is injected). The gateway mimics NaN exactly:
 * it returns the generic 400 whenever the body overflows the model's window.
 */

import { describe, expect, test } from "bun:test";
import { isContextOverflow } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NAN_THINKING_GUARD_ENV } from "../src/cross-model-thinking-guard.ts";
import { baselineModels } from "../src/fetch-models.ts";
import { registerCrossModelThinkingGuard } from "../src/index.ts";
import { createNanCompatibleProvider } from "../src/provider-factory.ts";
import { NAN_PROVIDER } from "../src/providers.ts";

const SOURCE = { providerId: "nan", baseUrl: NAN_PROVIDER.baseUrl } as const;

/** The exact generic body NaN's gateway returns for an over-window request. */
const GENERIC_NAN_400 = "Invalid request. Check your request parameters.";

/**
 * Char→token ratio the maintainer used for the offline session measurements in
 * the issue (chars/3.47 + tools + system). The mock gateway uses the same ratio
 * to decide overflow, so the test mirrors the real gateway's behavior.
 */
const CHARS_PER_TOKEN = 3.47;

const SYSTEM_PROMPT = "You are a coding assistant.";

interface TestBlock {
	type: string;
	thinking?: string;
	text?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
	[key: string]: unknown;
}

interface TestMessage {
	role: string;
	provider?: string;
	api?: string;
	model?: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	usage?: Record<string, unknown>;
	stopReason?: string;
	timestamp?: number;
	[key: string]: unknown;
}

function modelFor(id: string): ReturnType<typeof baselineModels>[number] {
	const model = baselineModels(SOURCE).find((candidate) => candidate.id === id);
	if (!model) throw new Error(`catalog model not found: ${id}`);
	return model;
}

const TARGET = modelFor("qwen3.6"); // 262,144-token window — the issue's destination model.

function emptyUsage(): Record<string, unknown> {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * A realistic session that triggers the issue: research done on a 1M-context
 * model (glm5.3-flash) then replayed into qwen3.6 (262K). The reasoning trace is
 * the degenerate-size one the issue measured in the wild.
 */
function crossModelReasoningSession(reasoningChars: number): TestMessage[] {
	return [
		{ role: "user", content: "research the codebase and report back", timestamp: 1 },
		{
			role: "assistant",
			provider: "nan",
			api: "openai-completions",
			model: "glm5.3-flash",
			content: [
				{ type: "thinking", thinking: "R".repeat(reasoningChars) },
				{ type: "text", text: "I inspected the repository." },
				{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls -R" } },
			],
			usage: emptyUsage(),
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "bash",
			content: [{ type: "text", text: "src/index.ts" }],
			isError: false,
			timestamp: 3,
		},
		{ role: "user", content: "now summarize what you found", timestamp: 4 },
	];
}

const WITHIN_WINDOW_SESSION: TestMessage[] = [
	{ role: "user", content: "hello", timestamp: 1 },
	{
		role: "assistant",
		provider: "nan",
		api: "openai-completions",
		model: "qwen3.6",
		content: [{ type: "text", text: "hi" }],
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 2,
	},
];

/** An SSE stream that completes cleanly with the given assistant text. */
function okSse(text: string): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						`data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"qwen3.6","choices":[{"index":0,"delta":{"role":"assistant","content":"${text}"},"finish_reason":"stop"}]}\n\n`,
					),
				);
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

/** NaN's generic 400, exactly as the live gateway shapes it. */
function generic400(): Response {
	return new Response(
		JSON.stringify({
			error: { message: GENERIC_NAN_400, type: "invalid_request_error", code: "invalid_request" },
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

interface MockGateway {
	fetchImpl: typeof fetch;
	lastBodyChars(): number;
	lastBody: () => Record<string, unknown>;
}

/**
 * A mock NaN gateway: over-window requests get the opaque generic 400 (what the
 * real gateway does today); everything else succeeds. `alwaysFail` forces the
 * generic 400 even for within-window requests (a non-overflow 400).
 */
function createGateway(model: ReturnType<typeof baselineModels>[number], options: { alwaysFail?: boolean } = {}): MockGateway {
	let bodyChars = 0;
	let body: Record<string, unknown> = {};
	const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
		const raw = init?.body as string;
		bodyChars = raw.length;
		body = JSON.parse(raw) as Record<string, unknown>;
		const overWindow = raw.length / CHARS_PER_TOKEN > model.contextWindow;
		if (options.alwaysFail || overWindow) return generic400();
		return okSse("done");
	}) as unknown as typeof fetch;
	return { fetchImpl, lastBodyChars: () => bodyChars, lastBody: () => body };
}

interface TerminalMessage {
	stopReason?: string;
	errorMessage?: string;
	content?: TestBlock[];
}

async function runTurn(
	messages: TestMessage[],
	gateway: MockGateway,
	model = TARGET,
): Promise<{ final: TerminalMessage; events: Array<Record<string, unknown>> }> {
	const provider = await createNanCompatibleProvider(NAN_PROVIDER);
	const stream = provider.stream(
		model,
		{ systemPrompt: SYSTEM_PROMPT, messages: messages as never, tools: [] },
		{ apiKey: "sk-test", fetch: gateway.fetchImpl },
	);
	const events: Array<Record<string, unknown>> = [];
	for await (const event of stream) events.push(event as Record<string, unknown>);
	const final = (await stream.result()) as unknown as TerminalMessage;
	return { final, events };
}

/**
 * Apply the extension's `context` hook exactly as pi does, honouring the
 * `NAN_THINKING_GUARD` opt-out so the guard-disabled scenario is the real one.
 */
type ContextHandler = (
	event: { type: "context"; messages: TestMessage[] },
	ctx: { model?: unknown },
) => { messages?: TestMessage[] } | undefined;

function applyGuard(messages: TestMessage[], enabled: boolean, model = TARGET): TestMessage[] {
	let handler: ContextHandler | undefined;
	const pi = {
		on: (name: string, fn: ContextHandler) => {
			if (name === "context") handler = fn;
		},
	} as unknown as ExtensionAPI;
	registerCrossModelThinkingGuard(pi);

	const previous = process.env[NAN_THINKING_GUARD_ENV];
	if (enabled) delete process.env[NAN_THINKING_GUARD_ENV];
	else process.env[NAN_THINKING_GUARD_ENV] = "0";
	try {
		return handler!({ type: "context", messages }, { model })?.messages ?? messages;
	} finally {
		if (previous === undefined) delete process.env[NAN_THINKING_GUARD_ENV];
		else process.env[NAN_THINKING_GUARD_ENV] = previous;
	}
}

describe("issue #3 — an over-window replay must not wedge the session on NaN's generic 400", () => {
	test("guard disabled: the opaque 400 is classified as a context overflow so pi can compact and retry", async () => {
		// The reasoning trace alone is ~2.5x qwen3.6's window, so this request can
		// never fit — the exact situation the issue documents with NAN_THINKING_GUARD=0.
		const messages = crossModelReasoningSession(1_200_000);
		const guarded = applyGuard(messages, /* enabled */ false);
		expect(guarded).toBe(messages); // opt-out honoured: nothing was dropped.

		const gateway = createGateway(TARGET);
		const { final } = await runTurn(guarded, gateway);

		// The mock gateway really did see an over-window body and returned NaN's generic 400.
		expect(gateway.lastBodyChars() / CHARS_PER_TOKEN).toBeGreaterThan(TARGET.contextWindow);
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage ?? "").toContain(GENERIC_NAN_400);

		// The decisive contract: pi must be able to recognize this as a context
		// overflow. Today the generic text matches no overflow pattern, so the
		// session wedges (this assertion fails first).
		expect(isContextOverflow(final as never, TARGET.contextWindow)).toBe(true);
	});

	test("guard enabled: the same session is replayed without the reasoning and the turn succeeds", async () => {
		const messages = crossModelReasoningSession(1_200_000);
		const guarded = applyGuard(messages, /* enabled */ true);
		// The guard dropped the reasoning: the replayed prefix no longer carries it.
		expect(JSON.stringify(guarded)).not.toContain("R".repeat(1_000));

		const gateway = createGateway(TARGET);
		const { final } = await runTurn(guarded, gateway);

		expect(gateway.lastBodyChars() / CHARS_PER_TOKEN).toBeLessThan(TARGET.contextWindow);
		expect(final.stopReason).toBe("stop");
		expect((final.content ?? []).map((block) => block.text).join("")).toContain("done");
	});
});

describe("issue #3 — reclassification is conservative", () => {
	test("a generic 400 on a within-window request stays a generic error, never a false overflow", async () => {
		const messages = applyGuard(WITHIN_WINDOW_SESSION, /* enabled */ true);
		const gateway = createGateway(TARGET, { alwaysFail: true });
		const { final } = await runTurn(messages, gateway);

		expect(gateway.lastBodyChars() / CHARS_PER_TOKEN).toBeLessThan(TARGET.contextWindow);
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage ?? "").toContain(GENERIC_NAN_400);
		expect(isContextOverflow(final as never, TARGET.contextWindow)).toBe(false);
	});
});

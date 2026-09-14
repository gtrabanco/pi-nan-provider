/**
 * ACCEPTANCE TESTS — issue #2
 * "Intermittent 'Stream ended without finish_reason' on GLM5.3-Flash (and other
 * NaN models)".
 *
 * https://github.com/gtrabanco/pi-nan-provider/issues/2
 *
 * The bug: the generated catalog declared `supportsFinishReason: false`. With
 * that flag, pi-ai converts a NaN/LiteLLM stream that closes WITHOUT a
 * `finish_reason` into a synthetic `stop` / `toolUse` — a silent mid-turn
 * stall (`rawStopReason` absent, no error, no retry). The issue's decisive
 * finding: `"Stream ended without finish_reason"` is RETRYABLE
 * (pi-ai's `RETRYABLE_PROVIDER_ERROR_PATTERN` includes `"ended without"`), so
 * declaring `supportsFinishReason: true` turns the intermittent truncation
 * into an automatic retry that recovers the turn instead of hiding it.
 *
 * A second, independent defect: the catalog claimed
 * `supportsUsageInStreaming: true` (so pi-ai asks for
 * `stream_options: { include_usage: true }`) while the request sanitizer
 * strips `stream_options` before sending. The flag contradicted the
 * sanitizer. The declaration must match what is actually sent.
 *
 * These tests are FROZEN acceptance criteria. They exercise the real pi-ai
 * `openai-completions` adapter end-to-end (no network; fetch is injected), so
 * they fail on the flag's actual consequence — a silent stall — and not
 * merely on a config value.
 */

import { describe, expect, test } from "bun:test";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { NAN_GENERATED_MODELS } from "../scripts/models.generated.ts";
import { baselineModels, mergeLiveWithGenerated } from "../src/fetch-models.ts";
import { createNanCompatibleProvider } from "../src/provider-factory.ts";
import { NAN_PROVIDER } from "../src/providers.ts";

const SOURCE = { providerId: "nan", baseUrl: NAN_PROVIDER.baseUrl } as const;

/**
 * live-only premium models (glm5.3) are deliberately absent from the generated
 * catalog, so this always resolves to the conservative placeholder path even
 * if a future catalog refresh changes the generated set.
 */
const GENERATED_WITHOUT_GLM53 = NAN_GENERATED_MODELS.filter((entry) => entry.id !== "glm5.3");

/**
 * A text/event-stream response that emits an assistant delta and then closes
 * WITHOUT ever emitting `finish_reason` — the exact NaN/LiteLLM truncation
 * described in the issue ("terminó limpio, pero sin evento terminal").
 */
function truncatedSseResponse(): Response {
	const encoder = new TextEncoder();
	const chunks = [
		'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"glm5.3-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"partial answ"},"finish_reason":null}]}\n\n',
		"data: [DONE]\n\n",
	];
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

const fetchTruncated = (async () => truncatedSseResponse()) as unknown as typeof fetch;

interface TerminalEvent {
	type: string;
	error?: { stopReason?: string; errorMessage?: string };
	message?: { stopReason?: string; errorMessage?: string };
}

/** Drive one stream through the real provider and return its terminal event. */
async function runTruncatedStream(model: Parameters<Awaited<ReturnType<typeof createNanCompatibleProvider>>["stream"]>[0]): Promise<TerminalEvent> {
	const provider = await createNanCompatibleProvider(NAN_PROVIDER);
	const stream = provider.stream(
		model,
		{ systemPrompt: "You are a helper", messages: [{ role: "user", content: "hi" }] as never, tools: [] },
		{ apiKey: "sk-test", fetch: fetchTruncated },
	);
	const events: TerminalEvent[] = [];
	for await (const event of stream) events.push(event as TerminalEvent);
	const terminal = events.at(-1);
	if (!terminal) throw new Error("stream produced no events");
	return terminal;
}

function assertRetryableTruncation(terminal: TerminalEvent): void {
	expect(terminal.type).toBe("error");
	const message = terminal.error ?? terminal.message;
	expect(message).toBeDefined();
	expect(message!.stopReason).toBe("error");
	expect(message!.errorMessage ?? "").toContain("Stream ended without finish_reason");
	expect(isRetryableAssistantError(message as never)).toBe(true);
}

describe("issue #2 — a truncated NaN stream is a retryable error, never a silent stall", () => {
	test("end-to-end (generated catalog model): missing finish_reason becomes stopReason 'error' + retry", async () => {
		const model = baselineModels(SOURCE).find((candidate) => candidate.id === "glm5.3-flash");
		expect(model).toBeDefined();
		assertRetryableTruncation(await runTruncatedStream(model!));
	});

	test("end-to-end (uncatalogued placeholder model): the placeholder also errors + retries", async () => {
		const placeholder = mergeLiveWithGenerated(["glm5.3"], SOURCE, GENERATED_WITHOUT_GLM53).models[0];
		expect(placeholder).toBeDefined();
		assertRetryableTruncation(await runTruncatedStream(placeholder!));
	});

	test("catalog contract: every generated model declares supportsFinishReason true", () => {
		const models = baselineModels(SOURCE);
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(model.compat?.supportsFinishReason, model.id).toBe(true);
		}
	});

	test("catalog contract: the live-only placeholder declares supportsFinishReason true", () => {
		const placeholder = mergeLiveWithGenerated(["glm5.3"], SOURCE, GENERATED_WITHOUT_GLM53).models[0]!;
		expect(placeholder.compat?.supportsFinishReason).toBe(true);
	});
});

describe("issue #2 — the streaming-usage declaration matches the sanitizer", () => {
	test("catalog contract: every generated model declares supportsUsageInStreaming false (stream_options is stripped)", () => {
		for (const model of baselineModels(SOURCE)) {
			expect(model.compat?.supportsUsageInStreaming, model.id).toBe(false);
		}
	});

	test("catalog contract: the live-only placeholder declares supportsUsageInStreaming false", () => {
		const placeholder = mergeLiveWithGenerated(["glm5.3"], SOURCE, GENERATED_WITHOUT_GLM53).models[0]!;
		expect(placeholder.compat?.supportsUsageInStreaming).toBe(false);
	});

	test("end-to-end: no outgoing request carries stream_options while the flag says it does not", async () => {
		let body: Record<string, unknown> = {};
		const capturingFetch = (async (_url: unknown, init?: RequestInit) => {
			body = JSON.parse(init!.body as string) as Record<string, unknown>;
			return truncatedSseResponse();
		}) as unknown as typeof fetch;

		const provider = await createNanCompatibleProvider(NAN_PROVIDER);
		const model = baselineModels(SOURCE).find((candidate) => candidate.id === "glm5.3-flash")!;
		const stream = provider.stream(
			model,
			{ systemPrompt: "You are a helper", messages: [{ role: "user", content: "hi" }] as never, tools: [] },
			{ apiKey: "sk-test", fetch: capturingFetch },
		);
		for await (const _event of stream) {
			// consume to completion
		}

		expect(model.compat?.supportsUsageInStreaming).toBe(false);
		expect("stream_options" in body).toBe(false);
	});
});

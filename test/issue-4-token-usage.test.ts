/**
 * ACCEPTANCE TESTS — issue #4
 * "Token usage is always zero: the payload sanitizer deletes stream_options".
 *
 * https://github.com/gtrabanco/pi-nan-provider/issues/4
 *
 * The bug: `src/openai-compat-sanitizer.ts` rule 4 unconditionally deletes
 * `stream_options` from every outgoing `/chat/completions` payload. pi-ai only
 * emits `stream_options: { include_usage: true }` when the model's effective
 * `compat.supportsUsageInStreaming` is not `false`, and an OpenAI-compatible
 * gateway only returns the final usage chunk when it was asked for. So a user
 * who truthfully overrides `compat.supportsUsageInStreaming: true` via
 * `models.json` still gets an all-zero usage block — the override is silently
 * undone by the sanitizer.
 *
 * The fix under test: gate rule 4 on the model's effective
 * `compat.supportsUsageInStreaming`. When the model declares it (catalog or a
 * user override), `stream_options` survives sanitization and pi-ai reports
 * real token counts. When it does not, the payload stays exactly as strict as
 * today (no `stream_options`) — the conservative default is unchanged.
 *
 * These tests are FROZEN acceptance criteria. They drive the real pi-ai
 * `openai-completions` adapter end-to-end through the real provider against a
 * mock NaN gateway that mirrors OpenAI-compatible semantics: it only emits the
 * usage chunk when the request carried `stream_options.include_usage: true`,
 * so the test fails on the issue's actual consequence (zeros in
 * `message.usage`), not merely on a config value. No network: fetch is
 * injected.
 */

import { describe, expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { baselineModels, mergeLiveWithGenerated } from "../src/fetch-models.ts";
import { sanitizeOpenAICompatPayload } from "../src/openai-compat-sanitizer.ts";
import { createNanCompatibleProvider } from "../src/provider-factory.ts";
import { NAN_PROVIDER } from "../src/providers.ts";
import { NAN_GENERATED_MODELS } from "../scripts/models.generated.ts";

type Json = Record<string, unknown>;

const SOURCE = { providerId: "nan", baseUrl: NAN_PROVIDER.baseUrl } as const;

/** A catalog model, optionally with a user-style `compat` override applied. */
function modelFor(id: string, compat?: Model<"openai-completions">["compat"]): Model<"openai-completions"> {
	const model = baselineModels(SOURCE).find((candidate) => candidate.id === id);
	if (!model) throw new Error(`catalog model not found: ${id}`);
	return compat ? { ...model, compat: { ...model.compat, ...compat } } : model;
}

/**
 * The generated catalog deliberately keeps glm5.3 live-only (premium tier), so
 * the placeholder path is reachable deterministically by filtering it out of
 * the generated entries.
 */
const GENERATED_WITHOUT_GLM53 = NAN_GENERATED_MODELS.filter((entry) => entry.id !== "glm5.3");

interface UsageGateway {
	fetchImpl: typeof fetch;
	lastBody: () => Json;
	requestCount: () => number;
}

/**
 * Mock NaN gateway with OpenAI-compatible streaming semantics:
 *  - text deltas are always streamed;
 *  - the terminal usage chunk is emitted ONLY when the request carried
 *    `stream_options: { include_usage: true }` — exactly like the real
 *    endpoint, where an unrequested usage chunk never arrives.
 */
function usageGateway(): UsageGateway {
	let body: Json = {};
	let requestCount = 0;
	const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
		requestCount += 1;
		body = JSON.parse(init!.body as string) as Json;
		const streamOptions = body.stream_options as Json | undefined;
		const includeUsage = streamOptions?.include_usage === true;

		const chunks = [
			'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"qwen3.6","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n',
			'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"qwen3.6","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
		];
		if (includeUsage) {
			// Standard OpenAI final usage chunk: no choices, only `usage`.
			chunks.push(
				'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"qwen3.6","choices":[],"usage":{"prompt_tokens":42,"completion_tokens":7,"total_tokens":49}}\n\n',
			);
		}
		chunks.push("data: [DONE]\n\n");

		return new Response(
			new ReadableStream({
				start(controller) {
					const encoder = new TextEncoder();
					for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
					controller.close();
				},
			}),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
	}) as unknown as typeof fetch;
	return { fetchImpl, lastBody: () => body, requestCount: () => requestCount };
}

interface TerminalMessage {
	stopReason?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
	};
}

/** Drive one turn through the real provider and return pi-ai's terminal message. */
async function runTurn(model: Model<"openai-completions">, gateway: UsageGateway): Promise<TerminalMessage> {
	const provider = await createNanCompatibleProvider(NAN_PROVIDER);
	const stream = provider.stream(
		model,
		{ systemPrompt: "You are a helper", messages: [{ role: "user", content: "hi" }] as never, tools: [] },
		{ apiKey: "sk-test", fetch: gateway.fetchImpl },
	);
	for await (const _event of stream) {
		// consume to completion
	}
	return (await stream.result()) as unknown as TerminalMessage;
}

describe("issue #4 — an opted-in model reports real token usage instead of zeros", () => {
	test("THE ISSUE: compat.supportsUsageInStreaming true keeps stream_options and yields non-zero usage", async () => {
		const model = modelFor("qwen3.6", { supportsUsageInStreaming: true });
		const gateway = usageGateway();
		const final = await runTurn(model, gateway);

		// The decisive wire contract: the request must carry the usage opt-in.
		expect(gateway.lastBody().stream_options).toEqual({ include_usage: true });

		// ...and pi-ai must surface the gateway's usage chunk to the caller.
		expect(final.stopReason).toBe("stop");
		expect(final.usage?.input).toBe(42);
		expect(final.usage?.output).toBe(7);
		expect(final.usage?.totalTokens).toBe(49);
	});

	test("THE ISSUE (reported scenario): a glm5.3 models.json-style override also yields non-zero usage", async () => {
		// The issue used exactly this: a live-only premium model with a user
		// override of the streaming-usage compat flag.
		const placeholder = mergeLiveWithGenerated(["glm5.3"], SOURCE, GENERATED_WITHOUT_GLM53).models[0]!;
		const model: Model<"openai-completions"> = {
			...placeholder,
			compat: { ...placeholder.compat, supportsUsageInStreaming: true },
		};
		const gateway = usageGateway();
		const final = await runTurn(model, gateway);

		expect(gateway.lastBody().stream_options).toEqual({ include_usage: true });
		expect(final.usage?.input).toBe(42);
		expect(final.usage?.output).toBe(7);
		expect(final.usage?.totalTokens).toBe(49);
	});

	test("opt-in does not resurrect `store` (still absent from NaN's schema)", async () => {
		const model = modelFor("qwen3.6", { supportsUsageInStreaming: true });
		const gateway = usageGateway();
		await runTurn(model, gateway);
		expect("store" in gateway.lastBody()).toBe(false);
	});
});

describe("issue #4 — the conservative default is unchanged", () => {
	test("without the opt-in the sanitizer still strips stream_options and no usage chunk is requested", async () => {
		const model = modelFor("qwen3.6"); // generated catalog: supportsUsageInStreaming false
		expect(model.compat?.supportsUsageInStreaming).toBe(false);

		const gateway = usageGateway();
		const final = await runTurn(model, gateway);

		expect("stream_options" in gateway.lastBody()).toBe(false);
		// The gateway (like the real one) therefore never sends a usage chunk.
		expect(final.usage?.totalTokens ?? 0).toBe(0);
	});

	test("sanitizeOpenAICompatPayload gates on its option, not on a payload field", () => {
		const payload: Json = {
			model: "qwen3.6",
			store: false,
			stream_options: { include_usage: true },
			messages: [{ role: "user", content: "hi" }],
		};

		// Default: strict NaN payload — both undocumented fields removed.
		const defaultOut = sanitizeOpenAICompatPayload(payload) as Json;
		expect("stream_options" in defaultOut).toBe(false);
		expect("store" in defaultOut).toBe(false);

		// Opt-in: stream_options survives, store still does not.
		const optInOut = sanitizeOpenAICompatPayload(payload, { preserveStreamOptions: true }) as Json;
		expect(optInOut.stream_options).toEqual({ include_usage: true });
		expect("store" in optInOut).toBe(false);
	});
});

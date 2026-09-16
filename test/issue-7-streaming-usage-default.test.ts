/**
 * ACCEPTANCE TESTS — issue #7
 * "NaN does implement stream_options.include_usage — measured on 5 models".
 *
 * https://github.com/gtrabanco/pi-nan-provider/issues/7
 *
 * Before this issue the generated catalog declared
 * `supportsUsageInStreaming: false` everywhere, on the grounds that NaN's
 * published schema (https://nan.builders/openapi.json) does not document
 * `stream_options`. The reporter measured the live gateway on 2026-09-16 with
 * two identical streaming calls per model, differing only in `stream_options`:
 * deepseek-v4-flash, glm5.3-flash, qwen3.6, mimo-v2.5 and gemma4 each returned
 * 0 usage chunks without the flag and exactly 1 with
 * `stream_options: { include_usage: true }`, carrying prompt/completion/
 * reasoning/cached token counts. A real pi session then recorded
 * `{input:168, output:3, cacheRead:39040, totalTokens:39211}` where it had
 * recorded zeros.
 *
 * So the schema is silent, not forbidding: the gateway honors the field. The
 * new contract under test is the issue's second option — flip the default for
 * chat models, instead of asking every user to rediscover the flag by hand.
 * The conservative path stays reachable as an explicit per-model opt-out.
 *
 * These are FROZEN acceptance criteria. They drive the real pi-ai
 * `openai-completions` adapter end-to-end through the real provider against a
 * mock NaN gateway that mirrors the measured semantics: the terminal usage
 * chunk arrives ONLY when the request carried
 * `stream_options.include_usage: true`. They therefore fail on the issue's
 * actual consequence (zeros in `message.usage` for a stock catalog model) and
 * not merely on a config value. No network: fetch is injected.
 */

import { describe, expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { GENERATED_CATALOG_META, NAN_GENERATED_MODELS } from "../scripts/models.generated.ts";
import { baselineModels, mergeLiveWithGenerated } from "../src/fetch-models.ts";
import { createNanCompatibleProvider } from "../src/provider-factory.ts";
import { NAN_PROVIDER } from "../src/providers.ts";

type Json = Record<string, unknown>;

const SOURCE = { providerId: "nan", baseUrl: NAN_PROVIDER.baseUrl } as const;

/**
 * The generated catalog keeps glm5.3 live-only (premium tier), so the
 * uncatalogued-placeholder path is reachable deterministically.
 */
const GENERATED_WITHOUT_GLM53 = NAN_GENERATED_MODELS.filter((entry) => entry.id !== "glm5.3");

/** A stock catalog model, optionally with a user-style `models.json` override. */
function modelFor(id: string, compat?: Model<"openai-completions">["compat"]): Model<"openai-completions"> {
	const model = baselineModels(SOURCE).find((candidate) => candidate.id === id);
	if (!model) throw new Error(`catalog model not found: ${id}`);
	return compat ? { ...model, compat: { ...model.compat, ...compat } } : model;
}

interface UsageGateway {
	fetchImpl: typeof fetch;
	lastBody: () => Json;
}

/**
 * Mock NaN gateway mirroring the 2026-09-16 measurement: the usage chunk is
 * emitted ONLY when the request carried `stream_options.include_usage: true`.
 */
function usageGateway(): UsageGateway {
	let body: Json = {};
	const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
		body = JSON.parse(init!.body as string) as Json;
		const streamOptions = body.stream_options as Json | undefined;
		const includeUsage = streamOptions?.include_usage === true;

		const chunks = [
			'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"qwen3.6","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n',
			'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"qwen3.6","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
		];
		if (includeUsage) {
			chunks.push(
				'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"qwen3.6","choices":[],"usage":{"prompt_tokens":168,"completion_tokens":3,"total_tokens":171}}\n\n',
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
	return { fetchImpl, lastBody: () => body };
}

interface TerminalMessage {
	stopReason?: string;
	usage?: { input?: number; output?: number; totalTokens?: number };
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

describe("issue #7 — chat models opt in to streaming usage by default", () => {
	test("catalog contract: every generated model declares supportsUsageInStreaming true", () => {
		expect(NAN_GENERATED_MODELS.length).toBeGreaterThan(0);
		for (const entry of NAN_GENERATED_MODELS) {
			expect(entry.compat?.supportsUsageInStreaming, entry.id).toBe(true);
		}
	});

	test("catalog contract: the uncatalogued live-model placeholder also declares it true", () => {
		const placeholder = mergeLiveWithGenerated(["glm5.3"], SOURCE, GENERATED_WITHOUT_GLM53).models[0]!;
		expect(placeholder.compat?.supportsUsageInStreaming).toBe(true);
	});

	test("catalog contract: the provenance note records the issue #7 measurement", () => {
		expect(
			GENERATED_CATALOG_META.notes.some(
				(note) =>
					note.includes("supportsUsageInStreaming") &&
					note.includes("true") &&
					note.includes("2026-09-16") &&
					note.includes("#7"),
			),
		).toBe(true);
	});

	test("THE ISSUE: a stock catalog model (no user override) sends stream_options and reports real usage", async () => {
		const model = modelFor("qwen3.6"); // generated default, not a user override
		expect(model.compat?.supportsUsageInStreaming).toBe(true);

		const gateway = usageGateway();
		const final = await runTurn(model, gateway);

		// The decisive wire contract: the stock request carries the usage opt-in.
		expect(gateway.lastBody().stream_options).toEqual({ include_usage: true });
		// ...and the reported zeros become real counts.
		expect(final.stopReason).toBe("stop");
		expect(final.usage?.input).toBe(168);
		expect(final.usage?.output).toBe(3);
		expect(final.usage?.totalTokens).toBe(171);
	});

	test("an uncatalogued live chat model also reports real usage by default", async () => {
		const placeholder = mergeLiveWithGenerated(["glm5.3"], SOURCE, GENERATED_WITHOUT_GLM53).models[0]!;
		const gateway = usageGateway();
		const final = await runTurn(placeholder, gateway);

		expect(gateway.lastBody().stream_options).toEqual({ include_usage: true });
		expect(final.usage?.totalTokens).toBe(171);
	});
});

describe("issue #7 — the conservative path stays available as an explicit opt-out", () => {
	test("supportsUsageInStreaming false still strips stream_options and yields zero usage", async () => {
		const model = modelFor("qwen3.6", { supportsUsageInStreaming: false });
		const gateway = usageGateway();
		const final = await runTurn(model, gateway);

		expect("stream_options" in gateway.lastBody()).toBe(false);
		expect(final.stopReason).toBe("stop");
		expect(final.usage?.totalTokens ?? 0).toBe(0);
	});
});

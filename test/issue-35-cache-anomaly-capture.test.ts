/**
 * ACCEPTANCE TESTS — issue #35, part A
 * "Persist cf-ray on cache-anomaly detection so a prompt-cache recurrence
 * ships NaN the evidence they asked for."
 *
 * https://github.com/gtrabanco/pi-nan-provider/issues/35
 *
 * NaN asked for "modelo y cf-ray de un par de llamadas". The provider is the
 * only surface that sees response headers (onResponse) and the raw gateway
 * `id`/`created` pair (onProviderStreamEvent). These tests pin:
 *   - detection of the #17 signature (same id+created across two streams),
 *   - the persisted record fields (model, both cf-rays, timestamps, id/created),
 *   - no false positives and no content/credential leakage,
 *   - stream behavior untouched when nothing is captured.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	ProviderStreams,
} from "@earendil-works/pi-ai";

import {
	CACHE_ANOMALY_FILE,
	CACHE_ANOMALY_KIND,
	createCacheAnomalyFileSink,
	defaultCacheAnomalyPath,
	withCacheAnomalyCapture,
	type CacheAnomalyRecord,
	type CacheAnomalySink,
} from "../src/cache-anomaly.ts";

const NOW = new Date("2026-11-11T10:00:00.000Z");

function makeMessage(model = "qwen3.8-flash", responseId = "chatcmpl-a"): AssistantMessage {
	return {
		role: "assistant",
		provider: "nan",
		api: "openai-completions",
		model,
		responseId,
		content: [{ type: "text", text: "answer" }],
		usage: {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: NOW.getTime(),
	} as AssistantMessage;
}

function fakeStream(message: AssistantMessage): AssistantMessageEventStream {
	return {
		[Symbol.asyncIterator]: async function* () {
			yield { type: "done" as const, reason: message.stopReason, message };
		},
		result: async () => message,
	} as unknown as AssistantMessageEventStream;
}

interface ScriptedResponse {
	id?: string;
	created?: number;
	cfRay?: string;
	payload?: unknown;
	model?: string;
}

/**
 * API stub that replays one scripted response per stream call: it fires the
 * same hooks pi-ai's openai-completions adapter fires, in order.
 */
function scriptedApi(script: ScriptedResponse[], observed: string[] = []): ProviderStreams {
	let index = 0;
	const next = () => script[index++] ?? {};
	const run = (options: Record<string, unknown> | undefined) => {
		const entry = next();
		const model = entry.model ?? "qwen3.8-flash";
		const onResponse = options?.onResponse as ((r: unknown, m: unknown) => unknown) | undefined;
		const onPayload = options?.onPayload as ((p: unknown, m: unknown) => unknown) | undefined;
		const onEvent = options?.onProviderStreamEvent as ((c: unknown, m: unknown) => unknown) | undefined;
		if (onPayload) onPayload(entry.payload ?? { model, messages: [] }, { id: model });
		if (onResponse) {
			onResponse(
				{
					status: 200,
					headers: entry.cfRay ? { "cf-ray": entry.cfRay, "content-type": "text/event-stream" } : {},
				},
				{ id: model },
			);
		}
		if (onEvent) {
			onEvent({ id: entry.id, created: entry.created, choices: [{ delta: {} }] }, { id: model });
		}
		observed.push(model);
		return fakeStream(makeMessage(model, entry.id ?? ""));
	};
	return {
		stream: (_model, _context, options) => run(options as Record<string, unknown> | undefined),
		streamSimple: (_model, _context, options) => run(options as Record<string, unknown> | undefined),
	} as ProviderStreams;
}

function memorySink(): { sink: CacheAnomalySink; records: CacheAnomalyRecord[] } {
	const records: CacheAnomalyRecord[] = [];
	return { sink: { record: (record) => records.push(record) }, records };
}

async function runAll(api: ProviderStreams, count: number): Promise<AssistantMessage[]> {
	const messages: AssistantMessage[] = [];
	for (let i = 0; i < count; i++) {
		const stream = api.stream({ id: "qwen3.8-flash" } as never, { messages: [] } as never, {});
		for await (const _event of stream) {
			// consume
		}
		messages.push(await stream.result());
	}
	return messages;
}

let scratchDirs: string[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "nan-anomaly-"));
	scratchDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
	scratchDirs = [];
	delete process.env.PI_CODING_AGENT_DIR;
});

describe("issue #35 — duplicate id/created detection", () => {
	test("records one anomaly when two streams return the same id+created", async () => {
		const { sink, records } = memorySink();
		const api = withCacheAnomalyCapture(
			scriptedApi([
				{ id: "chatcmpl-same", created: 1762778096, cfRay: "8a1b2c3d4e5f-AKL", payload: { a: 1 } },
				{ id: "chatcmpl-same", created: 1762778096, cfRay: "8a1b2c3d4e5f-FRA", payload: { a: 1 } },
			]),
			{ sink, now: () => NOW },
		);

		await runAll(api, 2);

		expect(records).toHaveLength(1);
		const record = records[0]!;
		expect(record.kind).toBe(CACHE_ANOMALY_KIND);
		expect(record.model).toBe("qwen3.8-flash");
		expect(record.id).toBe("chatcmpl-same");
		expect(record.created).toBe(1762778096);
		expect(record.detected_at).toBe(NOW.toISOString());
		expect(record.requests[0]!.cf_ray).toBe("8a1b2c3d4e5f-AKL");
		expect(record.requests[1]!.cf_ray).toBe("8a1b2c3d4e5f-FRA");
		expect(record.requests[0]!.observed_at).toBe(NOW.toISOString());
		expect(record.requests[1]!.observed_at).toBe(NOW.toISOString());
		expect(record.payload_match).toBe(true);
		expect(record.requests.every((r) => typeof r.payload_sha256 === "string")).toBe(true);
	});

	test("marks payload_match=false when the duplicate arrives for a different payload", async () => {
		const { sink, records } = memorySink();
		const api = withCacheAnomalyCapture(
			scriptedApi([
				{ id: "chatcmpl-x", created: 10, cfRay: "ray-1", payload: { prompt: "one" } },
				{ id: "chatcmpl-x", created: 10, cfRay: "ray-2", payload: { prompt: "two" } },
			]),
			{ sink, now: () => NOW },
		);
		await runAll(api, 2);
		expect(records).toHaveLength(1);
		expect(records[0]!.payload_match).toBe(false);
	});

	test("does not record when id differs", async () => {
		const { sink, records } = memorySink();
		const api = withCacheAnomalyCapture(
			scriptedApi([
				{ id: "chatcmpl-a", created: 10, cfRay: "r1" },
				{ id: "chatcmpl-b", created: 10, cfRay: "r2" },
			]),
			{ sink, now: () => NOW },
		);
		await runAll(api, 2);
		expect(records).toHaveLength(0);
	});

	test("does not record when created differs", async () => {
		const { sink, records } = memorySink();
		const api = withCacheAnomalyCapture(
			scriptedApi([
				{ id: "chatcmpl-a", created: 10, cfRay: "r1" },
				{ id: "chatcmpl-a", created: 11, cfRay: "r2" },
			]),
			{ sink, now: () => NOW },
		);
		await runAll(api, 2);
		expect(records).toHaveLength(0);
	});

	test("does not record when created or id is missing", async () => {
		const { sink, records } = memorySink();
		const api = withCacheAnomalyCapture(
			scriptedApi([
				{ id: "chatcmpl-a", cfRay: "r1" },
				{ id: "chatcmpl-a", cfRay: "r2" },
				{ id: undefined, created: 10, cfRay: "r3" },
				{ id: undefined, created: 10, cfRay: "r4" },
			]),
			{ sink, now: () => NOW },
		);
		await runAll(api, 4);
		expect(records).toHaveLength(0);
	});

	test("does not record across different models", async () => {
		const { sink, records } = memorySink();
		const api = withCacheAnomalyCapture(
			scriptedApi([
				{ id: "chatcmpl-a", created: 10, cfRay: "r1" },
				{ id: "chatcmpl-a", created: 10, cfRay: "r2" },
			]),
			{ sink, now: () => NOW },
		);
		for (const modelId of ["qwen3.8-flash", "glm5.3-flash"]) {
			const stream = api.stream({ id: modelId } as never, { messages: [] } as never, {});
			for await (const _event of stream) {
				// consume
			}
			await stream.result();
		}
		expect(records).toHaveLength(0);
	});

	test("a burst of identical responses records the pair once", async () => {
		const { sink, records } = memorySink();
		const api = withCacheAnomalyCapture(
			scriptedApi([
				{ id: "chatcmpl-same", created: 10, cfRay: "r1" },
				{ id: "chatcmpl-same", created: 10, cfRay: "r2" },
				{ id: "chatcmpl-same", created: 10, cfRay: "r3" },
				{ id: "chatcmpl-same", created: 10, cfRay: "r4" },
			]),
			{ sink, now: () => NOW },
		);
		await runAll(api, 4);
		expect(records).toHaveLength(1);
		expect(records[0]!.requests.map((r) => r.cf_ray)).toEqual(["r1", "r2"]);
	});

	test("a sink failure never breaks the stream result", async () => {
		const api = withCacheAnomalyCapture(
			scriptedApi([
				{ id: "chatcmpl-same", created: 10, cfRay: "r1" },
				{ id: "chatcmpl-same", created: 10, cfRay: "r2" },
			]),
			{
				sink: {
					record: () => {
						throw new Error("disk full");
					},
				},
				now: () => NOW,
			},
		);
		const messages = await runAll(api, 2);
		expect(messages[1]!.responseId).toBe("chatcmpl-same");
	});

	test("chains caller-supplied onResponse and onProviderStreamEvent hooks", async () => {
		const { sink } = memorySink();
		const seen: string[] = [];
		const api = withCacheAnomalyCapture(
			scriptedApi([
				{ id: "chatcmpl-same", created: 10, cfRay: "r1" },
				{ id: "chatcmpl-same", created: 10, cfRay: "r2" },
			]),
			{ sink, now: () => NOW },
		);
		for (let i = 0; i < 2; i++) {
			const stream = api.stream({ id: "qwen3.8-flash" } as never, { messages: [] } as never, {
				onResponse: () => {
					seen.push("response");
				},
				onProviderStreamEvent: () => {
					seen.push("chunk");
				},
			});
			for await (const _event of stream) {
				// consume
			}
			await stream.result();
		}
		expect(seen).toEqual(["response", "chunk", "response", "chunk"]);
	});
});

describe("issue #35 — local persistence", () => {
	test("default path is <agentDir>/nan-cache-anomalies.jsonl", () => {
		const dir = scratch();
		process.env.PI_CODING_AGENT_DIR = dir;
		expect(defaultCacheAnomalyPath()).toBe(join(dir, CACHE_ANOMALY_FILE));
	});

	test("file sink appends one JSON line per record under the agent dir", () => {
		const dir = scratch();
		process.env.PI_CODING_AGENT_DIR = dir;
		const sink = createCacheAnomalyFileSink();
		const record: CacheAnomalyRecord = {
			detected_at: NOW.toISOString(),
			kind: CACHE_ANOMALY_KIND,
			model: "qwen3.8-flash",
			id: "chatcmpl-same",
			created: 1762778096,
			payload_match: true,
			requests: [
				{ cf_ray: "r1", observed_at: NOW.toISOString(), payload_sha256: "a" },
				{ cf_ray: "r2", observed_at: NOW.toISOString(), payload_sha256: "a" },
			],
		};
		sink.record(record);
		sink.record({ ...record, detected_at: "2026-11-11T10:01:00.000Z" });

		const lines = readFileSync(join(dir, CACHE_ANOMALY_FILE), "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]!)).toEqual(record);
	});

	test("the record carries no prompt/response content and no credential", async () => {
		const { sink, records } = memorySink();
		const secret = "sk-super-secret-value";
		const prompt = "PROMPT-LITERAL-MUST-NOT-LEAK";
		const api = withCacheAnomalyCapture(
			scriptedApi([
				{ id: "chatcmpl-same", created: 10, cfRay: "r1", payload: { messages: [{ content: prompt }], apiKey: secret } },
				{ id: "chatcmpl-same", created: 10, cfRay: "r2", payload: { messages: [{ content: prompt }], apiKey: secret } },
			]),
			{ sink, now: () => NOW },
		);
		await runAll(api, 2);
		const serialized = JSON.stringify(records);
		expect(serialized).not.toContain(prompt);
		expect(serialized).not.toContain(secret);
		expect(Object.keys(records[0]!).sort()).toEqual(
			["created", "detected_at", "id", "kind", "model", "payload_match", "requests"].sort(),
		);
	});
});

describe("issue #35 — real pi-ai adapter wiring", () => {
	test("detects the duplicate pair through createNanCompatibleProvider and the real openai-completions adapter", async () => {
		const { normalizeContext } = await import("@earendil-works/pi-ai");
		const { createNanCompatibleProvider } = await import("../src/provider-factory.ts");
		const { NAN_PROVIDER } = await import("../src/providers.ts");

		let call = 0;
		const fetchImpl = (async () => {
			call += 1;
			const ray = `ray-${call}`;
			const chunks = [
				`data: {"id":"chatcmpl-cached","object":"chat.completion.chunk","created":1762778096,"model":"qwen3.8-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n`,
				`data: {"id":"chatcmpl-cached","object":"chat.completion.chunk","created":1762778096,"model":"qwen3.8-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
				"data: [DONE]\n\n",
			];
			return new Response(
				new ReadableStream({
					start(controller) {
						const encoder = new TextEncoder();
						for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream", "cf-ray": ray } },
			);
		}) as unknown as typeof fetch;

		const { sink, records } = memorySink();
		const provider = await createNanCompatibleProvider(NAN_PROVIDER, { fetchImpl, cacheAnomalySink: sink });
		const model = provider.getModels().find((m) => m.id === "qwen3.8-flash")!;
		for (let i = 0; i < 2; i++) {
			const stream = provider.stream(
				model,
				normalizeContext({ messages: [{ role: "user", content: "hi" }] as never, tools: [] }),
				{ apiKey: "sk-test", fetch: fetchImpl },
			);
			for await (const _event of stream) {
				// consume
			}
			await stream.result();
		}

		expect(records).toHaveLength(1);
		expect(records[0]!.model).toBe("qwen3.8-flash");
		expect(records[0]!.requests.map((r) => r.cf_ray)).toEqual(["ray-1", "ray-2"]);
		expect(records[0]!.id).toBe("chatcmpl-cached");
		expect(records[0]!.created).toBe(1762778096);
	});
});

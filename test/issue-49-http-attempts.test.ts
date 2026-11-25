/**
 * ACCEPTANCE TESTS — issue #49, part A
 * Provider-level HTTP attempt tap: every attempt (including pi-ai's retries and
 * a 429 that never produced a gateway id) lands in the bounded
 * `nan-http-attempts.jsonl` sidecar with status, whitelisted headers, timing,
 * attempt number, process-scoped concurrency/rate counts and payload size —
 * and nothing else.
 *
 * Frozen-failure corpus for docs/fix/issue-49-nan-debug-http-attempts/SPEC.md
 * (O1–O8). Every case below reproduces RED before `src/http-attempts.ts`
 * exists.
 *
 * https://github.com/gtrabanco/pi-nan-provider/issues/49
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ProviderStreams } from "@earendil-works/pi-ai";

import {
	HTTP_ATTEMPTS_FILE,
	HTTP_ATTEMPTS_MAX_LINES,
	createHttpAttemptFileSink,
	pickResponseHeaders,
	readHttpAttempts,
	withHttpAttemptCapture,
	type HttpAttemptEntry,
	type HttpAttemptRecord,
	type HttpResponseRecord,
	type HttpAttemptSink,
} from "../src/http-attempts.ts";

const NOW = new Date("2026-11-24T12:00:00.000Z");

let scratchDirs: string[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "nan-attempts-"));
	scratchDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
	scratchDirs = [];
});

function message(
	model: string,
	responseId: string,
	usage: { input?: number; output?: number; reasoning?: number; cacheRead?: number } = {},
): AssistantMessage {
	return {
		role: "assistant",
		provider: "nan",
		api: "openai-completions",
		model,
		responseId,
		content: [{ type: "text", text: "answer" }],
		usage: {
			input: usage.input ?? 1,
			output: usage.output ?? 1,
			cacheRead: usage.cacheRead ?? 0,
			cacheWrite: 0,
			reasoning: usage.reasoning,
			totalTokens: (usage.input ?? 1) + (usage.output ?? 1),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: NOW.getTime(),
	} as AssistantMessage;
}

interface AttemptScript {
	status?: number;
	headers?: Record<string, string>;
	/** Response body (error bodies only; the tap must not store it). */
	body?: string;
	/** Reject the fetch instead of returning a response. */
	reject?: Error;
}

/** Scripted base fetch: one response per call, in order. */
function scriptedFetch(scripts: AttemptScript[]): typeof fetch {
	let index = 0;
	return (async () => {
		const script = scripts[index++];
		if (!script) throw new Error("fetch script exhausted");
		if (script.reject) throw script.reject;
		return new Response(script.body ?? null, { status: script.status ?? 200, headers: script.headers });
	}) as unknown as typeof fetch;
}

function okFetch(status = 200): typeof fetch {
	return (async () => new Response(null, { status })) as unknown as typeof fetch;
}

interface ScriptedOptions {
	payload?: Record<string, unknown>;
	created?: number;
	responseId?: string;
	model?: string;
	maxAttempts?: number;
	finishReason?: string;
	usage?: { input?: number; output?: number; reasoning?: number; cacheRead?: number };
}

/**
 * A fake openai-completions api: invokes the injected hooks exactly like pi-ai
 * (onPayload once, then one fetch per attempt, retrying the statuses pi-ai
 * retries), so the tap's behaviour is exercised without the network.
 */
function scriptedApi(options: ScriptedOptions): ProviderStreams {
	const run = async (streamOptions: Record<string, unknown> | undefined): Promise<AssistantMessage> => {
		const model = options.model ?? "qwen3.6";
		const onPayload = streamOptions?.onPayload as ((p: unknown, m: unknown) => unknown) | undefined;
		const onEvent = streamOptions?.onProviderStreamEvent as ((c: unknown, m: unknown) => unknown) | undefined;
		const fetchImpl = streamOptions?.fetch as typeof fetch;
		if (onPayload) {
			await onPayload(options.payload ?? { model, messages: [], stream: true }, { id: model });
		}
		const maxAttempts = options.maxAttempts ?? 10;
		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			const response = await fetchImpl("https://api.nan.builders/v1/chat/completions", {
				method: "POST",
				body: "{}",
			});
			const status = response.status;
			if (status === 408 || status === 409 || status === 429 || status >= 500) continue;
			if (status >= 400) throw Object.assign(new Error(`HTTP ${status}`), { status });
			if (onEvent) {
				await onEvent(
					{
						id: options.responseId ?? "chatcmpl-1",
						created: options.created ?? 1,
						choices: options.finishReason ? [{ finish_reason: options.finishReason }] : [],
					},
					{ id: model },
				);
			}
			return message(model, options.responseId ?? "chatcmpl-1", options.usage);
		}
		throw new Error("retries exhausted");
	};

	return {
		stream: (_model: unknown, _context: unknown, streamOptions: unknown) => {
			const result = run(streamOptions as Record<string, unknown> | undefined);
			return {
				[Symbol.asyncIterator]: async function* () {
					yield { type: "done", reason: "stop", message: await result };
				},
				result: () => result,
			} as never;
		},
		streamSimple: (_model: unknown, _context: unknown, streamOptions: unknown) => ({
			[Symbol.asyncIterator]: async function* () {
				// unused
			},
			result: () => run(streamOptions as Record<string, unknown> | undefined),
		}),
	} as unknown as ProviderStreams;
}

function recordedSink(): { entries: HttpAttemptEntry[]; sink: HttpAttemptSink } {
	const entries: HttpAttemptEntry[] = [];
	return { entries, sink: { record: (entry) => entries.push(entry) } };
}

async function runOne(api: ProviderStreams, fetchImpl: typeof fetch): Promise<void> {
	const stream = api.stream({ id: "qwen3.6" } as never, { messages: [] } as never, { fetch: fetchImpl });
	await stream.result().catch(() => undefined);
}

describe("issue #49 — attempt tap (O1, O2, O3)", () => {
	test("every attempt of a logical request is recorded, including the retry that ends in 200", async () => {
		const { entries, sink } = recordedSink();
		let clock = NOW.getTime();
		const api = withHttpAttemptCapture(
			scriptedApi({
				responseId: "chatcmpl-ok",
				created: 1763990000,
				payload: { model: "qwen3.6", stream: true, max_tokens: 512, reasoning_effort: "low", messages: [] },
			}),
			{ sink, now: () => new Date((clock += 10)), requestId: () => "req-logical-1" },
		);
		await runOne(
			api,
			scriptedFetch([
				{
					status: 429,
					headers: {
						"cf-ray": "ray-429",
						"retry-after": "3",
						"x-request-id": "req-abc",
						"x-should-retry": "true",
						"x-ratelimit-remaining-requests": "7",
					},
				},
				{ status: 200, headers: { "cf-ray": "ray-200" } },
			]),
		);

		const attempts = entries.filter((entry): entry is HttpAttemptRecord => entry.kind === "attempt");
		expect(attempts).toHaveLength(2);
		expect(attempts.map((a) => a.attempt_n)).toEqual([1, 2]);
		expect(attempts.map((a) => a.status)).toEqual([429, 200]);
		// A rejected attempt is evidence on its own: status + headers + timing.
		expect(attempts[0]!.headers).toEqual({
			"cf-ray": "ray-429",
			"retry-after": "3",
			"x-request-id": "req-abc",
			"x-should-retry": "true",
			"x-ratelimit-remaining-requests": "7",
		});
		expect(attempts[0]!.time_to_header_ms).toBeGreaterThanOrEqual(0);
		expect(attempts[0]!.error_type).toBeNull();
		expect(attempts[1]!.headers).toEqual({ "cf-ray": "ray-200" });
		expect(attempts.every((a) => a.request_id === "req-logical-1")).toBe(true);
		expect(attempts.every((a) => a.model === "qwen3.6")).toBe(true);

		const response = entries.find((entry): entry is HttpResponseRecord => entry.kind === "response")!;
		expect(response).toMatchObject({
			request_id: "req-logical-1",
			model: "qwen3.6",
			response_id: "chatcmpl-ok",
			created: 1763990000,
			attempts: 2,
			status: 200,
		});
	});

	test("a 429 rejected before any gateway id still records cf-ray, status and headers", async () => {
		const { entries, sink } = recordedSink();
		const api = withHttpAttemptCapture(scriptedApi({ maxAttempts: 1 }), {
			sink,
			now: () => NOW,
			requestId: () => "req-429",
		});
		await runOne(api, scriptedFetch([{ status: 429, headers: { "cf-ray": "ray-only", "retry-after": "12" } }]));

		const attempt = entries.find((entry): entry is HttpAttemptRecord => entry.kind === "attempt")!;
		expect(attempt.status).toBe(429);
		expect(attempt.headers["cf-ray"]).toBe("ray-only");
		expect(attempt.headers["retry-after"]).toBe("12");
		// No id was ever produced, so no response row claims one.
		expect(entries.some((entry) => entry.kind === "response")).toBe(false);
	});

	test("a rejected fetch records a null status and the transport error class, never the message", async () => {
		const { entries, sink } = recordedSink();
		const api = withHttpAttemptCapture(scriptedApi({}), { sink, now: () => NOW });
		await runOne(api, scriptedFetch([{ reject: new TypeError("fetch failed at /home/agent/secret") }]));

		const attempt = entries.find((entry): entry is HttpAttemptRecord => entry.kind === "attempt")!;
		expect(attempt.status).toBeNull();
		expect(attempt.transport_error).toBe("TypeError");
		expect(attempt.error_type).toBeNull();
		expect(JSON.stringify(entries)).not.toContain("/home/agent/secret");
	});

	test("a non-2xx attempt carries the gateway error type and code, never the body", async () => {
		const { entries, sink } = recordedSink();
		const body = JSON.stringify({
			error: {
				message: "Rate limit reached. Please retry shortly.",
				type: "rate_limit_error",
				code: "rate_limit_exceeded",
				param: null,
			},
		});
		const api = withHttpAttemptCapture(scriptedApi({ maxAttempts: 1 }), { sink, now: () => NOW });
		await runOne(api, scriptedFetch([{ status: 429, headers: { "cf-ray": "ray" }, body }]));

		const attempt = entries.find((entry): entry is HttpAttemptRecord => entry.kind === "attempt")!;
		expect(attempt.error_type).toBe("rate_limit_error");
		expect(attempt.error_code).toBe("rate_limit_exceeded");
		// The body/message is never stored on the attempt row.
		const serialized = JSON.stringify(entries);
		expect(serialized).not.toContain("Rate limit reached");
		expect(serialized).not.toContain("Please retry shortly");
	});

	test("a completed response carries duration, usage and the raw finish_reason", async () => {
		const { entries, sink } = recordedSink();
		let clock = NOW.getTime();
		const api = withHttpAttemptCapture(
			scriptedApi({
				responseId: "chatcmpl-u",
				created: 9,
				finishReason: "length",
				usage: { input: 100, output: 20, reasoning: 5, cacheRead: 7 },
			}),
			{ sink, now: () => new Date((clock += 1000)) },
		);
		await runOne(api, okFetch());

		const response = entries.find((entry): entry is HttpResponseRecord => entry.kind === "response")!;
		expect(response.finish_reason).toBe("length");
		expect(response.usage).toEqual({
			prompt_tokens: 100,
			completion_tokens: 20,
			reasoning_tokens: 5,
			cache_read_tokens: 7,
		});
		expect(response.duration_ms).toBeGreaterThanOrEqual(0);
		expect(response.attempts).toBe(1);
	});

	test("a retried request keeps one response row with the terminal attempt count", async () => {
		const { entries, sink } = recordedSink();
		const api = withHttpAttemptCapture(scriptedApi({ responseId: "chatcmpl-3", created: 5 }), {
			sink,
			now: () => NOW,
		});
		await runOne(api, scriptedFetch([{ status: 500 }, { status: 429 }, { status: 200 }]));

		const responses = entries.filter((entry): entry is HttpResponseRecord => entry.kind === "response");
		expect(responses).toHaveLength(1);
		expect(responses[0]!.attempts).toBe(3);
		expect(responses[0]!.status).toBe(200);
	});
});

describe("issue #49 — payload, request parameters and redaction shape (O6, O7)", () => {
	test("records payload_bytes and the request parameters actually sent", async () => {
		const { entries, sink } = recordedSink();
		const payload = { model: "qwen3.6", stream: true, max_tokens: 900, reasoning_effort: "high", messages: [] };
		const api = withHttpAttemptCapture(scriptedApi({ payload }), { sink, now: () => NOW });
		await runOne(api, okFetch());

		const attempt = entries.find((entry): entry is HttpAttemptRecord => entry.kind === "attempt")!;
		expect(attempt.payload_bytes).toBe(Buffer.byteLength(JSON.stringify(payload), "utf8"));
		expect(attempt.request).toEqual({
			reasoning_effort: "high",
			max_tokens: 900,
			max_tokens_field: "max_tokens",
			stream: true,
		});
	});

	test("the max_completion_tokens field is reported as the field actually sent", async () => {
		const { entries, sink } = recordedSink();
		const api = withHttpAttemptCapture(
			scriptedApi({
				payload: { model: "qwen3.8-max", stream: true, max_completion_tokens: 256, messages: [] },
			}),
			{ sink, now: () => NOW },
		);
		await runOne(api, okFetch());

		const attempt = entries.find((entry): entry is HttpAttemptRecord => entry.kind === "attempt")!;
		expect(attempt.request).toEqual({
			reasoning_effort: null,
			max_tokens: 256,
			max_tokens_field: "max_completion_tokens",
			stream: true,
		});
	});

	test("the record shape is pinned: no content, no credential, no payload fingerprint", async () => {
		const { entries, sink } = recordedSink();
		const payload = {
			model: "qwen3.6",
			stream: true,
			messages: [{ role: "user", content: "PROMPT-SECRET-LITERAL" }],
		};
		const api = withHttpAttemptCapture(scriptedApi({ payload }), { sink, now: () => NOW });
		await runOne(api, okFetch());

		const attempt = entries.find((entry): entry is HttpAttemptRecord => entry.kind === "attempt")!;
		expect(Object.keys(attempt).sort()).toEqual([
			"attempt_n",
			"ended_at",
			"error_code",
			"error_type",
			"headers",
			"inflight_process_at_start",
			"inflight_same_model_at_start",
			"kind",
			"model",
			"payload_bytes",
			"request",
			"request_id",
			"started_at",
			"starts_last_60s_process",
			"starts_last_60s_same_model",
			"status",
			"time_to_header_ms",
			"transport_error",
		]);
		expect(attempt.payload_bytes).toBeGreaterThan(0);
		const serialized = JSON.stringify(entries);
		expect(serialized).not.toContain("PROMPT-SECRET-LITERAL");
		expect(serialized.toLowerCase()).not.toContain("authorization");
		expect(serialized.toLowerCase()).not.toContain("bearer");
		expect(serialized).not.toContain("sha256");
	});

	test("only whitelisted response headers survive an unknown header set", () => {
		const headers = new Headers({
			"cf-ray": "ray",
			"retry-after": "1",
			"x-request-id": "req",
			"x-should-retry": "false",
			"x-ratelimit-limit-tokens": "100",
			"ratelimit-remaining": "3",
			"set-cookie": "session=secret",
			"content-type": "application/json",
			"x-custom-thing": "nope",
		});
		expect(pickResponseHeaders(headers)).toEqual({
			"cf-ray": "ray",
			"retry-after": "1",
			"x-request-id": "req",
			"x-should-retry": "false",
			"x-ratelimit-limit-tokens": "100",
			"ratelimit-remaining": "3",
		});
		expect(pickResponseHeaders(undefined)).toEqual({});
	});
});

describe("issue #49 — process-scoped concurrency and start rate (O4, O5)", () => {
	test("an attempt that starts while another is open reports it, process-scoped", async () => {
		const { entries, sink } = recordedSink();
		let releaseFirst: () => void = () => undefined;
		const firstOpen = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let secondStarted: () => void = () => undefined;
		const secondStartedPromise = new Promise<void>((resolve) => {
			secondStarted = resolve;
		});
		let requestSeq = 0;
		let clock = NOW.getTime();

		const firstFetch = (async () => {
			await firstOpen;
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;
		const secondFetch = (async () => {
			secondStarted();
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;

		const fake: ProviderStreams = {
			stream: (model: { id: string }, _context: unknown, streamOptions: Record<string, unknown>) => {
				const run = (async () => {
					const fetchImpl = streamOptions.fetch as typeof fetch;
					await fetchImpl("https://api.nan.builders/v1/chat/completions", { method: "POST" });
					return message(model.id, "id") as never;
				})();
				return { result: () => run, [Symbol.asyncIterator]: async function* () {} } as never;
			},
			streamSimple: () => ({}) as never,
		} as never;
		const api = withHttpAttemptCapture(fake, {
			sink,
			now: () => new Date((clock += 1000)),
			requestId: () => `req-${++requestSeq}`,
		}) as never as { stream: (m: unknown, c: unknown, o: unknown) => { result: () => Promise<unknown> } };

		const first = api.stream({ id: "qwen3.6" }, { messages: [] }, { fetch: firstFetch });
		const second = api.stream({ id: "qwen3.6" }, { messages: [] }, { fetch: secondFetch });
		await secondStartedPromise;
		releaseFirst();
		await Promise.all([first.result().catch(() => undefined), second.result().catch(() => undefined)]);

		const attempts = entries.filter((entry): entry is HttpAttemptRecord => entry.kind === "attempt");
		expect(attempts).toHaveLength(2);
		const firstAttempt = attempts.find((a) => a.request_id === "req-1")!;
		const secondAttempt = attempts.find((a) => a.request_id === "req-2")!;
		expect(firstAttempt.inflight_process_at_start).toBe(0);
		expect(secondAttempt.inflight_process_at_start).toBe(1);
		expect(secondAttempt.inflight_same_model_at_start).toBe(1);
		// Both starts happened inside the same 60 s, this one included.
		expect(firstAttempt.starts_last_60s_process).toBe(1);
		expect(secondAttempt.starts_last_60s_process).toBe(2);
		expect(secondAttempt.starts_last_60s_same_model).toBe(2);
	});

	test("a different model does not count towards the same-model counters", async () => {
		const { entries, sink } = recordedSink();
		let releaseFirst: () => void = () => undefined;
		const firstOpen = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let secondStarted: () => void = () => undefined;
		const secondStartedPromise = new Promise<void>((resolve) => {
			secondStarted = resolve;
		});
		let requestSeq = 0;

		const firstFetch = (async () => {
			await firstOpen;
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;
		const secondFetch = (async () => {
			secondStarted();
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;

		const fake: ProviderStreams = {
			stream: (model: { id: string }, _context: unknown, streamOptions: Record<string, unknown>) => {
				const run = (async () => {
					const fetchImpl = streamOptions.fetch as typeof fetch;
					await fetchImpl("https://api.nan.builders/v1/chat/completions", { method: "POST" });
					return message(model.id, `id-${model.id}`) as never;
				})();
				return { result: () => run, [Symbol.asyncIterator]: async function* () {} } as never;
			},
			streamSimple: () => ({}) as never,
		} as never;
		const api = withHttpAttemptCapture(fake, {
			sink,
			now: () => NOW,
			requestId: () => `r-${++requestSeq}`,
		}) as never as { stream: (m: unknown, c: unknown, o: unknown) => { result: () => Promise<unknown> } };

		const a = api.stream({ id: "qwen3.6" }, { messages: [] }, { fetch: firstFetch });
		const b = api.stream({ id: "gemma4" }, { messages: [] }, { fetch: secondFetch });
		await secondStartedPromise;
		releaseFirst();
		await Promise.all([a.result().catch(() => undefined), b.result().catch(() => undefined)]);

		const attempts = entries.filter((entry): entry is HttpAttemptRecord => entry.kind === "attempt");
		const gemma = attempts.find((entry) => entry.model === "gemma4")!;
		expect(gemma.inflight_process_at_start).toBe(1);
		expect(gemma.inflight_same_model_at_start).toBe(0);
		expect(gemma.starts_last_60s_process).toBe(2);
		expect(gemma.starts_last_60s_same_model).toBe(1);
	});
});

describe("issue #49 — bounded best-effort sidecar (O8)", () => {
	test("appends JSONL and keeps only the newest maxLines", () => {
		expect(HTTP_ATTEMPTS_MAX_LINES).toBe(50_000);
		const path = join(scratch(), HTTP_ATTEMPTS_FILE);
		const sink = createHttpAttemptFileSink(path, { maxLines: 3 });
		for (let i = 1; i <= 5; i++) {
			sink.record({
				kind: "attempt",
				request_id: `r${i}`,
				attempt_n: 1,
				model: "qwen3.6",
				started_at: NOW.toISOString(),
				ended_at: NOW.toISOString(),
				time_to_header_ms: 1,
				status: 200,
				headers: {},
				payload_bytes: 1,
				request: null,
				inflight_process_at_start: 0,
				inflight_same_model_at_start: 0,
				starts_last_60s_process: 1,
				starts_last_60s_same_model: 1,
				error_type: null,
				error_code: null,
				transport_error: null,
			});
		}
		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(3);
		expect(lines.map((line) => (JSON.parse(line) as HttpAttemptRecord).request_id)).toEqual(["r3", "r4", "r5"]);
	});

	test("an unwritable sink path never throws (streams continue)", async () => {
		const blocker = scratch();
		const notADir = join(blocker, "regular-file");
		writeFileSync(notADir, "x");
		const sink = createHttpAttemptFileSink(join(notADir, "nested", HTTP_ATTEMPTS_FILE));
		expect(() =>
			sink.record({
				kind: "response",
				request_id: "r",
				model: "qwen3.6",
				response_id: null,
				created: null,
				status: 200,
				attempts: 1,
				ended_at: NOW.toISOString(),
				duration_ms: 1,
				request: null,
				usage: null,
				finish_reason: null,
				error_type: null,
				error_code: null,
			}),
		).not.toThrow();

		const api = withHttpAttemptCapture(scriptedApi({}), {
			sink: createHttpAttemptFileSink(join(notADir, "nested", HTTP_ATTEMPTS_FILE)),
			now: () => NOW,
		});
		await expect(runOne(api, okFetch())).resolves.toBeUndefined();
	});

	test("the reader tolerates a missing file and skips corrupted or incomplete rows", () => {
		expect(readHttpAttempts(join(scratch(), "absent.jsonl"))).toEqual([]);
		const path = join(scratch(), HTTP_ATTEMPTS_FILE);
		writeFileSync(
			path,
			[
				"not-json",
				// A valid kind with missing fields would crash the report's window filter.
				JSON.stringify({ kind: "attempt", request_id: "r-incomplete" }),
				JSON.stringify({
					kind: "attempt",
					request_id: "r1",
					attempt_n: 1,
					model: "qwen3.6",
					started_at: NOW.toISOString(),
					ended_at: NOW.toISOString(),
					time_to_header_ms: 0,
					status: 200,
					headers: {},
					payload_bytes: null,
					request: null,
					inflight_process_at_start: 0,
					inflight_same_model_at_start: 0,
					starts_last_60s_process: 1,
					starts_last_60s_same_model: 1,
					error_type: null,
					error_code: null,
					transport_error: null,
				}),
				"",
			].join("\n"),
		);
		expect(readHttpAttempts(path).map((entry) => entry.request_id)).toEqual(["r1"]);
	});
});

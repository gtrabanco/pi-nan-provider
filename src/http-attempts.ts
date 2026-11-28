/**
 * Provider-level HTTP attempt evidence (issue #49).
 *
 * pi's transcript only keeps the terminal outcome of a logical request: pi-ai
 * retries 429/408/409/5xx inside `retryProviderRequest`, and a retried request
 * that finally succeeds appears as one ordinary turn — every attempt before it
 * leaves no status, timing or payload evidence behind.
 *
 * pi-ai 1.7 started reporting failed attempts to `onResponse` too
 * (`onErrorResponse` in `utils/provider-retry.js`), but that hook carries only
 * the status and headers: no start time per attempt, no attempt number, no
 * payload size and no process-scoped counters. Those are the measurements
 * issue #49 asked for, so the tap below stays necessary.
 *
 * `createProvider` exposes no `fetch` option (pi-ai 1.6.0, `CreateProviderOptions`),
 * but `StreamOptions.fetch` is forwarded to the OpenAI client
 * (`dist/api/openai-completions.js:createClient`). Wrapping the provider's api
 * and injecting that field is the one tap that sees every attempt of a logical
 * request — success or failure — without touching content.
 *
 * Contract:
 *   - one `attempt` record per fetch call, written when the fetch settles:
 *     status, whitelisted headers, millisecond timestamps, latency, attempt
 *     number, process-scoped inflight/60 s counters, payload size and the
 *     request parameters actually sent;
 *   - one `response` record per completed logical request, carrying the
 *     gateway `response_id`/`created`, the terminal status and the attempt
 *     count — never any prompt or response body;
 *   - no content, no credentials, no URLs and no payload fingerprint: header
 *     values are whitelisted by name, everything else is dropped;
 *   - local-only and best-effort: a full disk warns once and never breaks a
 *     stream; the file keeps the newest `HTTP_ATTEMPTS_MAX_LINES` lines.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ProviderStreams } from "@earendil-works/pi-ai";

/** Default file name inside pi's agent dir. */
export const HTTP_ATTEMPTS_FILE = "nan-http-attempts.jsonl";

/** Lines kept after a compact: newest first-in, oldest dropped. */
export const HTTP_ATTEMPTS_MAX_LINES = 50_000;

/** Response headers support correlates on; everything else is dropped. */
const HEADER_WHITELIST = new Set([
	"cf-ray",
	"retry-after",
	"retry-after-ms",
	"x-request-id",
	"request-id",
	"x-should-retry",
	"openai-processing-ms",
]);

/** Header families (OpenAI/Anthropic style rate-limit telemetry). */
const HEADER_PREFIXES = ["x-ratelimit-", "ratelimit-", "x-rate-limit-"];

/** Cap applied to every retained header value. */
const HEADER_VALUE_MAX_CHARS = 200;

/** The request parameters the reference CSV carries per row. */
export interface HttpAttemptRequestParams {
	reasoning_effort: string | null;
	max_tokens: number | null;
	/** Which request field actually carried the token budget, when any. */
	max_tokens_field: "max_tokens" | "max_completion_tokens" | null;
	stream: boolean | null;
}

/** One HTTP attempt (one fetch call), written when the fetch settles. */
export interface HttpAttemptRecord {
	kind: "attempt";
	/** Opaque id shared by every attempt of the same logical request. */
	request_id: string;
	/** 1-based attempt number within the logical request. */
	attempt_n: number;
	model: string;
	started_at: string;
	/** When the response headers arrived (or the fetch rejected). */
	ended_at: string;
	/** Start → response headers; the early-rejection signal (not the full body read). */
	time_to_header_ms: number;
	status: number | null;
	/** Whitelisted response headers only. */
	headers: Record<string, string>;
	payload_bytes: number | null;
	request: HttpAttemptRequestParams | null;
	/** Attempts open in this process at the moment this one started (not key-wide). */
	inflight_process_at_start: number;
	inflight_same_model_at_start: number;
	/** Attempts started in this process in the previous 60 s, this one included. */
	starts_last_60s_process: number;
	starts_last_60s_same_model: number;
	/** Gateway `error.type` from a non-2xx error body; null otherwise. */
	error_type: string | null;
	/** Gateway `error.code` from a non-2xx error body; null otherwise. */
	error_code: string | null;
	/** Fetch-rejection class (`error.name`), null when a response arrived. */
	transport_error: string | null;
}

/** One completed logical request, joining the gateway id back to the turn. */
export interface HttpResponseRecord {
	kind: "response";
	request_id: string;
	model: string;
	response_id: string | null;
	created: number | null;
	/** Status of the terminal attempt. */
	status: number | null;
	/** Total attempts this logical request made. */
	attempts: number;
	ended_at: string;
	/** First attempt start → completion (retries and backoff included). */
	duration_ms: number | null;
	request: HttpAttemptRequestParams | null;
	/** Token counts the gateway reported for the completed request. */
	usage: {
		prompt_tokens: number;
		completion_tokens: number;
		reasoning_tokens: number;
		cache_read_tokens: number;
	} | null;
	/** Raw OpenAI `finish_reason` from the last chunk; null when absent. */
	finish_reason: string | null;
	/** Gateway error type when the error arrived inside a 200 SSE stream. */
	error_type: string | null;
	error_code: string | null;
}

export type HttpAttemptEntry = HttpAttemptRecord | HttpResponseRecord;

export interface HttpAttemptSink {
	record(entry: HttpAttemptEntry): void;
}

/** The attempts file path for the current pi agent dir. */
export function defaultHttpAttemptPath(): string {
	return join(getAgentDir(), HTTP_ATTEMPTS_FILE);
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	const lines = text.split("\n").length;
	return text.endsWith("\n") ? lines - 1 : lines;
}

/**
 * File sink: append one JSON line per record, keeping the file bounded by
 * `maxLines` (the compact keeps the newest lines). Never throws — the first
 * failure warns once, then stays quiet so a broken disk cannot spam the console
 * or break a turn.
 */
export function createHttpAttemptFileSink(
	filePath?: string,
	options: { maxLines?: number } = {},
): HttpAttemptSink {
	const maxLines = options.maxLines ?? HTTP_ATTEMPTS_MAX_LINES;
	let warned = false;
	let counted = false;
	let lines = 0;

	const warnOnce = (error: unknown): void => {
		if (warned) return;
		warned = true;
		console.warn(
			`[pi-nan-provider] could not persist HTTP attempt evidence (${error instanceof Error ? error.message : String(error)}); streams continue.`,
		);
	};

	const compact = (path: string): void => {
		try {
			const kept = readFileSync(path, "utf8")
				.split("\n")
				.filter((line) => line.length > 0)
				.slice(-maxLines);
			writeFileSync(path, kept.length > 0 ? `${kept.join("\n")}\n` : "");
			lines = kept.length;
		} catch {
			// Best-effort: a failed compact is retried on the next overflow.
		}
	};

	return {
		record(entry) {
			try {
				const path = filePath ?? defaultHttpAttemptPath();
				mkdirSync(dirname(path), { recursive: true });
				if (!counted) {
					counted = true;
					lines = existsSync(path) ? countLines(readFileSync(path, "utf8")) : 0;
				}
				appendFileSync(path, `${JSON.stringify(entry)}\n`);
				lines += 1;
				if (lines > maxLines) compact(path);
			} catch (error) {
				warnOnce(error);
			}
		},
	};
}

/** Structural check: a record with a valid kind but missing fields would crash the report. */
function isAttemptRecord(entry: Record<string, unknown>): entry is Record<string, unknown> & HttpAttemptRecord {
	return (
		typeof entry.request_id === "string" &&
		typeof entry.model === "string" &&
		typeof entry.attempt_n === "number" &&
		typeof entry.started_at === "string" &&
		typeof entry.ended_at === "string" &&
		typeof entry.time_to_header_ms === "number" &&
		(entry.status === null || typeof entry.status === "number") &&
		typeof entry.headers === "object" &&
		entry.headers !== null
	);
}

function isResponseRecord(entry: Record<string, unknown>): entry is Record<string, unknown> & HttpResponseRecord {
	return (
		typeof entry.request_id === "string" &&
		typeof entry.model === "string" &&
		typeof entry.attempts === "number" &&
		typeof entry.ended_at === "string" &&
		(entry.duration_ms === null || typeof entry.duration_ms === "number") &&
		(entry.status === null || typeof entry.status === "number")
	);
}

/**
 * Read the sidecar. Malformed lines, unknown record kinds and structurally
 * incomplete rows are skipped; a missing file yields an empty list.
 */
export function readHttpAttempts(filePath?: string): HttpAttemptEntry[] {
	const entries: HttpAttemptEntry[] = [];
	try {
		const path = filePath ?? defaultHttpAttemptPath();
		if (!existsSync(path)) return entries;
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (line.trim().length === 0) continue;
			try {
				const entry = JSON.parse(line) as unknown;
				if (!isObject(entry)) continue;
				if (entry.kind === "attempt" && isAttemptRecord(entry)) {
					entries.push(entry as unknown as HttpAttemptRecord);
				} else if (entry.kind === "response" && isResponseRecord(entry)) {
					entries.push(entry as unknown as HttpResponseRecord);
				}
			} catch {
				// A corrupted line must not break the collector.
			}
		}
	} catch {
		// Unreadable sidecar = no evidence, never a crash.
	}
	return entries;
}

function keepHeader(name: string): boolean {
	const lower = name.toLowerCase();
	return HEADER_WHITELIST.has(lower) || HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Keep only the whitelisted response headers, lowercased and value-capped.
 * Accepts a `Headers` instance (undici/bun) or a plain record (injected test
 * fetches); anything else yields an empty record.
 */
export function pickResponseHeaders(headers: unknown): Record<string, string> {
	const kept: Record<string, string> = {};
	const add = (rawName: string, rawValue: unknown): void => {
		if (typeof rawValue !== "string" || rawValue.length === 0) return;
		if (!keepHeader(rawName)) return;
		kept[rawName.toLowerCase()] = rawValue.slice(0, HEADER_VALUE_MAX_CHARS);
	};

	if (typeof Headers !== "undefined" && headers instanceof Headers) {
		headers.forEach((value, name) => add(name, value));
	} else if (typeof headers === "object" && headers !== null) {
		for (const [name, value] of Object.entries(headers as Record<string, unknown>)) add(name, value);
	}

	return Object.fromEntries(Object.entries(kept).sort(([a], [b]) => a.localeCompare(b)));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Cap on the error body read; gateway error bodies are small, this bounds memory. */
const MAX_ERROR_BODY_BYTES = 8_192;

/**
 * Read only the `type`/`code` of a non-2xx gateway error body. The response is
 * cloned (never consumed) and at most `MAX_ERROR_BODY_BYTES` are read, so the
 * error message, the body and any user content are never stored. Returns nulls
 * when the body is not a JSON error or cannot be read.
 */
async function readGatewayErrorFields(response: Response): Promise<{ type: string | null; code: string | null }> {
	const empty = { type: null, code: null };
	const body = response.clone().body;
	if (!body) return empty;
	let text = "";
	let bytes = 0;
	try {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				bytes += value.byteLength;
				text += decoder.decode(value, { stream: true });
			}
			if (bytes >= MAX_ERROR_BODY_BYTES) {
				await reader.cancel().catch(() => undefined);
				break;
			}
		}
		if (bytes < MAX_ERROR_BODY_BYTES) text += decoder.decode();
	} catch {
		return empty;
	}
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return empty;
	try {
		const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
		if (!isObject(parsed)) return empty;
		// Same two shapes the transcript parser accepts: wrapped or inner object.
		const error = isObject(parsed.error) ? parsed.error : parsed;
		return { type: asString(error.type), code: asString(error.code) };
	} catch {
		return empty;
	}
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The request parameters and serialized size of the final outgoing payload. */
function readRequestParams(payload: unknown): {
	bytes: number | null;
	params: HttpAttemptRequestParams;
} {
	const body = isObject(payload) ? payload : {};
	const params: HttpAttemptRequestParams = {
		reasoning_effort: asString(body.reasoning_effort),
		max_tokens: asNumber(body.max_completion_tokens) ?? asNumber(body.max_tokens),
		max_tokens_field:
			body.max_completion_tokens !== undefined
				? "max_completion_tokens"
				: body.max_tokens !== undefined
					? "max_tokens"
					: null,
		stream: typeof body.stream === "boolean" ? body.stream : null,
	};
	let bytes: number | null = null;
	try {
		bytes = new TextEncoder().encode(JSON.stringify(payload) ?? "").length;
	} catch {
		bytes = null;
	}
	return { bytes, params };
}

export interface HttpAttemptCaptureOptions {
	sink: HttpAttemptSink;
	/** Injectable clock for deterministic tests. */
	now?: () => Date;
	/** Injectable logical-request id generator (default: `randomUUID`). */
	requestId?: () => string;
}

interface OpenAttempt {
	model: string;
	start: number;
	end: number | undefined;
}

/** Window used for the 60 s start counters. */
const START_WINDOW_MS = 60_000;

/**
 * Wrap an api so every HTTP attempt is observed. Only the `fetch` option and
 * the observation hooks are added; the stream, its events and its terminal
 * message are untouched. Caller-supplied hooks are preserved and chained after
 * the observation.
 */
export function withHttpAttemptCapture(api: ProviderStreams, options: HttpAttemptCaptureOptions): ProviderStreams {
	const now = options.now ?? (() => new Date());
	const nextRequestId = options.requestId ?? (() => randomUUID());
	const open: OpenAttempt[] = [];
	const starts: Array<{ model: string; at: number }> = [];

	const countOpen = (at: number, model: string): { all: number; sameModel: number } => {
		let all = 0;
		let sameModel = 0;
		for (const attempt of open) {
			if (attempt.start <= at && attempt.end === undefined) {
				all += 1;
				if (attempt.model === model) sameModel += 1;
			}
		}
		return { all, sameModel };
	};

	/** Drop start records older than the window so memory stays bounded. */
	const pruneStarts = (at: number): void => {
		let keepFrom = 0;
		while (keepFrom < starts.length && starts[keepFrom]!.at < at - START_WINDOW_MS * 5) keepFrom += 1;
		if (keepFrom > 0) starts.splice(0, keepFrom);
		// Concurrent attempts all settle; drop the closed ones older than the window.
		for (let i = open.length - 1; i >= 0; i -= 1) {
			const attempt = open[i]!;
			if (attempt.end !== undefined && attempt.end < at - START_WINDOW_MS * 5) open.splice(i, 1);
		}
	};

	const observe = <T extends object | undefined>(
		run: (streamOptions: T) => ReturnType<ProviderStreams["stream"]>,
		modelId: string,
		streamOptions: T,
	): ReturnType<ProviderStreams["stream"]> => {
		const requestId = nextRequestId();
		const opts = { ...((streamOptions ?? {}) as Record<string, unknown>) };
		const state: {
			payloadBytes: number | null;
			request: HttpAttemptRequestParams | null;
			id: string | null;
			created: number | null;
			attempts: number;
			lastStatus: number | null;
			firstStart: number | null;
			finishReason: string | null;
			streamErrorType: string | null;
			streamErrorCode: string | null;
		} = {
			payloadBytes: null,
			request: null,
			id: null,
			created: null,
			attempts: 0,
			lastStatus: null,
			firstStart: null,
			finishReason: null,
			streamErrorType: null,
			streamErrorCode: null,
		};

		const userOnPayload = opts.onPayload;
		opts.onPayload = async (payload: unknown, model: unknown) => {
			const measured = readRequestParams(payload);
			state.payloadBytes = measured.bytes;
			state.request = measured.params;
			if (typeof userOnPayload === "function") {
				return (userOnPayload as (p: unknown, m: unknown) => unknown)(payload, model);
			}
			return undefined;
		};

		const userOnStreamEvent = opts.onProviderStreamEvent;
		opts.onProviderStreamEvent = async (chunk: unknown, model: unknown) => {
			if (isObject(chunk)) {
				const id = asString(chunk.id);
				if (id) state.id = id;
				const created = asNumber(chunk.created);
				if (created !== null) state.created = created;
				const choices = chunk.choices;
				if (Array.isArray(choices) && isObject(choices[0]) && typeof choices[0].finish_reason === "string") {
					state.finishReason = choices[0].finish_reason;
				}
				if (isObject(chunk.error)) {
					state.streamErrorType = asString(chunk.error.type);
					state.streamErrorCode = asString(chunk.error.code);
				}
			}
			if (typeof userOnStreamEvent === "function") {
				return (userOnStreamEvent as (c: unknown, m: unknown) => unknown)(chunk, model);
			}
			return undefined;
		};

		const baseFetch = (opts.fetch as typeof fetch | undefined) ?? globalThis.fetch;
		const tapFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const at = now().getTime();
			pruneStarts(at);
			if (state.firstStart === null) state.firstStart = at;
			const concurrent = countOpen(at, modelId);
			const recentStarts = starts.filter((start) => start.at >= at - START_WINDOW_MS).length + 1;
			const recentSameModel =
				starts.filter((start) => start.at >= at - START_WINDOW_MS && start.model === modelId).length + 1;
			const tracked: OpenAttempt = { model: modelId, start: at, end: undefined };
			const attempt_n = (state.attempts += 1);
			open.push(tracked);
			starts.push({ model: modelId, at });

			const record = (
				endedMs: number,
				status: number | null,
				headers: Record<string, string>,
				errorType: string | null,
				errorCode: string | null,
				transportError: string | null,
			): void => {
				// The HTTP attempt ends when the headers arrive; the body read below is
				// instrumentation, so it must not inflate the concurrency counters.
				tracked.end = endedMs;
				state.lastStatus = status;
				const entry: HttpAttemptRecord = {
					kind: "attempt",
					request_id: requestId,
					attempt_n,
					model: modelId,
					started_at: new Date(at).toISOString(),
					ended_at: new Date(endedMs).toISOString(),
					time_to_header_ms: Math.max(0, endedMs - at),
					status,
					headers,
					payload_bytes: state.payloadBytes,
					request: state.request,
					inflight_process_at_start: concurrent.all,
					inflight_same_model_at_start: concurrent.sameModel,
					starts_last_60s_process: recentStarts,
					starts_last_60s_same_model: recentSameModel,
					error_type: errorType,
					error_code: errorCode,
					transport_error: transportError,
				};
				try {
					options.sink.record(entry);
				} catch {
					// Evidence capture is best-effort; never break the turn.
				}
			};

			try {
				const response = await baseFetch(input, init);
				const headerMs = now().getTime();
				const gatewayError = response.status >= 400 ? await readGatewayErrorFields(response) : null;
				record(
					headerMs,
					response.status,
					pickResponseHeaders(response.headers),
					gatewayError?.type ?? null,
					gatewayError?.code ?? null,
					null,
				);
				return response;
			} catch (error) {
				const name = isObject(error) && typeof error.name === "string" && error.name.length > 0 ? error.name : "Error";
				record(now().getTime(), null, {}, null, null, name);
				throw error;
			}
		}) as typeof fetch;
		opts.fetch = tapFetch;

		const stream = run(opts as T);

		stream.result().then(
			(message: AssistantMessage | undefined) => {
				const ended = now();
				// pi-ai persists only the id; prefer the raw chunk, fall back to it.
				const responseId = state.id ?? asString(message?.responseId);
				const usage = isObject(message?.usage)
					? {
							prompt_tokens: numberOrZero(message?.usage.input),
							completion_tokens: numberOrZero(message?.usage.output),
							reasoning_tokens: numberOrZero(message?.usage.reasoning),
							cache_read_tokens: numberOrZero(message?.usage.cacheRead),
						}
					: null;
				const entry: HttpResponseRecord = {
					kind: "response",
					request_id: requestId,
					model: modelId,
					response_id: responseId,
					created: state.created,
					status: state.lastStatus,
					attempts: state.attempts,
					ended_at: ended.toISOString(),
					duration_ms: state.firstStart === null ? null : Math.max(0, ended.getTime() - state.firstStart),
					request: state.request,
					usage,
					finish_reason: state.finishReason,
					error_type: state.streamErrorType,
					error_code: state.streamErrorCode,
				};
				try {
					options.sink.record(entry);
				} catch {
					// Evidence capture is best-effort; never break the turn.
				}
			},
			() => undefined,
		);

		return stream;
	};

	return {
		...api,
		stream: (model, context, streamOptions) =>
			observe((next) => api.stream(model, context, next), model.id, streamOptions),
		streamSimple: (model, context, streamOptions) =>
			observe((next) => api.streamSimple(model, context, next), model.id, streamOptions),
	};
}

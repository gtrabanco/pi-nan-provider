/**
 * NaN gateway cache-anomaly evidence capture (issue #35).
 *
 * Issue #17 identified NaN's gateway response cache: identical requests sent
 * back-to-back can return the same completion `id` AND the same `created`
 * timestamp — a replayed cache entry, not a new generation. NaN could not
 * reproduce it and asked for "modelo y cf-ray de un par de llamadas". pi's
 * session JSONL records usage and response ids but no response headers, so the
 * provider is the only surface that can keep the `cf-ray` of both calls.
 *
 * This module:
 *   - reads `cf-ray` from pi-ai's `onResponse` hook (the only header surface),
 *   - reads the raw gateway `id`/`created` pair from `onProviderStreamEvent`
 *     chunks (pi-ai only persists `id` as `AssistantMessage.responseId`),
 *   - compares each completed stream with the previous one for the same model,
 *     and when both `id` and `created` repeat, appends one JSONL record to
 *     `<agentDir>/nan-cache-anomalies.jsonl`.
 *
 * The record deliberately carries no prompt or response content, no
 * credentials and no paths: only the model, the gateway pair, both `cf-ray`
 * values, ISO timestamps and a SHA-256 fingerprint of the request payload
 * (used to say whether the duplicate arrived for the same payload). It is
 * local-only — nothing is uploaded.
 *
 * A missing `onResponse` (older pi-ai or a host that does not call it) simply
 * leaves `cf_ray` null; detection still works on `id`+`created`. Every write is
 * best-effort: a full disk must never break a stream.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ProviderStreams } from "@earendil-works/pi-ai";

/** Default file name inside pi's agent dir. */
export const CACHE_ANOMALY_FILE = "nan-cache-anomalies.jsonl";

/** The only anomaly kind captured here (issue #17 signature). */
export const CACHE_ANOMALY_KIND = "duplicate_id_created";

export interface CacheAnomalyRequest {
	/** Cloudflare trace id (`cf-ray`) of the response, when the host exposed it. */
	cf_ray: string | null;
	/** ISO timestamp of when the response headers were observed. */
	observed_at: string;
	/** SHA-256 of the outgoing request payload, null when unavailable. */
	payload_sha256: string | null;
}

/**
 * One persisted anomaly. Both requests returned the same gateway `id` and
 * `created`; `requests` carries each call's `cf-ray` and timestamp.
 */
export interface CacheAnomalyRecord {
	detected_at: string;
	kind: typeof CACHE_ANOMALY_KIND;
	model: string;
	id: string;
	created: number;
	/** Whether both streams sent the same request payload. */
	payload_match: boolean;
	requests: [CacheAnomalyRequest, CacheAnomalyRequest];
}

export interface CacheAnomalySink {
	record(record: CacheAnomalyRecord): void;
}

/** The anomaly file path for the current pi agent dir. */
export function defaultCacheAnomalyPath(): string {
	return join(getAgentDir(), CACHE_ANOMALY_FILE);
}

/**
 * File sink: append one JSON line per anomaly, creating the agent dir if
 * needed. Never throws — the first failure warns once, then stays quiet so a
 * broken disk cannot spam the console or break a turn.
 */
export function createCacheAnomalyFileSink(filePath?: string): CacheAnomalySink {
	let warned = false;
	return {
		record(record) {
			try {
				const target = filePath ?? defaultCacheAnomalyPath();
				mkdirSync(dirname(target), { recursive: true });
				appendFileSync(target, `${JSON.stringify(record)}\n`);
			} catch (error) {
				if (warned) return;
				warned = true;
				console.warn(
					`[pi-nan-provider] could not persist cache-anomaly evidence (${error instanceof Error ? error.message : String(error)}); streams continue.`,
				);
			}
		},
	};
}

export interface CacheAnomalyCaptureOptions {
	sink: CacheAnomalySink;
	/** Injectable clock for deterministic tests. */
	now?: () => Date;
}

interface Observation {
	cfRay: string | null;
	observedAt: string;
	payloadSha: string | null;
	id?: string;
	created?: number;
}

interface LastResponse {
	id: string;
	created: number;
	cfRay: string | null;
	observedAt: string;
	payloadSha: string | null;
	/** Set once the duplicate pair was reported; suppresses burst cascades. */
	recorded: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Case-insensitive header lookup (undici lowercases `Headers`, proxies may not). */
function headerValue(headers: Record<string, string> | undefined, name: string): string | null {
	if (!headers) return null;
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === wanted && typeof value === "string" && value.length > 0) return value;
	}
	return null;
}

/** SHA-256 of the payload; null when it cannot be serialized. */
export function fingerprintPayload(payload: unknown): string | null {
	try {
		return createHash("sha256").update(JSON.stringify(payload) ?? "").digest("hex");
	} catch {
		return null;
	}
}

/** Extract `id`/`created` from a raw openai-completions chunk. */
export function gatewayPairFromChunk(chunk: unknown): { id?: string; created?: number } {
	if (!isObject(chunk)) return {};
	const id = typeof chunk.id === "string" && chunk.id.length > 0 ? chunk.id : undefined;
	const rawCreated = chunk.created;
	const created =
		typeof rawCreated === "number" && Number.isFinite(rawCreated)
			? rawCreated
			: typeof rawCreated === "string" && /^\d+$/.test(rawCreated)
				? Number(rawCreated)
				: undefined;
	return { ...(id ? { id } : {}), ...(created !== undefined ? { created } : {}) };
}

/**
 * Wrap an api so completed streams are compared pairwise per model. Only the
 * hooks are added; the stream, its events and its terminal message are
 * untouched. Any caller-supplied `onResponse`, `onPayload` and
 * `onProviderStreamEvent` are preserved and chained after the observation.
 */
export function withCacheAnomalyCapture(api: ProviderStreams, options: CacheAnomalyCaptureOptions): ProviderStreams {
	const now = options.now ?? (() => new Date());
	const lastByModel = new Map<string, LastResponse>();

	const observe = <T extends object | undefined>(
		run: (streamOptions: T) => ReturnType<ProviderStreams["stream"]>,
		modelId: string,
		streamOptions: T,
	): ReturnType<ProviderStreams["stream"]> => {
		const state: Observation = { cfRay: null, observedAt: now().toISOString(), payloadSha: null };
		const opts = { ...((streamOptions ?? {}) as Record<string, unknown>) };

		const userOnResponse = opts.onResponse;
		opts.onResponse = async (response: unknown, model: unknown) => {
			if (isObject(response)) {
				state.cfRay = headerValue(response.headers as Record<string, string> | undefined, "cf-ray");
				state.observedAt = now().toISOString();
			}
			if (typeof userOnResponse === "function") {
				return (userOnResponse as (r: unknown, m: unknown) => unknown)(response, model);
			}
			return undefined;
		};

		const userOnPayload = opts.onPayload;
		opts.onPayload = async (payload: unknown, model: unknown) => {
			state.payloadSha = fingerprintPayload(payload);
			if (typeof userOnPayload === "function") {
				return (userOnPayload as (p: unknown, m: unknown) => unknown)(payload, model);
			}
			return undefined;
		};

		const userOnStreamEvent = opts.onProviderStreamEvent;
		opts.onProviderStreamEvent = async (chunk: unknown, model: unknown) => {
			const pair = gatewayPairFromChunk(chunk);
			if (pair.id) state.id = pair.id;
			if (pair.created !== undefined) state.created = pair.created;
			if (typeof userOnStreamEvent === "function") {
				return (userOnStreamEvent as (c: unknown, m: unknown) => unknown)(chunk, model);
			}
			return undefined;
		};

		const stream = run(opts as T);

		const complete = (message: AssistantMessage | undefined) => {
			// pi-ai persists only the id; keep it as a fallback when the raw
			// chunks did not carry one.
			const id = state.id ?? message?.responseId;
			if (!id || state.created === undefined) return;

			const current: LastResponse = {
				id,
				created: state.created,
				cfRay: state.cfRay,
				observedAt: state.observedAt,
				payloadSha: state.payloadSha,
				recorded: false,
			};
			const previous = lastByModel.get(modelId);
			if (previous && previous.id === current.id && previous.created === current.created) {
				if (!previous.recorded) {
					const record: CacheAnomalyRecord = {
						detected_at: now().toISOString(),
						kind: CACHE_ANOMALY_KIND,
						model: modelId,
						id: current.id,
						created: current.created,
						payload_match:
							previous.payloadSha !== null &&
							current.payloadSha !== null &&
							previous.payloadSha === current.payloadSha,
						requests: [
							{
								cf_ray: previous.cfRay,
								observed_at: previous.observedAt,
								payload_sha256: previous.payloadSha,
							},
							{
								cf_ray: current.cfRay,
								observed_at: current.observedAt,
								payload_sha256: current.payloadSha,
							},
						],
					};
					try {
						options.sink.record(record);
					} catch {
						// Evidence capture is best-effort; never break the turn.
					}
				}
				lastByModel.set(modelId, { ...previous, recorded: true });
				return;
			}
			lastByModel.set(modelId, current);
		};

		stream.result().then(complete, () => {
			// A failed stream has no gateway pair worth comparing.
		});
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

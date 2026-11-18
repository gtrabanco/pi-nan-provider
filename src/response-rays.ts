/**
 * Persistent per-response `cf-ray` capture (issue #35 S11, owner order
 * 2026-11-18: "El cf-ray hay que incluirlo en el reporte de debug").
 *
 * NaN support correlates edge/origin logs by Cloudflare's trace id, and the
 * anomaly pair in `nan-cache-anomalies.jsonl` only exists after the #17
 * signature recurs. This sidecar closes the gap: every stream that produced a
 * gateway `id` and saw a `cf-ray` response header appends one JSONL record —
 * success or failure — so the debug report can join `cf_ray` onto any turn
 * without waiting for a recurrence.
 *
 * Contract:
 *   - exactly four fields per record: `response_id`, `cf_ray`, `model`,
 *     `observed_at` — no content, no credentials, no paths;
 *   - local-only; writes are best-effort (never break a stream, warn once);
 *   - bounded: the newest `RESPONSE_RAYS_MAX_LINES` lines are kept, compacted
 *     deterministically; concurrent writers may interleave (same best-effort
 *     contract as the anomaly sink);
 *   - reading tolerates a missing or corrupted file — no rays, no crash.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Default file name inside pi's agent dir. */
export const RESPONSE_RAYS_FILE = "nan-response-rays.jsonl";

/** Lines kept after a compact: newest first-in, oldest dropped. */
export const RESPONSE_RAYS_MAX_LINES = 50_000;

/** One persisted response ray: exactly the fields the join and support need. */
export interface ResponseRayRecord {
	/** Gateway completion id (`AssistantMessage.responseId`), unique per response. */
	response_id: string;
	/** Cloudflare trace id of that response. */
	cf_ray: string;
	model: string;
	/** ISO timestamp of when the response headers were observed. */
	observed_at: string;
}

export interface ResponseRaySink {
	record(record: ResponseRayRecord): void;
}

/** The response-ray file path for the current pi agent dir. */
export function defaultResponseRayPath(): string {
	return join(getAgentDir(), RESPONSE_RAYS_FILE);
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	const lines = text.split("\n").length;
	return text.endsWith("\n") ? lines - 1 : lines;
}

/**
 * File sink: append one JSON line per response, keeping the file bounded by
 * `maxLines` (compact keeps the newest lines). Never throws — the first
 * failure warns once, then stays quiet so a broken disk cannot spam the
 * console or break a turn. The line counter is initialised once per sink
 * from the existing file, then maintained in process.
 */
export function createResponseRayFileSink(filePath?: string, options: { maxLines?: number } = {}): ResponseRaySink {
	const maxLines = options.maxLines ?? RESPONSE_RAYS_MAX_LINES;
	let warned = false;
	let counted = false;
	let lines = 0;

	const warnOnce = (error: unknown): void => {
		if (warned) return;
		warned = true;
		console.warn(
			`[pi-nan-provider] could not persist response-ray evidence (${error instanceof Error ? error.message : String(error)}); streams continue.`,
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
		record(record) {
			try {
				const path = filePath ?? defaultResponseRayPath();
				mkdirSync(dirname(path), { recursive: true });
				if (!counted) {
					counted = true;
					lines = existsSync(path) ? countLines(readFileSync(path, "utf8")) : 0;
				}
				appendFileSync(path, `${JSON.stringify(record)}\n`);
				lines += 1;
				if (lines > maxLines) compact(path);
			} catch (error) {
				warnOnce(error);
			}
		},
	};
}

/**
 * Read the sidecar into a `response_id → cf_ray` map for the report join.
 * Later lines win for a repeated id; malformed lines are skipped; a missing
 * file yields an empty map.
 */
export function readResponseRays(filePath?: string): Map<string, string> {
	const rays = new Map<string, string>();
	try {
		const path = filePath ?? defaultResponseRayPath();
		if (!existsSync(path)) return rays;
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (line.trim().length === 0) continue;
			try {
				const entry = JSON.parse(line) as Partial<ResponseRayRecord>;
				if (
					typeof entry.response_id === "string" &&
					typeof entry.cf_ray === "string" &&
					entry.cf_ray.length > 0
				) {
					rays.set(entry.response_id, entry.cf_ray);
				}
			} catch {
				// A corrupted line must not break the collector.
			}
		}
	} catch {
		// Unreadable sidecar = no rays, never a crash.
	}
	return rays;
}

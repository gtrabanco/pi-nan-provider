/**
 * `/nan-debug` — deterministic, redacted NaN evidence collector (issue #35).
 *
 * NaN could not reproduce the prompt-cache anomaly and asked for "modelo y
 * cf-ray de un par de llamadas". This module reads pi's session JSONL (usage,
 * stop reasons, response ids) plus the local cache-anomaly capture
 * (`nan-cache-anomalies.jsonl`, which holds the anomaly `cf-ray` pair) and
 * the per-response ray sidecar (`nan-response-rays.jsonl`, issue #35 S11),
 * and renders a report that can be shared verbatim.
 *
 * Contract (issue #35, scoped by PR #44 and issue #49):
 *   - no LLM, no network unless `--window` explicitly asks for `/v1/usage`;
 *   - the default artifact never collects prompt, response or tool content,
 *     credentials or raw paths: `sessions/` is opt-in (`--include-prompts`,
 *     tool calls stripped; `--include-tools` keeps them) and `cwd` is
 *     MD5-hashed whenever it is embedded;
 *   - session and worktree identifiers are MD5-truncated to 16 chars;
 *   - `topic` is hashed (`topic_hash`), never stored in clear;
 *   - error text in rows and the preview is reduced to a fixed class;
 *     `errors.jsonl` stores only the gateway body's own fields (message capped
 *     at 200 chars plus an MD5 hash) and never transport/local exception text;
 *   - `usage_window.json` stays local unless `--all` puts it in the zip;
 *   - the same inputs produce byte-identical zip bytes.
 *
 * The report layout matches the 2026-11-10 anonymized dataset: one aggregated
 * `anonymized_usage.jsonl` row per (date, session, model), plus `turns.jsonl`
 * with the per-turn detail the issue asks for (`response_id`, `created` and
 * `attempt_n` joined from the HTTP attempt tap, usage, stop reason, error class)
 * and `http_attempts.jsonl` with one row per HTTP attempt.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PI_AI_VERSION } from "@earendil-works/pi-ai";
import { VERSION as PI_VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import { GENERATED_CATALOG_META } from "../scripts/models.generated.ts";
import { CACHE_ANOMALY_FILE, defaultCacheAnomalyPath, type CacheAnomalyRecord } from "./cache-anomaly.ts";
import {
	HTTP_ATTEMPTS_FILE,
	defaultHttpAttemptPath,
	readHttpAttempts,
	type HttpAttemptEntry,
	type HttpAttemptRecord,
	type HttpResponseRecord,
} from "./http-attempts.ts";
import { RESPONSE_RAYS_FILE, readResponseRays } from "./response-rays.ts";
import { fetchUsageReport, rollingWindow, type UsageWindow } from "./usage.ts";
import { createZip } from "./zip.ts";

export const DEFAULT_DEBUG_WINDOW_DAYS = 7;
export const MAX_DEBUG_WINDOW_DAYS = 90;

/** Prefix of the default report directory and zip names. */
export const NAN_DEBUG_REPORT_PREFIX = "nan-debug-report";

export const DEBUG_USAGE_LINE =
	"Usage: /nan-debug [topic] [--window N] [--interval FLEXIBLE] [--out file] [--emit] [--include-prompts] [--include-tools] [--all] — collects a redacted NaN evidence report locally; --emit writes the shareable zip.\n\nContent flags: default shares no prompt/response/tool content; --include-prompts embeds raw transcripts; --include-tools also keeps tool calls/results; --all equals both plus usage_window.json.\n\nIntervals: '5min', '2h', '3d', '1mes', '2026-11-10 - 2026-11-11 17:30', '10:30 - 11:00', '2026-11-10 -', max 90 days, mutually exclusive with --window.";

/** A flexible time window with ISO-capable boundaries (YYYY-MM-DD or full ISO 8601). */
export interface DebugWindow {
	/** Inclusive start, YYYY-MM-DD or ISO 8601 (lexicographic comparison works). */
	start: string;
	/** Inclusive end, YYYY-MM-DD or ISO 8601. */
	end: string;
	/** Inclusive day count (for back-compat with --window). */
	days: number;
}

/** A relative span in milliseconds (for "5min", "2h", etc.). */
export interface RelativeSpan {
	kind: "relative";
	/** Span duration in milliseconds. */
	spanMs: number;
}

/** An explicit range (absolute or partial). */
export interface ExplicitRange {
	kind: "range";
	start: string; // ISO string or null (null = fill from window or now)
	end: string; // ISO string or null
}

/** A single point-in-time (interpreted as "from this point to now"). */
export interface SinglePoint {
	kind: "point";
	point: string; // ISO string
}

// ── Artifact naming ───────────────────────────────────────────────────────

function utcStamp(now: Date, separator: string): string {
	const iso = now.toISOString();
	// YYYY-MM-DDTHH:mm:ss in UTC; the date and time parts are already fixed-width.
	return `${iso.slice(0, 10)}T${iso.slice(11, 19).replace(/:/g, separator)}`;
}

/**
 * Default report directory name: `nan-debug-report-YYYY-MM-DDTHH:mm:ss` (UTC).
 * `:` is legal in a POSIX directory name but not on Windows, so the separator
 * follows the platform. The emission timestamp distinguishes runs; the
 * reported window lives in `metadata.window`.
 */
export function debugReportDirName(now: Date, platform: NodeJS.Platform = process.platform): string {
	return `${NAN_DEBUG_REPORT_PREFIX}-${utcStamp(now, platform === "win32" ? "-" : ":")}`;
}

/** Default zip name: the same stamp with `:` sanitized, since zip readers and Windows both dislike it. */
export function debugReportZipName(now: Date): string {
	return `${NAN_DEBUG_REPORT_PREFIX}-${utcStamp(now, "-")}.zip`;
}

// ── Argument parsing ──────────────────────────────────────────────────────

export interface DebugArgs {
	topic?: string;
	/** Day count for --window (1-90). Not used when interval is provided. */
	windowDays: number;
	/** True when `--window` was given; only then is `/v1/usage` consulted. */
	windowProvided: boolean;
	/** Flexible time interval from --interval (replaces --window when provided). */
	interval?: string;
	out?: string;
	emit: boolean;
	/** Embed raw transcripts (prompts and responses) in `sessions/`. */
	includePrompts: boolean;
	/** Also keep tool calls and their results; implies `includePrompts`. */
	includeTools: boolean;
	/** `--include-prompts --include-tools`, plus `usage_window.json` in the zip. */
	all: boolean;
}

export type ParseDebugArgsResult = { ok: true; args: DebugArgs } | { ok: false; error: string };

const TOPIC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** Parse `/nan-debug` arguments. Deterministic; no filesystem or clock access. */
export function parseDebugArgs(input: string): ParseDebugArgsResult {
	const tokens = input.trim().split(/\s+/).filter(Boolean);
	const args: DebugArgs = {
		windowDays: DEFAULT_DEBUG_WINDOW_DAYS,
		windowProvided: false,
		emit: false,
		includePrompts: false,
		includeTools: false,
		all: false,
	};

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token === "--emit") {
			args.emit = true;
			continue;
		}
		if (token === "--include-prompts") {
			args.includePrompts = true;
			continue;
		}
		if (token === "--include-tools") {
			// "incluye además": tool calls only exist inside a transcript.
			args.includeTools = true;
			args.includePrompts = true;
			continue;
		}
		if (token === "--all") {
			args.all = true;
			args.includePrompts = true;
			args.includeTools = true;
			continue;
		}
		if (token === "--window") {
			const value = tokens[i + 1];
			if (value === undefined) return { ok: false, error: `--window needs a day count (1-${MAX_DEBUG_WINDOW_DAYS}). ${DEBUG_USAGE_LINE}` };
			i += 1;
			if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_DEBUG_WINDOW_DAYS) {
				return { ok: false, error: `Invalid --window "${value}". ${DEBUG_USAGE_LINE}` };
			}
			args.windowDays = Number(value);
			args.windowProvided = true;
			continue;
		}
		if (token === "--interval") {
			// The value spans every token up to the next `--` flag: pi passes the
			// command text raw and unquoted (PE-010), so a range like
			// "2026-11-10 - 2026-11-11 17:30" arrives as several whitespace tokens.
			const parts: string[] = [];
			let j = i + 1;
			while (j < tokens.length && !tokens[j]!.startsWith("--")) {
				parts.push(tokens[j]!);
				j += 1;
			}
			if (parts.length === 0) {
				const next = tokens[i + 1];
				return next === undefined
					? { ok: false, error: `--interval needs a time description. ${DEBUG_USAGE_LINE}` }
					: { ok: false, error: `--interval needs a time description (got "${next}"). ${DEBUG_USAGE_LINE}` };
			}
			i = j - 1;
			let value = parts.join(" ");
			// Strip one layer of surrounding quotes (`--interval " - 2026-11-10"`).
			if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
				value = value.slice(1, -1).trim();
			}
			if (value.length === 0) return { ok: false, error: `--interval needs a time description. ${DEBUG_USAGE_LINE}` };
			args.interval = value;
			continue;
		}
		if (token === "--out") {
			const value = tokens[i + 1];
			if (value === undefined || value.length === 0) return { ok: false, error: `--out needs a file or directory path. ${DEBUG_USAGE_LINE}` };
			// A flag token here is a missing value, not a path: consuming `--emit` or
			// `--window` as the value would silently drop an explicit option (EV-2026-11-11 A1).
			if (value.startsWith("--")) return { ok: false, error: `--out needs a file or directory path (got "${value}"). ${DEBUG_USAGE_LINE}` };
			i += 1;
			args.out = value;
			continue;
		}
		if (token.startsWith("--")) return { ok: false, error: `Unknown option "${token}". ${DEBUG_USAGE_LINE}` };
		if (args.topic !== undefined) return { ok: false, error: `Unexpected argument "${token}". ${DEBUG_USAGE_LINE}` };
		if (!TOPIC_PATTERN.test(token)) {
			return { ok: false, error: `Invalid topic "${token}" (use 1-32 chars: letters, digits, "_" or "-"). ${DEBUG_USAGE_LINE}` };
		}
		args.topic = token;
	}

	// --window and --interval are mutually exclusive
	if (args.windowProvided && args.interval) {
		return { ok: false, error: `Cannot use --window and --interval together. --window expects a day count; --interval accepts flexible time descriptions. ${DEBUG_USAGE_LINE}` };
	}

	return { ok: true, args };
}

// ── Flexible time interval parsing ────────────────────────────────────────

/** Max allowed span in ms: 90 days. */
const MAX_INTERVAL_MS = 90 * 86_400_000;

const TIME_UNITS: ReadonlyMap<string, number> = new Map([
	["min", 60_000],
	["minute", 60_000],
	["minutes", 60_000],
	["m", 60_000],
	["hour", 3_600_000],
	["hours", 3_600_000],
	["h", 3_600_000],
	["hr", 3_600_000],
	["d", 86_400_000],
	["day", 86_400_000],
	["days", 86_400_000],
	["mes", 30 * 86_400_000],
	["month", 30 * 86_400_000],
	["año", 365 * 86_400_000],
	["year", 365 * 86_400_000],
]);

/** Parse a standalone relative span like "5min", "2h", "3d": null when it is not a relative span, the explicit cap error when it exceeds 90 days. */
function tryParseRelativeSpan(input?: string): RelativeSpan | { error: string } | null {
	if (!input) return null;
	const match = /^(\d+)\s*(\S+)$/.exec(input.trim());
	if (!match) return null;
	const [, amountStr, unit] = match;
	if (typeof amountStr !== "string" || typeof unit !== "string") return null;
	if (Number(amountStr) <= 0) return null;
	const spanMs = TIME_UNITS.get(unit);
	if (!spanMs) return null;
	const total = Number(amountStr) * spanMs;
	if (total > MAX_INTERVAL_MS) return { error: `Interval too large (max 90 days).` };
	return { kind: "relative" as const, spanMs: total };
}

/** ISO 8601 date-time regex: YYYY-MM-DD[T ]HH:MM[:SS[.mmm]][Z] */
const ISO_PARTIAL = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?)?Z?$/;

/** Parse a partial ISO string to a Date. Missing components get sensible defaults. */
function parsePartialISO(value: string): Date | null {
	const m = ISO_PARTIAL.exec(value.trim());
	if (!m) return null;
	const [, yearStr, monthStr, dayStr, hourStr, minStr, secStr, msStr] = m;
	const year = Number(yearStr);
	const month = Number(monthStr);
	if (year < 1900 || year > 9999 || month < 1 || month > 12) return null;
	const day = dayStr ? Number(dayStr) : 1;
	if (day < 1 || day > 31) return null;
	const hour = hourStr ? Number(hourStr) : 0;
	if (hour > 23) return null;
	const min = minStr ? Number(minStr) : 0;
	if (min > 59) return null;
	const sec = secStr ? Number(secStr) : 0;
	if (sec > 59) return null;
	let ms = 0;
	if (msStr) {
		// Pad or truncate to 3 digits
		const padded = (msStr + "000").slice(0, 3);
		ms = Number(padded);
	}
	// Use UTC to avoid timezone confusion
	try {
		return new Date(Date.UTC(year, month - 1, day, hour, min, sec, ms));
	} catch {
		return null;
	}
}

/**
 * Build a full ISO 8601 UTC string (always `YYYY-MM-DDTHH:mm:ss.sssZ`) so
 * interval bounds compare lexicographically against day-granular dates once
 * `slice(0, 10)` is applied.
 */
function dateToISO(d: Date): string {
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	const h = String(d.getUTCHours()).padStart(2, "0");
	const mi = String(d.getUTCMinutes()).padStart(2, "0");
	const s = String(d.getUTCSeconds()).padStart(2, "0");
	return `${y}-${m}-${day}T${h}:${mi}:${s}.${d.getUTCMilliseconds().toString().padStart(3, "0")}Z`;
}

/**
 * Main parser: converts a freeform time description into a DebugWindow.
 * Handles: relative spans, explicit ranges ("2026-11-10 - 2026-11-11 17:30"),
 * single dates, partial times ("10:30 - 11:00"), etc.
 */
export function parseFlexibleTime(input: string, now: Date): DebugWindow | { ok: false; error: string } {
	const trimmed = input.trim();
	if (trimmed.length === 0) return { ok: false, error: `--interval requires a time description. ${DEBUG_USAGE_LINE}` };

	// 1. Try relative span: "5min", "2h", "3d", "1mes"
	const relative = tryParseRelativeSpan(trimmed);
	if (relative) {
		if ("error" in relative) return { ok: false, error: relative.error };
		return {
			start: dateToISO(new Date(now.getTime() - relative.spanMs)),
			end: dateToISO(now),
			days: Math.max(1, Math.round(relative.spanMs / 86_400_000)),
		};
	}

	// 2. Open left: "- <date>" — from the default window's start until <date>
	//    (issue #44: "inicio del window hasta 10 nov").
	const openLeft = /^-\s+(.+)$/.exec(trimmed);
	if (openLeft?.[1]) {
		const right = openLeft[1].trim();
		const end = parseTimeToken(right, now, false);
		if (!end) {
			return { ok: false, error: `Cannot parse interval "${trimmed}". Use "- 2026-11-10" to run from the default window's start until a date.` };
		}
		const start = new Date(`${rollingWindow(DEFAULT_DEBUG_WINDOW_DAYS, now).start}T00:00:00.000Z`);
		const spanMs = end.getTime() - start.getTime();
		if (spanMs <= 0) return { ok: false, error: `Start (${dateToISO(start)}) must be before end (${right}).` };
		if (spanMs > MAX_INTERVAL_MS) return { ok: false, error: `Interval too large (max 90 days).` };
		return { start: dateToISO(start), end: dateToISO(end), days: Math.max(1, Math.round(spanMs / 86_400_000)) };
	}

	// 3. Try range: split on " - " (dash with spaces)
	// Match " - " but not "--" or "-" at edges
	const rangeMatch = /^(.+?)\s+-\s+(.+)$/.exec(trimmed);
	if (rangeMatch?.[1] && rangeMatch?.[2]) {
		const left = rangeMatch[1].trim();
		const right = rangeMatch[2].trim();
		return parseRange(left, right, now);
	}

	// 4. Open right: "<date> -" — from <date> until now (issue #44).
	const openRight = /^(.+?)\s+-\s*$/.exec(trimmed);
	if (openRight?.[1]) {
		const left = openRight[1].trim();
		const start = parseTimeToken(left, now, true);
		if (!start) {
			return { ok: false, error: `Cannot parse interval "${trimmed}". Use "2026-11-10 -" to run from a date until now.` };
		}
		const spanMs = now.getTime() - start.getTime();
		if (spanMs <= 0) return { ok: false, error: `Start (${left}) must be before now.` };
		if (spanMs > MAX_INTERVAL_MS) return { ok: false, error: `Interval too large (max 90 days).` };
		return { start: dateToISO(start), end: dateToISO(now), days: Math.max(1, Math.round(spanMs / 86_400_000)) };
	}

	// 5. Try single date/time: parse as a single point, default end to now
	const point = parsePartialISO(trimmed);
	if (point) {
		const spanMs = now.getTime() - point.getTime();
		return {
			start: dateToISO(point),
			end: dateToISO(now),
			days: Math.max(1, Math.round(spanMs / 86_400_000)),
		};
	}

	return { ok: false, error: `Cannot parse interval "${trimmed}". Use relative (5min, 2h, 3d), date ranges (2026-11-10 - 2026-11-11 17:30), or single dates.` };
}

/**
 * Parse a range: "left - right". Each side can be a date, time, or partial.
 * "now" provides the default date when no date component is present.
 */
function parseRange(left: string, right: string, now: Date): DebugWindow | { ok: false; error: string } {
	const start = parseTimeToken(left, now, true);
	const end = parseTimeToken(right, now, false);

	if (!start || !end) {
		return { ok: false, error: `Cannot parse range "${left} - ${right}". Use dates (2026-11-10), times (10:30 - 11:00), or both.` } as const;
	}

	// Cross-midnight detection: time-only tokens fall back to `now`'s calendar
	// day (parseTimeToken's fallbackDate), so an end before the start on that
	// same day means the end belongs to the next day — "23:00 - 01:00" becomes
	// 23:00 → 01:00 next day. Everything reads UTC (EV-2026-11-18 A4: the
	// local-time variant of this check was dead code, outcome-identical).
	if (end.getTime() < start.getTime()) {
		const sameCalendarDay = start.getUTCFullYear() === end.getUTCFullYear()
			&& start.getUTCMonth() === end.getUTCMonth()
			&& start.getUTCDate() === end.getUTCDate();
		if (sameCalendarDay) {
			end.setUTCDate(end.getUTCDate() + 1);
		}
	}

	const spanMs = end.getTime() - start.getTime();
	if (spanMs <= 0) {
		return { ok: false, error: `Start (${left}) must be before end (${right}).` };
	}
	if (spanMs > MAX_INTERVAL_MS) {
		return { ok: false, error: `Interval too large (max 90 days).` };
	}

	return {
		start: dateToISO(start),
		end: dateToISO(end),
		days: Math.max(1, Math.round(spanMs / 86_400_000)),
	};
}

/**
 * Parse a single time token: could be a full date, a date+time, a time-only,
 * or a partial date. Falls back to `fallbackDate` for missing components.
 * Returns a Date with the parsed components applied to fallbackDate's date.
 */
function parseTimeToken(token: string, fallbackDate: Date, _isStart: boolean): Date | null {
	// Try full ISO first
	const d = parsePartialISO(token);
	if (d) return d;

	// Try time-only: HH:MM[:SS]
	const timeOnly = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(token.trim());
	if (timeOnly) {
		const [, hStr, mStr, sStr] = timeOnly;
		const h = Number(hStr);
		const m = Number(mStr);
		const s = sStr ? Number(sStr) : 0;
		if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59) return null;
		const result = new Date(fallbackDate);
		// Keep same date as fallback
		result.setUTCHours(h, m, s, 0);
		return result;
	}

	return null;
}

// ── Error classification ──────────────────────────────────────────────────

export type DebugErrorClass = "overflow" | "rate_limited" | "invalid_request" | "transport" | "other";

const ERROR_PATTERNS: ReadonlyArray<readonly [DebugErrorClass, RegExp]> = [
	["overflow", /context (?:overflow|window|length)|prompt is too long|maximum context|too many tokens|exceeds? (?:the )?(?:model'?s )?context|origin_response_timeout|\b524\b/i],
	["rate_limited", /rate.?limit|too many requests|\b429\b/i],
	["invalid_request", /invalid request|check your request parameters|\b400\b/i],
	["transport", /timed? ?out|timeout|aborted|abort|network|fetch failed|econn|etimedout|socket|stream ended|ended without|reasoning-only stream guard/i],
];

/**
 * Map a raw `errorMessage` to a fixed class. Rows, previews and aggregates
 * only ever see this class; the raw text reaches the report solely as
 * `errors.jsonl`'s 200-character fragment plus its MD5 hash (PR #44).
 */
export function classifyErrorMessage(message: string | undefined): DebugErrorClass | null {
	if (typeof message !== "string" || message.length === 0) return null;
	for (const [kind, pattern] of ERROR_PATTERNS) {
		if (pattern.test(message)) return kind;
	}
	return "other";
}

function isReasoningOnlyStreamError(message: string | undefined): boolean {
	return typeof message === "string" && /reasoning-only stream guard/i.test(message);
}

// ── Report types ──────────────────────────────────────────────────────────

export interface DebugUsageRow {
	date: string;
	session_id: string;
	worktree_label: string;
	model: string;
	turns: number;
	total_tokens: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	reasoning_tokens: number;
	avg_tokens_per_turn: number;
	cache_hit_rate_pct: number;
	stop_reason_counts: Record<string, number>;
	anomalies: Array<{ kind: string; detected_at: string }>;
}

export interface DebugTurn {
	date: string;
	session_id: string;
	worktree_label: string;
	turn: number;
	timestamp: string;
	model: string;
	stop_reason: string;
	error: DebugErrorClass | null;
	response_id: string | null;
	/** Cloudflare trace id joined from the response-ray sidecar; null when uncaptured. */
	cf_ray: string | null;
	/** Gateway `created` joined from the attempt tap; null when not observed. */
	created: number | null;
	/** HTTP status of the terminal attempt; null when no attempt was observed. */
	status: number | null;
	/** Attempts the logical request made (retries included); null when unobserved. */
	attempt_n: number | null;
	/** Request parameters of that logical request; null when unobserved. */
	request: DebugRequestParams | null;
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	reasoning: number;
	total: number;
	model_ms: number;
}

export interface DebugCounts {
	sessions: number;
	turns: number;
	models: string[];
	errors: {
		total: number;
		byClass: Record<DebugErrorClass, number>;
	};
	anomalies: {
		duplicateIdCreated: number;
		reasoningOnlyStream: number;
		contextOverflow: number;
	};
}

/** Request parameters carried by `turns.jsonl` (issue #49 S13). */
export interface DebugRequestParams {
	reasoning_effort: string | null;
	max_tokens: number | null;
	max_tokens_field: "max_tokens" | "max_completion_tokens" | null;
	stream: boolean | null;
}

/** One row per turn that had an error — written to errors.jsonl. */
export interface DebugErrorRecord {
	/** ISO 8601 timestamp of the turn. */
	timestamp: string;
	/** MD5[16] of the session file. */
	session_id: string;
	/** MD5[16] of the worktree cwd. */
	worktree_label: string;
	/** Model that returned the error. */
	model: string;
	/** The classified error (one of the fixed classes). */
	error: DebugErrorClass;
	/** The stop reason (usually "error"). */
	stop_reason: string;
	/** HTTP status of the terminal attempt, when the tap observed one. */
	status: number | null;
	/** `cf-ray` of the terminal attempt, when observed. */
	cf_ray: string | null;
	/** Attempts of that logical request, when correlated. */
	attempt_n: number | null;
	/** The gateway error body, truncated to 200 chars; null when absent. */
	message_truncated: string | null;
	/** MD5[16] of the full gateway message; null when absent. */
	message_hash: string | null;
	/** `error.type` from an OpenAI-style gateway body. */
	error_type: string | null;
	/** `error.code` from an OpenAI-style gateway body. */
	error_code: string | null;
	/** `error.param` from an OpenAI-style gateway body. */
	error_param: string | null;
	/** Response id if present. */
	response_id: string | null;
	/** Input tokens for context. */
	input: number;
	/** Output tokens (usually 0 for errors). */
	output: number;
}

export interface DebugReport {
	window: DebugWindow;
	topic: string | null;
	generatedAt: string;
	rows: DebugUsageRow[];
	turns: DebugTurn[];
	errors: DebugErrorRecord[];
	anomalies: CacheAnomalyRecord[];
	/** Window-filtered attempt/response rows embedded as `http_attempts.jsonl`. */
	httpAttempts: HttpAttemptEntry[];
	counts: DebugCounts;
	metadata: Record<string, unknown>;
	usageWindow?: unknown;
}

export type FetchUsageWindow = (window: DebugWindow, apiKey: string) => Promise<unknown>;

export interface BuildDebugReportOptions {
	agentDir?: string;
	now?: Date;
	/** Day count for --window (1-90). Ignored when `interval` is set. */
	windowDays?: number;
	/** Flexible time interval from --interval (replaces windowDays when set). */
	interval?: string;
	topic?: string;
	/** Only consulted when `includeUsage` is true. */
	apiKey?: string;
	fetchUsage?: FetchUsageWindow;
	includeUsage?: boolean;
	anomalyFile?: string;
	/** Per-response ray sidecar; defaults to the agent-dir file (issue #35 S11). */
	raysFile?: string;
	/** HTTP attempt sidecar; defaults to the agent-dir file (issue #49). */
	attemptsFile?: string;
	sessionsDir?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function md5Short(value: string): string {
	return createHash("md5").update(value).digest("hex").slice(0, 16);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isoDateOf(value: unknown): string | null {
	if (typeof value === "string") {
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
	}
	if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString().slice(0, 10);
	return null;
}

function formatInt(value: number): string {
	return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

function packageVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
		return typeof pkg.version === "string" ? pkg.version : "unknown";
	} catch {
		return "unknown";
	}
}

function listSessionFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) stack.push(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
		}
	}
	return files.sort();
}

/** List session files whose date falls within the given window. */
function listSessionFilesFiltered(root: string, window: DebugWindow): string[] {
	const allFiles = listSessionFiles(root);
	return allFiles.filter((file) => {
		const fileDate = sessionFileDate(file);
		return fileDate >= window.start.slice(0, 10) && fileDate <= window.end.slice(0, 10);
	});
}

/** Date of a session file: the ISO-timestamp filename prefix, else its mtime. */
function sessionFileDate(file: string): string {
	const match = /^(\d{4}-\d{2}-\d{2})T/.exec(basename(file));
	if (match) return match[1]!;
	try {
		return statSync(file).mtime.toISOString().slice(0, 10);
	} catch {
		return "1970-01-01";
	}
}

interface SessionHeader {
	cwd?: string;
}

interface RawAssistantEntry {
	timestamp?: unknown;
	message?: Record<string, unknown>;
}

/**
 * Read one session file: its cwd and the assistant turns. Only the fields the
 * report needs are extracted; `message.content` is never touched.
 */
function readSession(file: string): { cwd: string; turns: Array<{ raw: RawAssistantEntry; message: Record<string, unknown> }> } {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return { cwd: "", turns: [] };
	}
	let header: SessionHeader = {};
	const turns: Array<{ raw: RawAssistantEntry; message: Record<string, unknown> }> = [];
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (entry.type === "session") {
			header = entry as SessionHeader;
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (typeof message !== "object" || message === null) continue;
		const record = message as Record<string, unknown>;
		if (record.role !== "assistant" || record.provider !== "nan") continue;
		turns.push({ raw: entry as RawAssistantEntry, message: record });
	}
	return { cwd: typeof header.cwd === "string" ? header.cwd : "", turns };
}

function readAnomalies(file: string): CacheAnomalyRecord[] {
	if (!existsSync(file)) return [];
	const records: CacheAnomalyRecord[] = [];
	const text = readFileSync(file, "utf8");
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const parsed = JSON.parse(line) as CacheAnomalyRecord;
			if (parsed && typeof parsed === "object" && typeof parsed.detected_at === "string") records.push(parsed);
		} catch {
			// A corrupted line must not break the collector.
		}
	}
	return records;
}

function inWindow(date: string, window: DebugWindow): boolean {
	// Day-granular on both sides: interval bounds are full ISO strings while
	// session/anomaly dates are YYYY-MM-DD — comparing them raw silently
	// dropped the whole start date (EV-2026-11-18 B4).
	return date >= window.start.slice(0, 10) && date <= window.end.slice(0, 10);
}

function readAttempts(file: string): HttpAttemptEntry[] {
	try {
		return readHttpAttempts(file);
	} catch {
		return [];
	}
}

/**
 * Parse an OpenAI-style gateway error body out of a transcript `errorMessage`.
 * pi-ai may prefix the JSON with its own status text, so the first `{` to the
 * last `}` is tried. Returns null when the text is not a gateway error body —
 * local exception text is never reinterpreted as one.
 */
export function parseGatewayError(message: string | undefined): {
	type: string | null;
	code: string | null;
	param: string | null;
	message: string | null;
} | null {
	if (typeof message !== "string" || message.length === 0) return null;
	const start = message.indexOf("{");
	const end = message.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	try {
		const parsed = JSON.parse(message.slice(start, end + 1)) as unknown;
		if (!isObject(parsed) || !isObject(parsed.error)) return null;
		const error = parsed.error;
		return {
			type: typeof error.type === "string" ? error.type : null,
			code: typeof error.code === "string" ? error.code : null,
			param: typeof error.param === "string" ? error.param : null,
			message: typeof error.message === "string" ? error.message : null,
		};
	} catch {
		return null;
	}
}

/**
 * Replace the user's home directory with `~` so a surviving free-text fragment
 * cannot leak the account name or a project path (issue #49 S26).
 */
export function scrubHome(text: string, home: string = osHomedir()): string {
	if (home.length === 0) return text;
	// Require a path boundary so `/home/agent2` is never rewritten as `~2`.
	const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return text.replace(new RegExp(`${escaped}(?=/|$)`, "g"), "~");
}

/**
 * Correlate an errored turn with the terminal attempt of its logical request.
 * pi's transcript records no response id for a failed request, so the join is
 * model + the turn's own span: an attempt that ended while the turn was
 * running, extended by pi-ai's 60 s max server-requested retry delay. No match
 * means null, never a guess.
 */
export function findTerminalAttempt(
	attempts: readonly HttpAttemptRecord[],
	model: string,
	turnEndMs: number,
	durationMs: number,
): HttpAttemptRecord | null {
	const lower = turnEndMs - Math.max(0, durationMs) - 65_000;
	const upper = turnEndMs + 2_000;
	let best: HttpAttemptRecord | null = null;
	for (const attempt of attempts) {
		if (attempt.model !== model) continue;
		const ended = Date.parse(attempt.ended_at);
		if (!Number.isFinite(ended) || ended < lower || ended > upper) continue;
		if (!best) {
			best = attempt;
			continue;
		}
		const bestEnded = Date.parse(best.ended_at);
		if (ended > bestEnded || (ended === bestEnded && attempt.attempt_n > best.attempt_n)) best = attempt;
	}
	return best;
}

interface AttemptSummary {
	total: number;
	by_status: Record<string, number>;
	by_model: Array<{ model: string; attempts: number; rate_limited: number; rate_limited_pct: number }>;
	by_model_hour: Array<{
		model: string;
		hour: string;
		attempts: number;
		rate_limited: number;
		rate_limited_pct: number;
	}>;
	longest_429_streak: { model: string; length: number; started_at: string; ended_at: string } | null;
}

function pct(part: number, total: number): number {
	return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

/** CSV-style aggregates over the window's attempts (issue #49 S14). */
export function summarizeAttempts(attempts: readonly HttpAttemptRecord[]): AttemptSummary {
	const ordered = [...attempts].sort((a, b) => a.started_at.localeCompare(b.started_at));
	const byStatus: Record<string, number> = {};
	const perModel = new Map<string, { attempts: number; rateLimited: number }>();
	const perModelHour = new Map<string, { model: string; hour: string; attempts: number; rateLimited: number }>();

	for (const attempt of ordered) {
		const statusKey = attempt.status === null ? "null" : String(attempt.status);
		byStatus[statusKey] = (byStatus[statusKey] ?? 0) + 1;
		const model = perModel.get(attempt.model) ?? { attempts: 0, rateLimited: 0 };
		model.attempts += 1;
		if (attempt.status === 429) model.rateLimited += 1;
		perModel.set(attempt.model, model);

		const hour = attempt.started_at.slice(0, 13);
		const key = `${attempt.model}\u0000${hour}`;
		const bucket = perModelHour.get(key) ?? { model: attempt.model, hour, attempts: 0, rateLimited: 0 };
		bucket.attempts += 1;
		if (attempt.status === 429) bucket.rateLimited += 1;
		perModelHour.set(key, bucket);
	}

	// Longest run of consecutive 429s per model, in start order.
	let streak: AttemptSummary["longest_429_streak"] = null;
	let current: { model: string; length: number; started_at: string; ended_at: string } | null = null;
	for (const attempt of ordered) {
		if (attempt.status === 429) {
			if (current && current.model === attempt.model) {
				current.length += 1;
				current.ended_at = attempt.ended_at;
			} else {
				current = { model: attempt.model, length: 1, started_at: attempt.started_at, ended_at: attempt.ended_at };
			}
			if (!streak || current.length > streak.length) streak = { ...current };
		} else {
			current = null;
		}
	}

	return {
		total: ordered.length,
		by_status: byStatus,
		by_model: [...perModel.entries()]
			.map(([model, counts]) => ({
				model,
				attempts: counts.attempts,
				rate_limited: counts.rateLimited,
				rate_limited_pct: pct(counts.rateLimited, counts.attempts),
			}))
			.sort((a, b) => a.model.localeCompare(b.model)),
		by_model_hour: [...perModelHour.values()]
			.map((bucket) => ({
				model: bucket.model,
				hour: bucket.hour,
				attempts: bucket.attempts,
				rate_limited: bucket.rateLimited,
				rate_limited_pct: pct(bucket.rateLimited, bucket.attempts),
			}))
			.sort((a, b) => (a.hour === b.hour ? a.model.localeCompare(b.model) : a.hour.localeCompare(b.hour))),
		longest_429_streak: streak,
	};
}

// ── Report building ───────────────────────────────────────────────────────

export async function buildDebugReport(options: BuildDebugReportOptions = {}): Promise<DebugReport> {
	const agentDir = options.agentDir ?? getAgentDir();
	const now = options.now ?? new Date();
	// Use flexible interval if provided, else fall back to day-count window
	let window: DebugWindow;
	if (options.interval) {
		const result = parseFlexibleTime(options.interval, now);
		if (typeof result === "object" && result !== null && "ok" in result && result.ok === false) {
			throw new Error((result as { error: string }).error);
		}
		window = result as DebugWindow;
	} else {
		window = rollingWindow(options.windowDays ?? DEFAULT_DEBUG_WINDOW_DAYS, now);
	}
	const sessionsDir = options.sessionsDir ?? join(agentDir, "sessions");
	const anomalyFile = options.anomalyFile ?? (options.agentDir ? join(agentDir, CACHE_ANOMALY_FILE) : defaultCacheAnomalyPath());
	// Per-response cf-ray sidecar (issue #35 S11): joined onto turns below.
	const rayByResponseId = readResponseRays(options.raysFile ?? join(agentDir, RESPONSE_RAYS_FILE));

	const anomalies = readAnomalies(anomalyFile).filter((record) => inWindow(record.detected_at.slice(0, 10), window));

	// HTTP attempt tap (issue #49): one row per attempt plus one per response.
	const attemptEntries = readAttempts(
		options.attemptsFile ?? (options.agentDir ? join(agentDir, HTTP_ATTEMPTS_FILE) : defaultHttpAttemptPath()),
	).filter((entry) => inWindow((entry.kind === "attempt" ? entry.started_at : entry.ended_at).slice(0, 10), window));
	const attemptsOnly = attemptEntries.filter((entry): entry is HttpAttemptRecord => entry.kind === "attempt");
	const responseByResponseId = new Map<string, HttpResponseRecord>();
	for (const entry of attemptEntries) {
		if (entry.kind === "response" && entry.response_id) responseByResponseId.set(entry.response_id, entry);
	}

	const turns: DebugTurn[] = [];
	const errors: DebugErrorRecord[] = [];
	const usages = new Map<string, DebugUsageRow>();
	const worktreeLabels = new Set<string>();
	const sessionIds = new Set<string>();
	const models = new Set<string>();
	const errorCounts: Record<DebugErrorClass, number> = {
		overflow: 0,
		rate_limited: 0,
		invalid_request: 0,
		transport: 0,
		other: 0,
	};
	let reasoningOnlyCount = 0;
	let contextOverflowCount = 0;

	for (const file of listSessionFiles(sessionsDir)) {
		const date = sessionFileDate(file);
		if (!inWindow(date, window)) continue;
		const { cwd, turns: rawTurns } = readSession(file);
		if (rawTurns.length === 0) continue;

		const sessionId = md5Short(file);
		const worktreeLabel = cwd ? md5Short(cwd) : "0000000000000000";
		sessionIds.add(sessionId);
		worktreeLabels.add(worktreeLabel);

		rawTurns.forEach(({ raw, message }, index) => {
			const model = typeof message.model === "string" ? message.model : "unknown";
			const usage = (typeof message.usage === "object" && message.usage !== null ? message.usage : {}) as Record<string, unknown>;
			const stopReason = typeof message.stopReason === "string" ? message.stopReason : "unknown";
			const responseId = typeof message.responseId === "string" ? message.responseId : null;
			const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
			const errorClass = classifyErrorMessage(errorMessage);
			if (isReasoningOnlyStreamError(errorMessage)) reasoningOnlyCount += 1;
			if (errorClass === "overflow") contextOverflowCount += 1;
			const timestamp =
				typeof raw.timestamp === "string"
					? raw.timestamp
					: new Date(numberOrZero(message.timestamp)).toISOString();
			const dateOfTurn = isoDateOf(timestamp) ?? date;
			const durationMs = numberOrZero(message.durationMs);

			// A successful logical request joins by response id: the tap's
			// `response` row carries the gateway `created`, terminal status,
			// attempt count and request parameters the transcript never had.
			const responseRow = responseId !== null ? (responseByResponseId.get(responseId) ?? null) : null;
			const terminalForResponse =
				responseRow !== null
					? (attemptsOnly.find(
							(attempt) =>
								attempt.request_id === responseRow.request_id && attempt.attempt_n === responseRow.attempts,
						) ?? null)
					: null;

			models.add(model);
			turns.push({
				date: dateOfTurn,
				session_id: sessionId,
				worktree_label: worktreeLabel,
				turn: index + 1,
				timestamp,
				model,
				stop_reason: stopReason,
				error: errorClass,
				response_id: responseId,
				cf_ray:
					responseId !== null
						? (rayByResponseId.get(responseId) ?? terminalForResponse?.headers["cf-ray"] ?? null)
						: null,
				created: responseRow?.created ?? null,
				status: responseRow?.status ?? null,
				attempt_n: responseRow?.attempts ?? null,
				request: responseRow?.request ?? null,
				input: numberOrZero(usage.input),
				output: numberOrZero(usage.output),
				cache_read: numberOrZero(usage.cacheRead),
				cache_write: numberOrZero(usage.cacheWrite),
				reasoning: numberOrZero(usage.reasoning),
				total: numberOrZero(usage.totalTokens),
				model_ms: durationMs,
			});

			// Track errors separately for errors.jsonl. A failed logical request
			// has no response id, so the terminal attempt is correlated by model
			// and the turn's own span; no match leaves the cells null.
			if (errorClass) {
				const terminal = findTerminalAttempt(attemptsOnly, model, Date.parse(timestamp), durationMs);
				const gatewayError = parseGatewayError(errorMessage);
				const serverMessage = gatewayError?.message ? scrubHome(gatewayError.message) : null;
				errors.push({
					timestamp,
					session_id: sessionId,
					worktree_label: worktreeLabel,
					model,
					error: errorClass,
					stop_reason: stopReason,
					status: terminal?.status ?? null,
					cf_ray: terminal?.headers["cf-ray"] ?? null,
					attempt_n: terminal?.attempt_n ?? null,
					message_truncated: serverMessage !== null ? serverMessage.slice(0, 200) : null,
					message_hash: serverMessage !== null && errorMessage ? md5Short(errorMessage) : null,
					error_type: gatewayError?.type ?? null,
					error_code: gatewayError?.code ?? null,
					error_param: gatewayError?.param ?? null,
					response_id: responseId,
					input: numberOrZero(usage.input),
					output: numberOrZero(usage.output),
				});
				errorCounts[errorClass] += 1;
			}

			const key = `${dateOfTurn}\u0000${sessionId}\u0000${model}`;
			let row = usages.get(key);
			if (!row) {
				row = {
					date: dateOfTurn,
					session_id: sessionId,
					worktree_label: worktreeLabel,
					model,
					turns: 0,
					total_tokens: 0,
					input_tokens: 0,
					output_tokens: 0,
					cache_read_tokens: 0,
					cache_write_tokens: 0,
					reasoning_tokens: 0,
					avg_tokens_per_turn: 0,
					cache_hit_rate_pct: 0,
					stop_reason_counts: {},
					anomalies: [],
				};
				usages.set(key, row);
			}
			row.turns += 1;
			row.total_tokens += numberOrZero(usage.totalTokens);
			row.input_tokens += numberOrZero(usage.input);
			row.output_tokens += numberOrZero(usage.output);
			row.cache_read_tokens += numberOrZero(usage.cacheRead);
			row.cache_write_tokens += numberOrZero(usage.cacheWrite);
			row.reasoning_tokens += numberOrZero(usage.reasoning);
			row.stop_reason_counts[stopReason] = (row.stop_reason_counts[stopReason] ?? 0) + 1;
		});
	}

	const rows = [...usages.values()].sort((a, b) =>
		a.date === b.date
			? a.session_id === b.session_id
				? a.model.localeCompare(b.model)
				: a.session_id.localeCompare(b.session_id)
			: a.date.localeCompare(b.date),
	);
	for (const row of rows) {
		row.avg_tokens_per_turn = row.turns > 0 ? round1(row.total_tokens / row.turns) : 0;
		const denominator = row.input_tokens + row.cache_read_tokens;
		row.cache_hit_rate_pct = denominator > 0 ? round1((row.cache_read_tokens / denominator) * 100) : 0;
		row.anomalies = anomalies
			.filter((record) => record.model === row.model && record.detected_at.slice(0, 10) === row.date)
			.map((record) => ({ kind: record.kind, detected_at: record.detected_at }));
	}

	const generatedAt = now.toISOString();
	const versions = { provider: packageVersion(), pi_ai: PI_AI_VERSION, pi: PI_VERSION };
	const metadata: Record<string, unknown> = {
		generated_at: generatedAt,
		// Free text: hashed so a descriptive topic cannot name a client or project
		// in the shared artifact (issue #49 S25).
		topic_hash: options.topic ? md5Short(options.topic) : null,
		window,
		versions,
		catalog: {
			source: GENERATED_CATALOG_META.source,
			models_dev_provider: GENERATED_CATALOG_META.modelsDevProvider,
			fetched_at: GENERATED_CATALOG_META.fetchedAt,
			model_count: GENERATED_CATALOG_META.modelCount,
		},
		redaction: {
			session_ids_hashed: sessionIds.size,
			worktree_labels_hashed: worktreeLabels.size,
			prompt_response_bytes: 0,
			credentials: 0,
		},
		error_summary: {
			total: errors.length,
			byClass: { ...errorCounts },
		},
		attempt_summary: summarizeAttempts(attemptsOnly),
	};

	const report: DebugReport = {
		window,
		topic: options.topic ?? null,
		generatedAt,
		rows,
		turns: turns.sort((a, b) =>
			a.timestamp === b.timestamp ? a.session_id.localeCompare(b.session_id) : a.timestamp.localeCompare(b.timestamp),
		),
		errors: errors.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
		anomalies,
		httpAttempts: attemptEntries,
		counts: {
			sessions: sessionIds.size,
			turns: turns.length,
			models: [...models].sort(),
			errors: {
				total: errors.length,
				byClass: { ...errorCounts },
			},
			anomalies: {
				duplicateIdCreated: anomalies.length,
				reasoningOnlyStream: reasoningOnlyCount,
				contextOverflow: contextOverflowCount,
			},
		},
		metadata,
	};

	if (options.includeUsage && options.fetchUsage) {
		if (!options.apiKey) {
			report.usageWindow = { error: "no API key resolved — usage window skipped" };
		} else {
			try {
				report.usageWindow = await options.fetchUsage(window, options.apiKey);
			} catch (error) {
				report.usageWindow = { error: error instanceof Error ? error.message : String(error) };
			}
		}
		if (report.usageWindow !== undefined) {
			(metadata as Record<string, unknown>).usage_window_included = true;
		}
	}

	return report;
}

// ── Rendering ─────────────────────────────────────────────────────────────

export interface RenderedReport {
	files: Record<string, string>;
	preview: string;
}

/** Opt-in content flags; the default artifact carries no prompt or tool content. */
export interface DebugRenderOptions {
	/** Embed the window-filtered raw transcripts under `sessions/`. */
	includePrompts?: boolean;
	/** Keep tool calls and their results; implies `includePrompts`. */
	includeTools?: boolean;
}

function renderReadme(report: DebugReport, versions: Record<string, string>): string {
	const topic = report.topic ? "(hashed for sharing)" : "(none)";
	return [
		"# nan-debug report",
		"",
		`Generated by \`/nan-debug\` (issue #35; HTTP attempt evidence from issue #49) on ${report.generatedAt}. Local-only: nothing was uploaded.`,
		`Artifact name: ${NAN_DEBUG_REPORT_PREFIX}-<emission timestamp, UTC> — the name identifies when the report was emitted, not the window it reports.`,
		"",
		`Window: ${report.window.start} → ${report.window.end} (${report.window.days}d)`,
		`Topic: ${topic}`,
		"",
		"## What is collected",
		"",
		"- `anonymized_usage.jsonl` — one aggregated row per date/session/model: token counters, turn count, stop-reason counts, cache-hit rate, anomaly signatures.",
		"- `turns.jsonl` — one row per assistant turn: model, usage counters, stop reason, classified error, response id, `cf_ray` (Cloudflare trace id, null when uncaptured), gateway `created`, terminal `status`, `attempt_n`, and the request parameters (`reasoning_effort`, `max_tokens`, the field actually sent, `stream`).",
		"- `errors.jsonl` — one row per errored turn: class, `status`, `cf_ray`, `attempt_n`, the parsed gateway body (`error_type`, `error_code`, `error_param`), its message (200 chars max) and the MD5 hash of the full message. Transport errors carry no message, hash or path. A failed request has no response id, so those three attempt cells are correlated by model and the turn's own span; with concurrent requests to the same model treat them as best-effort — `http_attempts.jsonl` is the authoritative per-attempt record.",
		"- `http_attempts.jsonl` — one `kind: \"attempt\"` row per HTTP attempt: status, whitelisted response headers, `started_at`/`ended_at`/`latency_ms`, `attempt_n`, `payload_bytes`, request parameters, process-scoped inflight/60 s counters and the transport error class. One `kind: \"response\"` row per completed request carries the gateway `response_id`/`created`. Retries pi-ai hides from the transcript are rows here.",
		"- `anomalies.jsonl` — duplicate `id`/`created` pairs captured by the provider, with both `cf-ray` values (see issue #35).",
		"- `metadata.json` — versions, catalog provenance, window, `topic_hash`, redaction counters and `attempt_summary` (status counts, 429 ratio per model and per model-hour, longest 429 streak).",
		"",
		"## What is never collected",
		"",
		"- Prompt, response or tool content unless you opt in: `--include-prompts` embeds the window-filtered raw transcripts under `sessions/` with tool calls and results stripped; `--include-tools` keeps them; `--all` equals both and also includes `usage_window.json`.",
		"- Credentials, auth headers, or any response header outside the whitelist (`cf-ray`, `x-request-id`, `retry-after`, `retry-after-ms`, `x-should-retry`, `rate-limit-*`).",
		"- Request or response bodies: the tap stores `payload_bytes`, never the payload.",
		"- Local absolute paths and pi-side exception text. Session ids and worktree labels are MD5-truncated to 16 chars (no per-report salt, so the same session links across reports); a surviving server message has the home directory scrubbed to `~`.",
		"- Raw error text: `errors.jsonl` keeps only the fields of a gateway error body, never a local exception message.",
		"",
		"## `inflight_*` is process-scoped",
		"",
		"A tap inside one pi process sees only that process's attempts. `inflight_process_at_start` and `starts_last_60s_process*` are therefore **not** the concurrency or RPM of your API key when several clients share it; the reference CSV's key-wide counts require merging the logs of every client.",
		"",
		"## Not public",
		"",
		"This report is for NaN support, not for publication. `cf-ray`, `response_id` and millisecond timestamps are deliberately not anonymized — support correlates their logs with them. `payload_sha256` in `anomalies.jsonl` fingerprints a prompt. The default artifact carries no prompt or response content; `sessions/` (with `--include-prompts` / `--include-tools` / `--all`) and `usage_window.json` (billing period and credits: account/tier identity) are private material.",
		"",
		"## Versions",
		"",
		`- package: ${versions.provider}`,
		`- pi-ai: ${versions.pi_ai}`,
		`- pi: ${versions.pi}`,
		"",
	].join("\n");
}

/**
 * Strip content the caller did not opt into from one raw transcript line:
 * `toolResult` entries are dropped whole and `toolCall` blocks are removed from
 * assistant messages. `cwd` is hashed in every line that carries it.
 */
function scrubSessionTranscript(text: string, includeTools: boolean): string {
	const kept: string[] = [];
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			kept.push(line);
			continue;
		}
		if (typeof entry.cwd === "string") entry.cwd = md5Short(entry.cwd);
		if (!includeTools && isObject(entry.message)) {
			const message = entry.message;
			if (message.role === "toolResult") continue;
			if (Array.isArray(message.content)) {
				message.content = message.content.filter(
					(block) => !(isObject(block) && block.type === "toolCall"),
				);
			}
		}
		kept.push(JSON.stringify(entry));
	}
	return kept.join("\n");
}

export function renderDebugReport(
	report: DebugReport,
	sessionsDir?: string,
	options: DebugRenderOptions = {},
): RenderedReport {
	const versions = (report.metadata as { versions: Record<string, string> }).versions;
	const includePrompts = options.includePrompts === true || options.includeTools === true;
	const includeTools = options.includeTools === true;

	const metadata = { ...report.metadata } as Record<string, unknown>;
	metadata.redaction = {
		...((isObject(metadata.redaction) ? metadata.redaction : {}) as Record<string, unknown>),
		transcripts_included: includePrompts,
		tool_calls_included: includeTools,
	};

	const files: Record<string, string> = {
		"README.md": renderReadme(report, versions),
		"anonymized_usage.jsonl": report.rows.map((row) => JSON.stringify(row)).join("\n") + (report.rows.length > 0 ? "\n" : ""),
		"turns.jsonl": report.turns.map((turn) => JSON.stringify(turn)).join("\n") + (report.turns.length > 0 ? "\n" : ""),
		"errors.jsonl": report.errors.map((err) => JSON.stringify(err)).join("\n") + (report.errors.length > 0 ? "\n" : ""),
		"http_attempts.jsonl": report.httpAttempts.map((entry) => JSON.stringify(entry)).join("\n") + (report.httpAttempts.length > 0 ? "\n" : ""),
		"anomalies.jsonl": report.anomalies.map((record) => JSON.stringify(record)).join("\n") + (report.anomalies.length > 0 ? "\n" : ""),
		"metadata.json": `${JSON.stringify(metadata, null, 2)}\n`,
	};
	if (report.usageWindow !== undefined) {
		files["usage_window.json"] = `${JSON.stringify(report.usageWindow, null, 2)}\n`;
	}

	// Transcripts are opt-in: the default artifact carries no prompt, response
	// or tool content at all (issue #49 S20/S21).
	if (sessionsDir && includePrompts) {
		try {
			const sessionFiles = listSessionFilesFiltered(sessionsDir, report.window);
			for (const file of sessionFiles) {
				const content = readFileSync(file, "utf8");
				const relPath = file.startsWith(sessionsDir) ? file.slice(sessionsDir.length + 1) : basename(file);
				files[`sessions/${relPath}`] = scrubSessionTranscript(content, includeTools);
			}
		} catch {
			// If sessionsDir doesn't exist or can't be read, skip session files.
			// This can happen in tests or when the directory is moved.
		}
	}

	const perModel = report.counts.models
		.map((model) => {
			const rows = report.rows.filter((row) => row.model === model);
			const turns = rows.reduce((sum, row) => sum + row.turns, 0);
			const tokens = rows.reduce((sum, row) => sum + row.total_tokens, 0);
			return `${model} ${formatInt(turns > 0 ? tokens / turns : 0)}`;
		})
		.join(" · ");

	const errorCounts = report.counts.errors;
	const errorParts = Object.entries(errorCounts.byClass)
		.filter(([, count]) => count > 0)
		.map(([kind, count]) => `${kind}: ${count}`)
		.join(" · ");

	const attemptSummary = (report.metadata as { attempt_summary?: { total: number; by_status: Record<string, number> } })
		.attempt_summary;
	const attempt429 = attemptSummary?.by_status["429"] ?? 0;
	const attempt5xx = Object.entries(attemptSummary?.by_status ?? {})
		.filter(([status]) => Number(status) >= 500)
		.reduce((sum, [, count]) => sum + count, 0);
	const attemptsLine =
		attemptSummary && attemptSummary.total > 0
			? `http attempts: ${attemptSummary.total} (429: ${attempt429} · 5xx: ${attempt5xx})`
			: "http attempts: 0";

	const preview = [
		`nan-debug report — ${report.window.start} → ${report.window.end} (window: ${report.window.days}d)`,
		`sessions: ${report.counts.sessions} · turns: ${report.counts.turns} · models: ${report.counts.models.length}`,
		attemptsLine,
		`errors: ${errorCounts.total} total${errorParts.length > 0 ? ` (${errorParts})` : ""}`,
		`per-model avg tokens/turn: ${perModel.length > 0 ? perModel : "(none)"}`,
		`anomalies: ${report.counts.anomalies.duplicateIdCreated} duplicate id/created pairs · ${report.counts.anomalies.reasoningOnlyStream} reasoning-only stream · ${report.counts.anomalies.contextOverflow} context overflow`,
		`redaction: ${report.counts.sessions} session ids hashed · ${(report.metadata as { redaction: { worktree_labels_hashed: number } }).redaction.worktree_labels_hashed} paths hashed · 0 prompt/response bytes collected`,
		"sharing: shared by default = usage, turns, errors, http attempts, anomalies, metadata — no prompts, no tool calls",
		"→ --include-prompts embeds raw transcripts · --include-tools adds tool calls/results · --all adds both plus usage_window.json",
		`→ nothing shared yet. Run with --emit to write ${NAN_DEBUG_REPORT_PREFIX}-<timestamp>.zip`,
	].join("\n");

	return { files, preview };
}

export function writeDebugReport(files: Record<string, string>, outDir: string): void {
	mkdirSync(outDir, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		const filePath = join(outDir, name);
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, content);
	}
}

export interface WriteDebugZipOptions {
	/** `--all` only: `usage_window.json` identifies the account/tier and stays local otherwise. */
	includeUsageWindow?: boolean;
}

export function writeDebugZip(
	files: Record<string, string>,
	zipPath: string,
	options: WriteDebugZipOptions = {},
): void {
	mkdirSync(dirname(zipPath), { recursive: true });
	const entries = Object.entries(files)
		.filter(([name]) => options.includeUsageWindow === true || name !== "usage_window.json")
		.map(([name, data]) => ({ name, data }));
	writeFileSync(zipPath, createZip(entries));
}

// ── Live usage (only with --window) ───────────────────────────────────────

/** Default `--window` usage source: the same `/nan-usage` endpoint, same key. */
export async function fetchDebugUsageWindow(window: DebugWindow, apiKey: string): Promise<unknown> {
	const result = await fetchUsageReport({ apiKey, window });
	if (!result.ok) return { error: result.error };
	return result.report;
}


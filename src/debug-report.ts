/**
 * `/nan-debug` — deterministic, redacted NaN evidence collector (issue #35).
 *
 * NaN could not reproduce the prompt-cache anomaly and asked for "modelo y
 * cf-ray de un par de llamadas". This module reads pi's session JSONL (usage,
 * stop reasons, response ids) plus the local cache-anomaly capture
 * (`nan-cache-anomalies.jsonl`, which holds the `cf-ray` pair) and renders a
 * report that can be shared verbatim.
 *
 * Contract (issue #35):
 *   - no LLM, no network unless `--window` explicitly asks for `/v1/usage`;
 *   - never collect prompt/response content, credentials or raw paths;
 *   - session and worktree identifiers are MD5-truncated to 12 chars;
 *   - error text is reduced to a fixed class;
 *   - the same inputs produce byte-identical zip bytes.
 *
 * The report layout matches the 2026-11-10 anonymized dataset: one aggregated
 * `anonymized_usage.jsonl` row per (date, session, model), plus `turns.jsonl`
 * with the per-turn detail the issue asks for (`response_id`, `created` = null
 * because pi does not persist it, usage, stop reason, error class).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { PI_AI_VERSION } from "@earendil-works/pi-ai";
import { VERSION as PI_VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import { GENERATED_CATALOG_META } from "../scripts/models.generated.ts";
import { CACHE_ANOMALY_FILE, defaultCacheAnomalyPath, type CacheAnomalyRecord } from "./cache-anomaly.ts";
import { fetchUsageReport, rollingWindow, type UsageWindow } from "./usage.ts";
import { createZip } from "./zip.ts";

export const DEFAULT_DEBUG_WINDOW_DAYS = 7;
export const MAX_DEBUG_WINDOW_DAYS = 90;
export const NAN_DEBUG_REPORT_DIR = "nan-debug-report";
export const NAN_DEBUG_ZIP = "nan-debug-report.zip";

export const DEBUG_USAGE_LINE =
	"Usage: /nan-debug [topic] [--window N] [--out file] [--emit] — collects a redacted NaN evidence report locally; --emit writes the shareable zip.";

export type DebugWindow = UsageWindow;

// ── Argument parsing ──────────────────────────────────────────────────────

export interface DebugArgs {
	topic?: string;
	windowDays: number;
	/** True when `--window` was given; only then is `/v1/usage` consulted. */
	windowProvided: boolean;
	out?: string;
	emit: boolean;
}

export type ParseDebugArgsResult = { ok: true; args: DebugArgs } | { ok: false; error: string };

const TOPIC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** Parse `/nan-debug` arguments. Deterministic; no filesystem or clock access. */
export function parseDebugArgs(input: string): ParseDebugArgsResult {
	const tokens = input.trim().split(/\s+/).filter(Boolean);
	const args: DebugArgs = { windowDays: DEFAULT_DEBUG_WINDOW_DAYS, windowProvided: false, emit: false };

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token === "--emit") {
			args.emit = true;
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

	return { ok: true, args };
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
 * Map a raw `errorMessage` to a fixed class. The raw text is never emitted —
 * this is the only thing that reaches the report.
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
	created: number | null;
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
	anomalies: {
		duplicateIdCreated: number;
		reasoningOnlyStream: number;
		contextOverflow: number;
	};
}

export interface DebugReport {
	window: DebugWindow;
	topic: string | null;
	generatedAt: string;
	rows: DebugUsageRow[];
	turns: DebugTurn[];
	anomalies: CacheAnomalyRecord[];
	counts: DebugCounts;
	metadata: Record<string, unknown>;
	usageWindow?: unknown;
}

export type FetchUsageWindow = (window: DebugWindow, apiKey: string) => Promise<unknown>;

export interface BuildDebugReportOptions {
	agentDir?: string;
	now?: Date;
	windowDays?: number;
	topic?: string;
	/** Only consulted when `includeUsage` is true. */
	apiKey?: string;
	fetchUsage?: FetchUsageWindow;
	includeUsage?: boolean;
	anomalyFile?: string;
	sessionsDir?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function md5Short(value: string): string {
	return createHash("md5").update(value).digest("hex").slice(0, 12);
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
	return date >= window.start && date <= window.end;
}

// ── Report building ───────────────────────────────────────────────────────

export async function buildDebugReport(options: BuildDebugReportOptions = {}): Promise<DebugReport> {
	const agentDir = options.agentDir ?? getAgentDir();
	const now = options.now ?? new Date();
	const window = rollingWindow(options.windowDays ?? DEFAULT_DEBUG_WINDOW_DAYS, now);
	const sessionsDir = options.sessionsDir ?? join(agentDir, "sessions");
	const anomalyFile = options.anomalyFile ?? (options.agentDir ? join(agentDir, CACHE_ANOMALY_FILE) : defaultCacheAnomalyPath());

	const anomalies = readAnomalies(anomalyFile).filter((record) => inWindow(record.detected_at.slice(0, 10), window));

	const turns: DebugTurn[] = [];
	const usages = new Map<string, DebugUsageRow>();
	const worktreeLabels = new Set<string>();
	const sessionIds = new Set<string>();
	const models = new Set<string>();
	let reasoningOnlyCount = 0;
	let contextOverflowCount = 0;

	for (const file of listSessionFiles(sessionsDir)) {
		const date = sessionFileDate(file);
		if (!inWindow(date, window)) continue;
		const { cwd, turns: rawTurns } = readSession(file);
		if (rawTurns.length === 0) continue;

		const sessionId = md5Short(file);
		const worktreeLabel = cwd ? md5Short(cwd) : "000000000000";
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
				created: null,
				input: numberOrZero(usage.input),
				output: numberOrZero(usage.output),
				cache_read: numberOrZero(usage.cacheRead),
				cache_write: numberOrZero(usage.cacheWrite),
				reasoning: numberOrZero(usage.reasoning),
				total: numberOrZero(usage.totalTokens),
				model_ms: numberOrZero(message.durationMs),
			});

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
		topic: options.topic ?? null,
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
	};

	const report: DebugReport = {
		window,
		topic: options.topic ?? null,
		generatedAt,
		rows,
		turns: turns.sort((a, b) =>
			a.timestamp === b.timestamp ? a.session_id.localeCompare(b.session_id) : a.timestamp.localeCompare(b.timestamp),
		),
		anomalies,
		counts: {
			sessions: sessionIds.size,
			turns: turns.length,
			models: [...models].sort(),
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

function renderReadme(report: DebugReport, versions: Record<string, string>): string {
	return [
		"# nan-debug report",
		"",
		`Generated by \`/nan-debug\` (issue #35) on ${report.generatedAt}. Local-only: nothing was uploaded.`,
		"",
		`Window: ${report.window.start} → ${report.window.end} (${report.window.days}d)`,
		`Topic: ${report.topic ?? "(none)"}`,
		"",
		"## What is collected",
		"",
		"- `anonymized_usage.jsonl` — one aggregated row per date/session/model: token counters, turn count, stop-reason counts, cache-hit rate, anomaly signatures.",
		"- `turns.jsonl` — one row per assistant turn: model, usage counters, stop reason, classified error, response id, `created` (null when the transcript has none), duration.",
		"- `anomalies.jsonl` — duplicate `id`/`created` pairs captured by the provider, with both `cf-ray` values (see issue #35).",
		"- `metadata.json` — versions, catalog provenance, window, redaction counters.",
		"",
		"## What is never collected",
		"",
		"- Prompt or response content.",
		"- Raw file paths or worktree names (MD5 truncated to 12 chars).",
		"- Credentials or auth headers.",
		"",
		"## Versions",
		"",
		`- package: ${versions.provider}`,
		`- pi-ai: ${versions.pi_ai}`,
		`- pi: ${versions.pi}`,
		"",
	].join("\n");
}

export function renderDebugReport(report: DebugReport): RenderedReport {
	const versions = (report.metadata as { versions: Record<string, string> }).versions;
	const files: Record<string, string> = {
		"README.md": renderReadme(report, versions),
		"anonymized_usage.jsonl": report.rows.map((row) => JSON.stringify(row)).join("\n") + (report.rows.length > 0 ? "\n" : ""),
		"turns.jsonl": report.turns.map((turn) => JSON.stringify(turn)).join("\n") + (report.turns.length > 0 ? "\n" : ""),
		"anomalies.jsonl": report.anomalies.map((record) => JSON.stringify(record)).join("\n") + (report.anomalies.length > 0 ? "\n" : ""),
		"metadata.json": `${JSON.stringify(report.metadata, null, 2)}\n`,
	};
	if (report.usageWindow !== undefined) {
		files["usage_window.json"] = `${JSON.stringify(report.usageWindow, null, 2)}\n`;
	}

	const perModel = report.counts.models
		.map((model) => {
			const rows = report.rows.filter((row) => row.model === model);
			const turns = rows.reduce((sum, row) => sum + row.turns, 0);
			const tokens = rows.reduce((sum, row) => sum + row.total_tokens, 0);
			return `${model} ${formatInt(turns > 0 ? tokens / turns : 0)}`;
		})
		.join(" · ");

	const preview = [
		`nan-debug report — ${report.window.start} → ${report.window.end} (window: ${report.window.days}d)`,
		`sessions: ${report.counts.sessions} · turns: ${report.counts.turns} · models: ${report.counts.models.length}`,
		`per-model avg tokens/turn: ${perModel.length > 0 ? perModel : "(none)"}`,
		`anomalies: ${report.counts.anomalies.duplicateIdCreated} duplicate id/created pairs · ${report.counts.anomalies.reasoningOnlyStream} reasoning-only stream · ${report.counts.anomalies.contextOverflow} context overflow`,
		`redaction: ${report.counts.sessions} session ids hashed · ${(report.metadata as { redaction: { worktree_labels_hashed: number } }).redaction.worktree_labels_hashed} paths hashed · 0 prompt/response bytes collected`,
		"→ nothing shared yet. Run with --emit to write nan-debug-report.zip",
	].join("\n");

	return { files, preview };
}

export function writeDebugReport(files: Record<string, string>, outDir: string): void {
	mkdirSync(outDir, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(outDir, name), content);
	}
}

export function writeDebugZip(files: Record<string, string>, zipPath: string): void {
	mkdirSync(dirname(zipPath), { recursive: true });
	const entries = Object.entries(files).map(([name, data]) => ({ name, data }));
	writeFileSync(zipPath, createZip(entries));
}

// ── Live usage (only with --window) ───────────────────────────────────────

/** Default `--window` usage source: the same `/nan-usage` endpoint, same key. */
export async function fetchDebugUsageWindow(window: DebugWindow, apiKey: string): Promise<unknown> {
	const result = await fetchUsageReport({ apiKey, window });
	if (!result.ok) return { error: result.error };
	return result.report;
}


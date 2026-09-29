/**
 * `/nan-usage` — slash command: NaN token usage merged with the documented
 * quota limits.
 *
 * Data source: NaN's `GET /v1/usage` (OpenAPI tag "Usage",
 * https://nan.builders/docs/api#tag/usage), authenticated with the same
 * personal API key used for chat (`Authorization: Bearer`) — pi's stored
 * credential (`/login nan`) or `NAN_API_KEY`.
 *
 * This replaced the previous dashboard flow, which needed a NaN CLI session
 * cookie (`nan auth login` → `~/.config/nan/session.json`). `/usage` is
 * member-scoped and API-key authed, so no CLI login is involved anymore
 * (NaN docs, checked 2026-09-27).
 *
 * The endpoint reports consumption, never caps: quotas below come from
 * https://nan.builders/docs/models (checked 2026-09-29) and are merged with
 * the returned per-model totals. mimo-v2.5 has no row: NaN removed it from
 * the docs (checked 2026-09-29), so a cap for it would have no source —
 * historical consumption still appears under the undocumented-models section.
 * `/usage` returns daily rows (paginated) plus
 * `totals` covering the whole requested window — max 90 inclusive days, wider
 * windows are rejected with 400 — so the command reads `totals.by_model` and
 * asks for a single-row page. Rate limit: 30 requests/min, separate from the
 * model endpoints.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { NAN_API_KEY_ENV, resolveNanApiKey, tryResolveNanApiKeyViaRegistry } from "./mcp/api-key.ts";

// ── Known quota limits per model (from NaN docs) ──────────────────────────

export interface ModelQuota {
	/** Model ID as used in API calls. */
	model: string;
	/** Human-readable name. */
	label: string;
	/** Monthly token cap (0 = uncapped). */
	monthlyCap: number;
	/** Rolling 4h window cap in tokens (0 = none). */
	rollingWindowCap: number;
	/** Rolling window duration in hours. */
	rollingWindowHours: number;
	/** Whether this model is premium-tier (glm5.3). */
	premium: boolean;
}

export const MODEL_QUOTAS: readonly ModelQuota[] = [
	{ model: "deepseek-v4-flash", label: "DeepSeek V4 Flash", monthlyCap: 3_000_000_000, rollingWindowCap: 0, rollingWindowHours: 0, premium: false },
	{ model: "mimo-v2.6-flash", label: "MiMo V2.6 Flash", monthlyCap: 1_000_000_000, rollingWindowCap: 0, rollingWindowHours: 0, premium: false },
	{ model: "qwen3.6", label: "Qwen 3.6", monthlyCap: 0, rollingWindowCap: 0, rollingWindowHours: 0, premium: false },
	{ model: "gemma4", label: "Gemma 4", monthlyCap: 0, rollingWindowCap: 0, rollingWindowHours: 0, premium: false },
	{ model: "qwen3.8-flash", label: "Qwen 3.8 Flash", monthlyCap: 500_000_000, rollingWindowCap: 0, rollingWindowHours: 0, premium: false },
	{ model: "glm5.3-flash", label: "GLM 5.3 Flash", monthlyCap: 2_000_000_000, rollingWindowCap: 0, rollingWindowHours: 0, premium: false },
	{ model: "glm5.3", label: "GLM 5.3", monthlyCap: 3_000_000_000, rollingWindowCap: 400_000_000, rollingWindowHours: 4, premium: true },
];

// ── GET /v1/usage types ───────────────────────────────────────────────────

export interface UsageModelTotals {
	model: string;
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	api_requests: number;
}

export interface UsageTotals {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	api_requests: number;
	by_model: UsageModelTotals[];
}

export interface UsageAllTime {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	api_requests: number;
	cached_at: string | null;
}

export interface UsageReport {
	object: "usage.report";
	/** First day of the window actually served (after clamping). */
	start_date: string;
	/** Last day of the window actually served (after clamping). */
	end_date: string;
	/** Daily (date, model) rows — paginated; unused here (totals cover the window). */
	data: unknown[];
	totals: UsageTotals;
	all_time: UsageAllTime;
	has_more: boolean;
	next_cursor: string | null;
}

export interface UsageFetchError {
	/** HTTP status when the endpoint answered with an error. */
	status?: number;
	/** `Retry-After` seconds, present on 429. */
	retryAfterSeconds?: number;
	/** Endpoint or transport detail (error message / provider message). */
	detail?: string;
}

export type FetchUsageResult =
	| { ok: true; report: UsageReport }
	| { ok: false; error: UsageFetchError };

/** NaN's usage endpoint (OpenAPI tag "Usage"), API-key authed. */
export const NAN_USAGE_URL = "https://api.nan.builders/v1/usage";
export const USAGE_TIMEOUT_MS = 10_000;
/** The endpoint rejects windows wider than 90 inclusive days with 400. */
export const MAX_USAGE_WINDOW_DAYS = 90;

const USAGE_LINE =
	"Usage: /nan-usage [days] — days 1-90 (default: the current UTC month, matching the monthly caps). /nan-usage help";

// ── Time helpers ──────────────────────────────────────────────────────────

export interface UsageWindow {
	/** Inclusive start, `YYYY-MM-DD` UTC. */
	start: string;
	/** Inclusive end, `YYYY-MM-DD` UTC. */
	end: string;
	/** Inclusive day count. */
	days: number;
}

function isoDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function daysBetween(start: string, end: string): number {
	const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
	return Math.round(ms / 86_400_000) + 1;
}

function formatDuration(ms: number): string {
	if (ms <= 0) return "already reset";
	const totalSeconds = Math.floor(ms / 1000);
	const days = Math.floor(totalSeconds / 86400);
	const hours = Math.floor((totalSeconds % 86400) / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	parts.push(`${seconds}s`);
	return parts.join(" ");
}

function getNextBillingReset(now = new Date()): Date {
	const year = now.getUTCFullYear();
	const month = now.getUTCMonth();
	return new Date(Date.UTC(year, month + 1, 0, 0, 0, 0));
}

function resetLine(now = new Date()): string {
	const resetDate = getNextBillingReset(now);
	const timeUntilReset = resetDate.getTime() - now.getTime();
	return `⏱️  Next billing reset: ${isoDate(resetDate)} UTC (${formatDuration(timeUntilReset)})`;
}

/** Default window: the current UTC month, so usage lines up with the monthly caps. */
export function currentMonthWindow(now = new Date()): UsageWindow {
	const start = isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
	const end = isoDate(now);
	return { start, end, days: daysBetween(start, end) };
}

/** Rolling window of `days` inclusive days ending today (UTC), clamped to 1–90. */
export function rollingWindow(days: number, now = new Date()): UsageWindow {
	const span = Math.min(Math.max(Math.trunc(days), 1), MAX_USAGE_WINDOW_DAYS);
	const start = isoDate(new Date(now.getTime() - (span - 1) * 86_400_000));
	const end = isoDate(now);
	return { start, end, days: daysBetween(start, end) };
}

export type UsageArgs =
	| { kind: "window"; window: UsageWindow }
	| { kind: "help" }
	| { kind: "invalid"; message: string };

/** Parse the optional `/nan-usage [days]` argument. */
export function parseUsageArgs(tokens: readonly string[], now = new Date()): UsageArgs {
	if (tokens.length === 0) return { kind: "window", window: currentMonthWindow(now) };
	if (tokens.length === 1) {
		const token = tokens[0]!;
		if (["help", "-h", "--help"].includes(token.toLowerCase())) return { kind: "help" };
		if (/^\d+$/.test(token)) {
			const days = Number(token);
			if (days >= 1 && days <= MAX_USAGE_WINDOW_DAYS) return { kind: "window", window: rollingWindow(days, now) };
		}
	}
	return {
		kind: "invalid",
		message: `Unknown argument "${tokens.join(" ")}". ${USAGE_LINE}`,
	};
}

// ── Formatting helpers ────────────────────────────────────────────────────

export function formatTokens(n: number): string {
	if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

/** Locale-independent thousands separator (request counts). */
export function formatCount(n: number): string {
	return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function progressBar(percentage: number, width = 20): string {
	const clamped = Math.min(Math.max(percentage, 0), 100);
	const filled = Math.round((clamped / 100) * width);
	const empty = width - filled;
	return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

/**
 * `api_requests` comes back as 0 for some models that do have usage (live
 * probe 2026-09-27: qwen3.8-flash 796M tokens / 0 requests, while the window
 * total still sums the other models exactly). Reporting a bare "0 requests"
 * next to real consumption would read as a bug in this command, so say what
 * the endpoint actually reported.
 */
function requestsSuffix(tokens: number, requests: number): string {
	if (tokens > 0 && requests === 0) return "requests not reported";
	return `${formatCount(requests)} requests`;
}

// ── Message builders ──────────────────────────────────────────────────────

/** Static quota table — shown when no API key resolves. */
export function buildStaticMessage(now = new Date()): string {
	const lines: string[] = [
		"📊 NaN Quota Status (static limits)",
		"",
		resetLine(now),
		"",
		"Model                        Monthly Cap",
		"─".repeat(45),
	];

	for (const quota of MODEL_QUOTAS) {
		const capStr = quota.monthlyCap > 0 ? formatTokens(quota.monthlyCap) : "uncapped";
		const premiumStr = quota.premium ? " 👑" : "";
		const rollingStr = quota.rollingWindowCap > 0
			? ` (rolling ${formatTokens(quota.rollingWindowCap)}/${quota.rollingWindowHours}h)`
			: "";

		lines.push(`${quota.label.padEnd(28)} ${capStr}${premiumStr}${rollingStr}`);
	}

	lines.push("", `💡 Set ${NAN_API_KEY_ENV} or run \`/login nan\` to see real usage (GET /v1/usage).`);
	return lines.join("\n");
}

/** Usage report merged with the documented caps. */
export function buildUsageMessage(report: UsageReport, now = new Date()): string {
	const start = report.start_date;
	const end = report.end_date;
	const days = daysBetween(start, end);
	const totals = report.totals;
	const byModel = totals?.by_model ?? [];
	const totalTokens = totals?.total_tokens ?? 0;
	const totalRequests = totals?.api_requests ?? 0;

	const lines: string[] = [
		"📊 NaN Usage",
		"",
		`🗓️  Window: ${start} → ${end} UTC (${days} day${days === 1 ? "" : "s"})`,
		"",
		resetLine(now),
		"",
	];

	const usageOf = (model: string): UsageModelTotals | undefined => byModel.find((m) => m.model === model);

	if (totalTokens === 0 && totalRequests === 0 && byModel.length === 0) {
		lines.push("No usage in this window.");
	} else {
		const capped = MODEL_QUOTAS.filter((q) => q.monthlyCap > 0);
		const uncapped = MODEL_QUOTAS.filter((q) => q.monthlyCap === 0);
		const known = new Set(MODEL_QUOTAS.map((q) => q.model));
		const others = byModel.filter((m) => !known.has(m.model)).sort((a, b) => b.total_tokens - a.total_tokens);

		lines.push("Models with monthly caps:", "");
		for (const quota of capped) {
			const usage = usageOf(quota.model);
			const used = usage?.total_tokens ?? 0;
			const requests = usage?.api_requests ?? 0;
			const percentage = (used / quota.monthlyCap) * 100;
			const remaining = Math.max(quota.monthlyCap - used, 0);

			lines.push(`${quota.label}${quota.premium ? " 👑" : ""}:`);
			lines.push(`  ${progressBar(percentage)} ${percentage.toFixed(1)}% of monthly cap`);
			lines.push(
				`  Used: ${formatTokens(used)} / ${formatTokens(quota.monthlyCap)} (${formatTokens(remaining)} remaining) · ${requestsSuffix(used, requests)}`,
			);
			if (quota.rollingWindowCap > 0) {
				lines.push(
					`  ↳ rolling window: ${formatTokens(quota.rollingWindowCap)} / ${quota.rollingWindowHours}h ` +
						"(daily granularity — /usage cannot break it down)",
				);
			}
			lines.push("");
		}

		const usedUncapped = uncapped.filter((q) => (usageOf(q.model)?.total_tokens ?? 0) > 0);
		if (usedUncapped.length > 0) {
			lines.push("Uncapped models:", "");
			for (const quota of usedUncapped) {
				const usage = usageOf(quota.model)!;
				lines.push(`${quota.label}: ${formatTokens(usage.total_tokens)} used · ${requestsSuffix(usage.total_tokens, usage.api_requests)}`);
			}
			lines.push("");
		}

		if (others.length > 0) {
			lines.push("Other models (no documented cap):", "");
			for (const usage of others) {
				lines.push(`${usage.model}: ${formatTokens(usage.total_tokens)} used · ${requestsSuffix(usage.total_tokens, usage.api_requests)}`);
			}
			lines.push("");
		}
	}

	lines.push(
		`Window totals: ${formatTokens(totalTokens)} tokens ` +
			`(${formatTokens(totals?.prompt_tokens ?? 0)} prompt / ${formatTokens(totals?.completion_tokens ?? 0)} completion) · ` +
			`${formatCount(totalRequests)} requests`,
	);
	const allTime = report.all_time;
	if (allTime) {
		const cached = allTime.cached_at ? ` (cached ${allTime.cached_at.slice(0, 10)})` : "";
		lines.push(`All time: ${formatTokens(allTime.total_tokens)} tokens · ${formatCount(allTime.api_requests)} requests${cached}`);
	}
	lines.push("💡 Source: GET /v1/usage · caps from https://nan.builders/docs/models");
	return lines.join("\n");
}

/** Map an endpoint/transport failure to an actionable message. */
export function formatUsageError(error: UsageFetchError): string {
	const { status, retryAfterSeconds, detail } = error;
	const suffix = detail ? ` (${detail})` : "";
	if (status === 401) return `NaN rejected the API key (401). Run /login nan or set ${NAN_API_KEY_ENV} to a valid key${suffix}.`;
	if (status === 404) return `NaN has no usage identity for this account (404): nothing to report${suffix}.`;
	if (status === 429) {
		const wait = retryAfterSeconds === undefined ? "a few" : String(retryAfterSeconds);
		return `Rate limited by /usage (429): retry in ${wait}s — 30 requests/min, separate from the model endpoints${suffix}.`;
	}
	if (status === 409) return `The API key alias is reserved for a service key (409); usage is not reported for it${suffix}.`;
	if (status === 400) return `NaN rejected the /usage parameters (400)${suffix}.`;
	if (status !== undefined && status >= 500) return `NaN /usage is failing (HTTP ${status})${suffix}. Try again shortly.`;
	return `Could not fetch NaN usage${suffix}.`;
}

// ── Endpoint client ───────────────────────────────────────────────────────

export interface FetchUsageOptions {
	apiKey: string;
	window: UsageWindow;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

/**
 * `GET /v1/usage?start_date&end_date&limit=1` with Bearer auth.
 * `limit=1` keeps the payload small: `totals` always spans the whole window,
 * so the daily rows are never needed. Never throws — failures come back as
 * `{ ok: false, error }`.
 */
export async function fetchUsageReport(options: FetchUsageOptions): Promise<FetchUsageResult> {
	const { apiKey, window, fetchImpl = fetch, timeoutMs = USAGE_TIMEOUT_MS } = options;
	const url = `${NAN_USAGE_URL}?start_date=${window.start}&end_date=${window.end}&limit=1`;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(url, {
			method: "GET",
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			cache: "no-store",
			signal: controller.signal,
		});
		if (!response.ok) {
			const retryAfter = Number(response.headers.get("retry-after"));
			let detail: string | undefined;
			try {
				const body = (await response.json()) as { error?: { message?: string } };
				detail = body?.error?.message;
			} catch {
				// Non-JSON error body (proxy/CDN page) — status alone is enough.
			}
			return {
				ok: false,
				error: {
					status: response.status,
					...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
					...(detail ? { detail } : {}),
				},
			};
		}
		const report = (await response.json()) as UsageReport;
		if (!report || typeof report !== "object" || !report.totals) {
			return { ok: false, error: { detail: "unexpected payload from /v1/usage (no totals)" } };
		}
		return { ok: true, report };
	} catch (error) {
		return { ok: false, error: { detail: error instanceof Error ? error.message : String(error) } };
	} finally {
		clearTimeout(timeout);
	}
}

// ── Command registration ──────────────────────────────────────────────────

export interface NanUsageCommandOptions {
	/** Injected transport (tests); defaults to the global fetch. */
	fetchImpl?: typeof fetch;
	/** Injected API-key resolution (tests); defaults to pi's registry + env. */
	resolveApiKey?: (ctx: ExtensionCommandContext) => Promise<string | undefined>;
}

export function registerNanUsageCommand(pi: ExtensionAPI, options: NanUsageCommandOptions = {}): void {
	if (typeof pi.registerCommand !== "function") return;

	const resolveApiKey = options.resolveApiKey ?? (async (ctx: ExtensionCommandContext): Promise<string | undefined> => {
				const registryKey = await tryResolveNanApiKeyViaRegistry(ctx.modelRegistry);
				return resolveNanApiKey(registryKey);
			});

	pi.registerCommand("nan-usage", {
		description: "Show NaN token usage vs monthly caps, window/all-time totals, and time until billing reset",
		getArgumentCompletions: (argumentPrefix: string) => {
			const prefix = argumentPrefix.trim().toLowerCase();
			const items = [
				{ value: "", label: "(current month)", description: "Usage for the current UTC month" },
				{ value: "7", label: "7", description: "Rolling 7-day window" },
				{ value: "30", label: "30", description: "Rolling 30-day window" },
				{ value: "90", label: "90", description: "Rolling 90-day window (API maximum)" },
				{ value: "help", label: "help", description: "Show the usage line" },
			];
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const parsed = parseUsageArgs(tokens);

			if (parsed.kind === "help") {
				ctx.ui.notify(USAGE_LINE, "info");
				return;
			}
			if (parsed.kind === "invalid") {
				ctx.ui.notify(parsed.message, "warning");
				return;
			}

			const apiKey = await resolveApiKey(ctx);
			if (!apiKey) {
				ctx.ui.notify(buildStaticMessage(), "info");
				return;
			}

			ctx.ui.notify("Fetching usage from GET /v1/usage ...", "info");
			const result = await fetchUsageReport({
				apiKey,
				window: parsed.window,
				...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
			});
			ctx.ui.notify(
				result.ok ? buildUsageMessage(result.report) : formatUsageError(result.error),
				result.ok ? "info" : "warning",
			);
		},
	});
}

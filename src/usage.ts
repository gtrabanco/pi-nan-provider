/**
 * `/nan-usage` — slash command showing NaN quota status per model.
 *
 * NaN's quota endpoint (`cloud-api.nan.builders/api/usage/quota`) requires
 * a session token (not API key auth). The token is obtained via the NaN CLI
 * login flow (email → link → `nan_session` cookie), stored in
 * `~/.config/nan/session.json`.
 *
 * This command auto-detects the nan-cli session file. No env vars needed —
 * just run `nan auth login` once and `/nan-usage` works.
 *
 * Quota sources: https://nan.builders/docs/models (checked 2026-09-21)
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
	{ model: "mimo-v2.5", label: "MiMo V2.5", monthlyCap: 1_000_000_000, rollingWindowCap: 0, rollingWindowHours: 0, premium: false },
	{ model: "qwen3.6", label: "Qwen 3.6", monthlyCap: 0, rollingWindowCap: 0, rollingWindowHours: 0, premium: false },
	{ model: "gemma4", label: "Gemma 4", monthlyCap: 0, rollingWindowCap: 0, rollingWindowHours: 0, premium: false },
	{ model: "qwen3.8-flash", label: "Qwen 3.8 Flash", monthlyCap: 500_000_000, rollingWindowCap: 0, rollingWindowHours: 0, premium: false },
	{ model: "glm5.3-flash", label: "GLM 5.3 Flash", monthlyCap: 2_000_000_000, rollingWindowCap: 0, rollingWindowHours: 0, premium: false },
	{ model: "glm5.3", label: "GLM 5.3", monthlyCap: 3_000_000_000, rollingWindowCap: 400_000_000, rollingWindowHours: 4, premium: true },
];

// ── Dashboard API types ───────────────────────────────────────────────────

interface DashboardModelQuota {
	model: string;
	tokensUsed: number;
	cap: number;
	percentage: number;
	resetAt: string | null;
	windowHours: number | null;
}

interface DashboardUncappedModelQuota {
	model: string;
	tokensUsed: number;
	resetAt: string | null;
	windowHours: number | null;
}

interface DashboardQuotaResponse {
	periodStart: string;
	models: Array<{
		model: string;
		tokensUsed: number;
		cap: number;
		windowHours?: number;
		periodEnd?: string;
	}>;
}

// ── nan-cli session reader ────────────────────────────────────────────────

interface NanCliSession {
	token: string;
}

/** Read the nan_session token from ~/.config/nan/session.json (shared with nan-cli). */
function readNanCliSessionToken(): string | undefined {
	try {
		const sessionPath = join(homedir(), ".config", "nan", "session.json");
		const data = readFileSync(sessionPath, "utf8");
		const session = JSON.parse(data) as NanCliSession;
		if (typeof session === "object" && session !== null && typeof session.token === "string" && session.token.length > 0) {
			return session.token;
		}
	} catch {
		// File doesn't exist or is invalid.
	}
	return undefined;
}

// ── Time helpers ──────────────────────────────────────────────────────────

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

function getNextBillingReset(): Date {
	const now = new Date();
	const year = now.getUTCFullYear();
	const month = now.getUTCMonth();
	return new Date(Date.UTC(year, month + 1, 0, 0, 0, 0));
}

function formatTokens(n: number): string {
	if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function progressBar(percentage: number, width = 20): string {
	const filled = Math.round((percentage / 100) * width);
	const empty = width - filled;
	return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

// ── Dashboard client ──────────────────────────────────────────────────────

const DASHBOARD_QUOTA_URL = "https://cloud-api.nan.builders/api/usage/quota";
const FETCH_TIMEOUT_MS = 10_000;

async function fetchDashboardQuota(token: string): Promise<DashboardQuotaResponse | null> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		try {
			const response = await fetch(DASHBOARD_QUOTA_URL, {
				method: "GET",
				headers: { cookie: `nan_session=${token}` },
				redirect: "manual",
				cache: "no-store",
				signal: controller.signal,
			});
			if (!response.ok) return null;
			return (await response.json()) as DashboardQuotaResponse;
		} finally {
			clearTimeout(timeout);
		}
	} catch {
		return null;
	}
}

function parseDashboardQuota(data: DashboardQuotaResponse): {
	capped: DashboardModelQuota[];
	uncapped: DashboardUncappedModelQuota[];
} {
	const capped: DashboardModelQuota[] = [];
	const uncapped: DashboardUncappedModelQuota[] = [];
	const seen = new Set<string>();

	for (const entry of data.models) {
		if (seen.has(entry.model)) continue;
		seen.add(entry.model);

		if (entry.cap === 0) {
			uncapped.push({
				model: entry.model,
				tokensUsed: entry.tokensUsed,
				resetAt: entry.periodEnd ?? null,
				windowHours: entry.windowHours ?? null,
			});
		} else {
			capped.push({
				model: entry.model,
				tokensUsed: entry.tokensUsed,
				cap: entry.cap,
				percentage: (entry.tokensUsed / entry.cap) * 100,
				resetAt: entry.periodEnd ?? null,
				windowHours: entry.windowHours ?? null,
			});
		}
	}

	return { capped, uncapped };
}

// ── Message builders ──────────────────────────────────────────────────────

function buildStaticMessage(): string {
	const resetDate = getNextBillingReset();
	const timeUntilReset = resetDate.getTime() - Date.now();

	const lines: string[] = [
		"📊 NaN Quota Status (static limits)",
		"",
		`⏱️  Next billing reset: ${resetDate.toISOString().split("T")[0]} UTC (${formatDuration(timeUntilReset)})`,
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

	lines.push("");
	lines.push("💡 Run `nan auth login` to see real usage data.");

	return lines.join("\n");
}

function buildDashboardMessage(
	capped: DashboardModelQuota[],
	uncapped: DashboardUncappedModelQuota[],
): string {
	const resetDate = getNextBillingReset();
	const timeUntilReset = resetDate.getTime() - Date.now();

	const lines: string[] = [
		"📊 NaN Quota Status",
		"",
		`⏱️  Next billing reset: ${resetDate.toISOString().split("T")[0]} UTC (${formatDuration(timeUntilReset)})`,
		"",
	];

	if (capped.length > 0) {
		lines.push("Models with monthly caps:");
		lines.push("");
		for (const m of capped) {
			const quota = MODEL_QUOTAS.find((q) => q.model === m.model);
			const label = quota?.label ?? m.model;
			const pct = m.percentage.toFixed(1);
			const remaining = m.cap - m.tokensUsed;
			lines.push(`${label}:`);
			lines.push(`  ${progressBar(m.percentage)} ${pct}%`);
			lines.push(`  Used: ${formatTokens(m.tokensUsed)} / ${formatTokens(m.cap)} (${formatTokens(remaining)} remaining)`);
			if (m.windowHours) {
				lines.push(`  Rolling window: ${m.windowHours}h`);
			}
			lines.push("");
		}
	}

	if (uncapped.length > 0) {
		lines.push("Uncapped models:");
		lines.push("");
		for (const m of uncapped) {
			const quota = MODEL_QUOTAS.find((q) => q.model === m.model);
			const label = quota?.label ?? m.model;
			lines.push(`${label}: ${formatTokens(m.tokensUsed)} used`);
		}
		lines.push("");
	}

	if (capped.length === 0 && uncapped.length === 0) {
		lines.push("No usage data. Session may have expired.");
		lines.push("Run `nan auth login` to refresh.");
	}

	return lines.join("\n");
}

// ── Command registration ──────────────────────────────────────────────────

export function registerNanUsageCommand(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI): void {
	if (typeof pi.registerCommand !== "function") return;

	pi.registerCommand("nan-usage", {
		description: "Show NaN quota status: token limits, usage, and time until billing reset",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const token = readNanCliSessionToken();

			if (token) {
				ctx.ui.notify("Fetching usage from NaN dashboard...", "info");
				const data = await fetchDashboardQuota(token);
				if (data) {
					const { capped, uncapped } = parseDashboardQuota(data);
					ctx.ui.notify(buildDashboardMessage(capped, uncapped), "info");
				} else {
					ctx.ui.notify(
						"Failed to fetch dashboard data. Session may have expired.\n" +
						"Run `nan auth login` to refresh.",
						"warning",
					);
				}
			} else {
				ctx.ui.notify(buildStaticMessage(), "info");
			}
		},
	});
}

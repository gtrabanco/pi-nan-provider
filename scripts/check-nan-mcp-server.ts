#!/usr/bin/env bun
/**
 * Detect whether an updated `nan-mcp-server` is available and, if so, decide
 * whether it is safe to bump the pinned version this package bridges.
 *
 * This is the automated companion to the manual "should we update?" question
 * for the community stdio MCP server (`nan-mcp-server`, the media bridge). It
 * exists because pi implements NO MCP client — we bridge the server's tools as
 * native pi tools, and the bridge is pinned to a version via
 * `DEFAULT_NAN_MEDIA_MCP_VERSION`. When the upstream server ships a new
 * version we want a signal, not a silent drift.
 *
 * What it checks (all live, no human guesswork):
 *   1. Latest published `nan-mcp-server` version on the npm registry.
 *   2. Whether the latest version is newer than the pinned version.
 *   3. The *tool surface* of the latest server vs the tools we bridge: if the
 *      latest server still exposes every bridged tool, the update is **safe**
 *      (non-breaking) even if the implementation changed. If it dropped or
 *      renamed a bridged tool, the bump is **breaking** and needs manual
 *      review before proceeding — an agent check cannot auto-bump that.
 *   4. The upstream commit list between the pinned and latest versions, so a
 *      maintainer sees WHAT changed without re-deriving from stale docs.
 *
 * Output: a single structured `NanMcpServerCheckReport` (JSON). The script
 * exits 0 when up-to-date or when the check cannot be completed (so a cron is
 * quiet unless there is news), and it creates/updates a GitHub issue when an
 * update is available and `GITHUB_TOKEN` is present.
 *
 * Usage:
 *   bun run scripts/check-nan-mcp-server.ts            # report to stdout
 *   bun run scripts/check-nan-mcp-server.ts --json     # machine-readable JSON
 *   bun run scripts/check-nan-mcp-server.ts --issue    # create/update an issue (needs GITHUB_TOKEN)
 *
 * The pure decision logic (`parseVersion`, `compareVersions`, `extractServerTools`,
 * `assessUpdate`, `buildReport`) is exported for unit tests so the whole verdict
 * is verifiable without touching the network. The network fetchers accept an
 * injected `fetch` so tests can stub the registry/unpkg/github sources.
 *
 * Exit codes: 0 always (a cron should be quiet unless a human acts). Use
 * `--json` to consume the report and decide what to do with it.
 */

import {
	DEFAULT_NAN_MEDIA_MCP_VERSION,
	NAN_MEDIA_MCP_SERVER_TOOLS,
} from "../src/mcp/nan-media.ts";

/** npm package name of the community stdio MCP server we bridge. */
export const NAN_MCP_SERVER_PACKAGE = "nan-mcp-server";
/** npm registry endpoint for the package's latest release. */
export const NAN_MCP_SERVER_REGISTRY_URL = "https://registry.npmjs.org/nan-mcp-server/latest";
/** unpkg CDN path to the published server source, used to extract the tool surface. */
export const NAN_MCP_SERVER_SOURCE_URL = (version: string) =>
	`https://unpkg.com/nan-mcp-server@${version}/server.js`;
/** GitHub compare API for the upstream commit list between two tags. */
export const NAN_MCP_SERVER_COMPARE_URL = (from: string, to: string) =>
	`https://api.github.com/repos/luciferfran/nan-mcp-server/compare/v${from.replace(/^v/, "")}...v${to.replace(/^v/, "")}`;

/** GitHub search-issues endpoint used to dedupe the update issue. */
const GITHUB_SEARCH_ISSUES_URL =
	"https://api.github.com/search/issues?q=" +
	"repo:gtrabanco/pi-nan-provider+is:issue+is:open+in:title" +
	'+label:dependencies+type:issue+"nan-mcp-server update"';

/** Label to attach to the auto-created update issue (dedupe key + visibility). */
export const NAN_MCP_UPDATE_ISSUE_LABEL = "dependencies";
/** Title template; the version pair is appended so each update is its own issue. */
export const NAN_MCP_UPDATE_ISSUE_TITLE_PREFIX = "[auto] nan-mcp-server update available";

export interface NanMcpServerCheckReport {
	/** npm package scanned. */
	package: string;
	/** Version pinned in this package's bridge (source of truth: nan-media.ts). */
	pinnedVersion: string;
	/** Latest version published on npm; null when the registry could not be read. */
	latestVersion: string | null;
	/** true when latestVersion is strictly newer than pinnedVersion. */
	updateAvailable: boolean;
	/** How the verdict was reached: registry in reach, no drift, or an error. */
	status: "up-to-date" | "update-available" | "check-failed";
	/** true when a bridged tool is missing from the latest server surface. */
	breaking: boolean;
	/** Tools added by the latest server that we do NOT bridge (informational). */
	addedTools: string[];
	/** Bridged tools dropped/renamed by the latest server (breaking → manual). */
	removedTools: string[];
	/** Upstream commit subjects between pinned and latest (when reachable). */
	changelog: string[];
	/** Human-readable verdict sentence. */
	reason: string;
	/** When the check could not reach a source (registry/unpkg/github). */
	error?: string;
}

/**
 * Parse a semver-ish string (`1.0.8`, `v1.0.8`) into numeric major/minor/patch.
 * Non-numeric release segments are clamped to 0 so `1.0.8` and `1.0.8-rc.1`
 * compare sensibly; malformed input yields `[0, 0, 0]` (never throws).
 */
export function parseVersion(input: string): [number, number, number] {
	const cleaned = String(input).trim().replace(/^v/, "").split(/[-+.]/);
	const toNum = (segment: string | undefined) => {
		const n = Number.parseInt(segment ?? "", 10);
		return Number.isFinite(n) ? n : 0;
	};
	return [toNum(cleaned[0]), toNum(cleaned[1]), toNum(cleaned[2])];
}

/**
 * Compare two version strings. Returns 1 when `a` is newer, -1 when older,
 * 0 when equal. Comparable to a numeric semver compare for x.y.z inputs.
 */
export function compareVersions(a: string, b: string): number {
	const [amaj, amin, apatch] = parseVersion(a);
	const [bmaj, bmin, bpatch] = parseVersion(b);
	if (amaj !== bmaj) return amaj > bmaj ? 1 : -1;
	if (amin !== bmin) return amin > bmin ? 1 : -1;
	if (apatch !== bpatch) return apatch > bpatch ? 1 : -1;
	return 0;
}

/** Extract every `registerTool("NAME")` from a server.js source string. */
export function extractServerTools(source: string): string[] {
	const names = new Set<string>();
	const re = /registerTool\(\s*["']([^"']+)["']/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(source)) !== null) {
		names.add(match[1]!);
	}
	return [...names].sort();
}

/**
 * Compare the latest server tool surface against the bridged tools and decide
 * whether the update is safe to bump. The only hard break is a bridged tool
 * disappearing (dropped or renamed); anything else — new tools, bug fixes,
 * schema tightening (e.g. `edit_image` now rejects >4 images) — is safe for
 * our bridge, because we forward the params the schema already documents.
 */
export function assessUpdate(latestTools: string[]): {
	breaking: boolean;
	addedTools: string[];
	removedTools: string[];
	reason: string;
} {
	const bridged: readonly string[] = [...NAN_MEDIA_MCP_SERVER_TOOLS];
	const latest = new Set(latestTools.map((t) => t.trim()));

	const removedTools = bridged.filter((tool) => !latest.has(tool));
	const addedTools = latestTools.filter((tool) => !bridged.includes(tool));

	const breaking = removedTools.length > 0;

	let reason: string;
	if (breaking) {
		reason =
			`BREAKING: the latest nan-mcp-server no longer exposes ${removedTools.join(", ")}. ` +
			"Bumping the pin would break the bridged tool(s) — manual review required before deciding.";
	} else if (addedTools.length > 0) {
		reason = `Safe to bump (non-breaking): every bridged tool is still present. New upstream tool(s) ${addedTools.join(", ")} are NOT bridged by this package (optional future work).`;
	} else {
		reason = "Safe to bump (non-breaking): every bridged tool is still present, and no new upstream tools were added.";
	}

	return { breaking, addedTools, removedTools, reason };
}

/**
 * Build the full report from already-fetched data. Pure — no network. Missing
 * or stale inputs degrade to `check-failed`, and an update is only reported
 * when the latest version is strictly newer than the pinned one.
 */
export function buildReport(input: {
	pinnedVersion: string;
	latestVersion: string | null;
	latestTools: string[];
	changelog: string[];
	error?: string;
}): NanMcpServerCheckReport {
	const { pinnedVersion, latestVersion, latestTools, changelog, error } = input;

	if (error) {
		return {
			package: NAN_MCP_SERVER_PACKAGE,
			pinnedVersion,
			latestVersion: null,
			updateAvailable: false,
			status: "check-failed",
			breaking: false,
			addedTools: [],
			removedTools: [],
			changelog: [],
			reason: `Could not complete the check: ${error}`,
			error,
		};
	}

	if (latestVersion === null) {
		return {
			package: NAN_MCP_SERVER_PACKAGE,
			pinnedVersion,
			latestVersion: null,
			updateAvailable: false,
			status: "check-failed",
			breaking: false,
			addedTools: [],
			removedTools: [],
			changelog: [],
			reason: "Could not read the npm registry for the latest version.",
			error: "registry-unreachable",
		};
	}

	const updateAvailable = compareVersions(latestVersion, pinnedVersion) > 0;
	if (!updateAvailable) {
		return {
			package: NAN_MCP_SERVER_PACKAGE,
			pinnedVersion,
			latestVersion,
			updateAvailable: false,
			status: "up-to-date",
			breaking: false,
			addedTools: [],
			removedTools: [],
			changelog: [],
			reason: `Up to date: pinned ${pinnedVersion} is not older than latest ${latestVersion}.`,
		};
	}

	const verdict = assessUpdate(latestTools);
	return {
		package: NAN_MCP_SERVER_PACKAGE,
		pinnedVersion,
		latestVersion,
		updateAvailable: true,
		status: "update-available",
		breaking: verdict.breaking,
		addedTools: verdict.addedTools,
		removedTools: verdict.removedTools,
		changelog,
		reason: verdict.reason,
	};
}

/** A minimal fetch-compatible signature so tests can stub it without undici types. */
export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

async function readJson<T>(url: string, fetchImpl: FetchLike, headers?: Record<string, string>): Promise<T> {
	const res = await fetchImpl(url, { headers });
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} from ${url}`);
	}
	return (await res.json()) as T;
}

/** Fetch the latest published version of the package from the npm registry. */
export async function fetchLatestVersion(fetchImpl: FetchLike = fetch): Promise<string> {
	const data = await readJson<{ version?: string; "dist-tags"?: { latest?: string } }>(
		NAN_MCP_SERVER_REGISTRY_URL,
		fetchImpl,
	);
	const version = data["dist-tags"]?.latest ?? data.version;
	if (!version) throw new Error("npm registry response had no version");
	return version;
}

/** Fetch the published server.js source and extract its tool surface. */
export async function fetchServerTools(
	version: string,
	fetchImpl: FetchLike = fetch,
): Promise<string[]> {
	const res = await fetchImpl(NAN_MCP_SERVER_SOURCE_URL(version));
	if (!res.ok) throw new Error(`HTTP ${res.status} from ${NAN_MCP_SERVER_SOURCE_URL(version)}`);
	return extractServerTools(await res.text());
}

/** Fetch upstream commit subjects between two tags (best-effort; empty on failure). */
export async function fetchChangelog(
	from: string,
	to: string,
	fetchImpl: FetchLike = fetch,
): Promise<string[]> {
	try {
		const data = await readJson<{ commits?: Array<{ commit?: { message?: string } }> }>(
			NAN_MCP_SERVER_COMPARE_URL(from, to),
			fetchImpl,
		);
		return (data.commits ?? [])
			.map((c) => c.commit?.message?.split("\n")[0]?.trim() ?? "")
			.filter(Boolean);
	} catch {
		return [];
	}
}

const ARGS = process.argv.slice(2);
/** Rendered issue body from a report — what a maintainer reads to decide. */
export function renderIssueBody(report: NanMcpServerCheckReport): string {
	const lines: string[] = [];
	lines.push(`**Package**: \`${report.package}\``);
	lines.push(`**Pinned by this package**: \`${report.pinnedVersion}\``);
	lines.push(`**Latest on npm**: \`${report.latestVersion ?? "unknown"}\``);
	lines.push(`**Verdict**: ${report.breaking ? "⚠️ BREAKING — manual review required" : "✅ Safe to bump (non-breaking)"}`);
	lines.push("");
	lines.push(`> ${report.reason}`);
	lines.push("");
	if (report.changelog.length > 0) {
		lines.push("### Upstream changes");
		lines.push("", ...report.changelog.map((c) => `- ${c}`), "");
	}
	lines.push("### To bump");
	lines.push(
		`1. Edit \`DEFAULT_NAN_MEDIA_MCP_VERSION\` in \`src/mcp/nan-media.ts\` from \`${report.pinnedVersion}\` to \`${report.latestVersion}\`.`,
	);
	lines.push("2. Run \`bun test && bun run typecheck\`.");
	lines.push(
		report.breaking
			? "3. Investigate the removed tool(s) — decide whether to bridge an alternative or keep the older pin."
			: "3. Commit the bump and close this issue (it was auto-created).",
	);
	return lines.join("\n");
}

/** GitHub API root for this repository's issues. */
export const NAN_MCP_REPO_ISSUES_URL = "https://api.github.com/repos/gtrabanco/pi-nan-provider/issues";

async function sendIssueRequest<T>(
	url: string,
	method: string,
	body: object | undefined,
	token: string,
): Promise<T> {
	const res = await fetch(url, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	if (!res.ok) throw new Error(`GitHub API ${method} ${url} → HTTP ${res.status}`);
	return (await res.json()) as T;
}

/**
 * Create a pre-engineered update issue, or refresh an existing open one with
 * the same title+label instead of stacking duplicates across cron runs.
 * Returns the issue URL (web or API) so the caller can surface it.
 */
export async function createOrUpdateIssue(
	report: NanMcpServerCheckReport,
	token: string,
): Promise<string> {
	const title = `${NAN_MCP_UPDATE_ISSUE_TITLE_PREFIX}: ${report.pinnedVersion} → ${report.latestVersion ?? "?"}`;
	const body = renderIssueBody(report);

	// Dedupe key: an OPEN issue whose title matches AND carries the label.
	const searchUrl = `${GITHUB_SEARCH_ISSUES_URL}+${encodeURIComponent(`"${title}"`)}`;
	const search = await sendIssueRequest<{ items?: Array<{ number: number; html_url: string }> }>(
		searchUrl,
		"GET",
		undefined,
		token,
	);
	const existing = search.items?.[0];
	if (existing) {
		const patchUrl = `${NAN_MCP_REPO_ISSUES_URL}/${existing.number}`;
		await sendIssueRequest(patchUrl, "PATCH", { body }, token);
		return existing.html_url;
	}

	const created = await sendIssueRequest<{ html_url: string }>(
		NAN_MCP_REPO_ISSUES_URL,
		"POST",
		{ title, body, labels: [NAN_MCP_UPDATE_ISSUE_LABEL] },
		token,
	);
	return created.html_url;
}

/** Main entry point. */
async function main(): Promise<void> {
	let report: NanMcpServerCheckReport;
	try {
		const pinnedVersion = DEFAULT_NAN_MEDIA_MCP_VERSION;
		const latestVersion = await fetchLatestVersion();
		let latestTools: string[] = [];
		let changelog: string[] = [];
		if (compareVersions(latestVersion, pinnedVersion) > 0) {
			latestTools = await fetchServerTools(latestVersion).catch(() => []);
			changelog = await fetchChangelog(pinnedVersion, latestVersion);
		}
		report = buildReport({ pinnedVersion, latestVersion, latestTools, changelog });
	} catch (error) {
		report = buildReport({
			pinnedVersion: DEFAULT_NAN_MEDIA_MCP_VERSION,
			latestVersion: null,
			latestTools: [],
			changelog: [],
			error: error instanceof Error ? error.message : String(error),
		});
	}

	if (ARGS.includes("--json")) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(`nan-mcp-server: pinned ${report.pinnedVersion}, latest ${report.latestVersion ?? "unknown"}`);
		console.log(`  status: ${report.status}  breaking: ${report.breaking}`);
		console.log(`  ${report.reason}`);
		if (report.changelog.length > 0) {
			console.log("  upstream:");
			for (const c of report.changelog) console.log(`    - ${c}`);
		}
	}

	const token = process.env.GITHUB_TOKEN;
	if (ARGS.includes("--issue") && report.status === "update-available" && token) {
		const url = await createOrUpdateIssue(report, token);
		console.log(`  issue: ${url}`);
	} else if (ARGS.includes("--issue") && report.status === "update-available" && !token) {
		console.log("  --issue requested but GITHUB_TOKEN is not set; issue NOT created.");
	}
}

await main();

/**
 * ACCEPTANCE TESTS — PR/issue #44 correction batch (EV-2026-11-18)
 * `/nan-debug` error tracking (`error_summary`, `errors.jsonl` shape),
 * `--interval` at the command boundary, interval window filtering, and the
 * `sessions/` redaction scope.
 *
 * Frozen-failure corpus for the blockers B2–B5 and advisory A3 of
 * docs/fix/issue-35-cf-ray-cache-evidence/external-verify.md (2026-11-18):
 * every test in the "frozen failures" describes blocks reproduced RED before
 * the batch; the remaining blocks pin the previously verified behavior so the
 * fix cannot regress it.
 *
 * https://github.com/gtrabanco/pi-nan-provider/issues/44
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
	DEBUG_USAGE_LINE,
	buildDebugReport,
	parseDebugArgs,
	parseFlexibleTime,
	renderDebugReport,
} from "../src/debug-report.ts";

const NOW = new Date("2026-11-11T12:00:00.000Z");
const CWD_SECRET = "/home/agent/projects/secret-worktree";
const CONTENT_LITERAL = "SECRET_PROMPT_LITERAL";
const LONG_ERROR = `NaN timed out the stream before any answer content: ${"x".repeat(250)}`;

let scratchDirs: string[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "nan-debug-44-"));
	scratchDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
	scratchDirs = [];
});

function md5Short(value: string): string {
	return createHash("md5").update(value).digest("hex").slice(0, 16);
}

function assistantLine(timestamp: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "message",
		timestamp,
		message: {
			role: "assistant",
			provider: "nan",
			api: "openai-completions",
			model: "qwen3.6",
			usage: { input: 200, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 200 },
			stopReason: "stop",
			timestamp: Date.parse(timestamp),
			responseId: "chatcmpl-44",
			content: [{ type: "text", text: CONTENT_LITERAL }],
			...extra,
		},
	});
}

function fixtureAgentDir(): string {
	const agentDir = scratch();
	const dir = join(agentDir, "sessions", "--home-agent-projects-secret-worktree--");
	mkdirSync(dir, { recursive: true });
	// Session on the interval start date: one errored turn (transport, >200 chars), one clean turn.
	writeFileSync(
		join(dir, "2026-11-10T09-00-00-000Z_a.jsonl"),
		[
			JSON.stringify({ type: "session", version: 3, id: "a", cwd: CWD_SECRET, timestamp: "2026-11-10T09:00:00.000Z" }),
			JSON.stringify({ type: "message", message: { role: "user", content: CONTENT_LITERAL } }),
			assistantLine("2026-11-10T09:00:00.000Z", { stopReason: "error", errorMessage: LONG_ERROR }),
			assistantLine("2026-11-10T10:00:00.000Z"),
			"",
		].join("\n"),
	);
	// Session "today" for the same-day relative-span filter.
	writeFileSync(
		join(dir, "2026-11-11T11-45-00-000Z_b.jsonl"),
		[
			JSON.stringify({ type: "session", version: 3, id: "b", cwd: CWD_SECRET, timestamp: "2026-11-11T11:45:00.000Z" }),
			assistantLine("2026-11-11T11:45:00.000Z"),
			"",
		].join("\n"),
	);
	return agentDir;
}

// ── EV-2026-11-18 B3: every documented --interval form at the command boundary ──

describe("issue #44 — frozen failures: --interval argument boundary (B3)", () => {
	test("every documented range/open form survives parseDebugArgs", () => {
		const cases: Array<[string, string]> = [
			["--interval 2026-11-10 - 2026-11-11 17:30", "2026-11-10 - 2026-11-11 17:30"],
			["--interval 10:30 - 11:00", "10:30 - 11:00"],
			["--interval 23:00 - 01:00", "23:00 - 01:00"],
			["--interval 2026-11-10 -", "2026-11-10 -"],
			["--interval 2026-11 - 2026-12", "2026-11 - 2026-12"],
			['--interval "2026-11-10 - 2026-11-11 17:30"', "2026-11-10 - 2026-11-11 17:30"],
			['--interval " - 2026-11-10"', "- 2026-11-10"],
			["--interval - 2026-11-10", "- 2026-11-10"],
		];
		for (const [input, expected] of cases) {
			const parsed = parseDebugArgs(input);
			expect(parsed.ok, input).toBe(true);
			if (parsed.ok) expect(parsed.args.interval, input).toBe(expected);
		}
	});

	test("flag tokens stop the interval value; topic and single-token forms keep working", () => {
		const a = parseDebugArgs("--interval 5min --emit");
		expect(a.ok).toBe(true);
		if (a.ok) {
			expect(a.args.interval).toBe("5min");
			expect(a.args.emit).toBe(true);
		}
		const b = parseDebugArgs("cache --interval 5min");
		expect(b.ok).toBe(true);
		if (b.ok) {
			expect(b.args.topic).toBe("cache");
			expect(b.args.interval).toBe("5min");
		}
		// Single-token relative/date forms parse end-to-end through the parser.
		expect(parseFlexibleTime("5min", NOW)).toHaveProperty("start");
		expect(parseFlexibleTime("2026-11-10", NOW)).toHaveProperty("start", "2026-11-10T00:00:00.000Z");
		expect(parseFlexibleTime("2026-11-10T10:00:00Z", NOW)).toHaveProperty("start", "2026-11-10T10:00:00.000Z");
	});

	test("open-right ends now; open-left starts at the default window start", () => {
		const openRight = parseFlexibleTime("2026-11-10 -", NOW);
		expect(openRight).toMatchObject({ start: "2026-11-10T00:00:00.000Z", end: NOW.toISOString() });

		const openLeft = parseFlexibleTime("- 2026-11-10", NOW);
		// rollingWindow(7, NOW) starts six days back: 2026-11-05 (inclusive 7-day window).
		expect(openLeft).toMatchObject({ start: "2026-11-05T00:00:00.000Z", end: "2026-11-10T00:00:00.000Z" });
	});

	test("the usage line advertises only forms that parse (no 2año under the 90-day cap)", () => {
		expect(DEBUG_USAGE_LINE).not.toContain("2año");
		const over = parseFlexibleTime("2año", NOW);
		expect(over).toMatchObject({ ok: false });
		if ("error" in over) expect(over.error).toContain("Interval too large (max 90 days).");
		const range = parseFlexibleTime("2026-01-01 - 2026-06-01", NOW);
		expect(range).toMatchObject({ ok: false });
		if ("error" in range) expect(range.error).toContain("Interval too large (max 90 days).");
	});

	test("--window and --interval stay mutually exclusive; malformed values still fail (regression pins)", () => {
		const both = parseDebugArgs("--window 7 --interval 2h");
		expect(both.ok).toBe(false);
		if (!both.ok) expect(both.error).toContain("Cannot use --window and --interval together");

		for (const input of ["--interval", "--interval --emit", "--bogus", "two topics"]) {
			const parsed = parseDebugArgs(input);
			expect(parsed.ok, input).toBe(false);
			if (!parsed.ok) expect(parsed.error).toContain("Usage: /nan-debug");
		}
		// Pre-#44 forms parse unchanged.
		const legacy = parseDebugArgs("cache --window 3 --out /tmp/report --emit");
		expect(legacy.ok).toBe(true);
		if (legacy.ok) {
			expect(legacy.args).toEqual({
				topic: "cache",
				windowDays: 3,
				windowProvided: true,
				out: "/tmp/report",
				emit: true,
				includePrompts: false,
				includeTools: false,
				all: false,
			});
		}
		expect(parseDebugArgs("").ok).toBe(true);
	});
});

// ── EV-2026-11-18 B4 + A3: interval window filtering and day counts ──

describe("issue #44 — frozen failures: interval windows (B4, A3)", () => {
	test("an interval starting on a session's date includes it, at --window parity", async () => {
		const agentDir = fixtureAgentDir();

		const byInterval = await buildDebugReport({ agentDir, now: NOW, interval: "2026-11-10" });
		// Point interval = from 2026-11-10 until now: the start-date session (a) and
		// today's session (b) both belong to it — the start date must not be dropped.
		expect(byInterval.counts.sessions).toBe(2);
		expect(byInterval.counts.turns).toBe(3);

		const byWindow = await buildDebugReport({ agentDir, now: NOW, windowDays: 2 });
		expect(byWindow.window).toEqual({ start: "2026-11-10", end: "2026-11-11", days: 2 });
		expect(byWindow.counts.sessions).toBe(2);
	});

	test("same-day relative spans keep today's sessions", async () => {
		const agentDir = fixtureAgentDir();
		const report = await buildDebugReport({ agentDir, now: NOW, interval: "2h" });
		expect(report.counts.sessions).toBe(1);
		expect(report.counts.turns).toBe(1);
	});

	test("relative spans report their real day count", () => {
		expect(parseFlexibleTime("3d", NOW)).toMatchObject({ days: 3 });
		expect(parseFlexibleTime("5min", NOW)).toMatchObject({ days: 1 });
		expect(parseFlexibleTime("1mes", NOW)).toMatchObject({ days: 30 });
	});
});

// ── EV-2026-11-18 B2: error_summary in metadata.json ──

describe("issue #44 — frozen failures: error_summary metadata (B2)", () => {
	test("metadata.json carries error_summary with total and byClass", async () => {
		const agentDir = fixtureAgentDir();
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 7 });
		const metadata = report.metadata as Record<string, unknown>;

		expect(metadata.error_summary).toEqual({
			total: 1,
			byClass: { overflow: 0, rate_limited: 0, invalid_request: 0, transport: 1, other: 0 },
		});
		const rendered = renderDebugReport(report);
		expect(rendered.files["metadata.json"]).toContain('"error_summary"');
	});

	test("error_summary total equals the errors.jsonl row count (zero-error report carries zeros)", async () => {
		const agentDir = fixtureAgentDir();
		const report = await buildDebugReport({ agentDir, now: NOW, interval: "2026-11-11" });
		const metadata = report.metadata as Record<string, any>;
		expect(metadata.error_summary?.total).toBe(0);
		expect(metadata.error_summary?.byClass).toEqual({
			overflow: 0,
			rate_limited: 0,
			invalid_request: 0,
			transport: 0,
			other: 0,
		});
	});
});

// ── PR #44 §1 claim pins: errors.jsonl shape, 200-char cap, preview format ──

describe("issue #44 — errors.jsonl and preview claims", () => {
	test("a transport error drops its message; a gateway body is capped at 200 chars", async () => {
		const agentDir = fixtureAgentDir();
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 7 });
		const rendered = renderDebugReport(report);
		const row = JSON.parse(rendered.files["errors.jsonl"]!.trim().split("\n")[0]!);

		// Issue #49 S23/S26: transport texts and local exception paths are never stored.
		expect(LONG_ERROR.length).toBeGreaterThan(200);
		expect(row.message_truncated).toBeNull();
		expect(row.message_hash).toBeNull();
		expect(row.error).toBe("transport");
		expect(row.model).toBe("qwen3.6");
		expect(rendered.files["errors.jsonl"]).not.toContain(LONG_ERROR);

		// A gateway error body keeps its own message, capped at 200 chars.
		const gatewayDir = scratch();
		const dir = join(gatewayDir, "sessions", "--x--");
		mkdirSync(dir, { recursive: true });
		const gateway = JSON.stringify({
			error: { message: "g".repeat(300), type: "invalid_request_error", code: "bad", param: "messages" },
		});
		writeFileSync(
			join(dir, "2026-11-10T10-00-00-000Z_g.jsonl"),
			[
				JSON.stringify({ type: "session", cwd: CWD_SECRET }),
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						provider: "nan",
						model: "qwen3.6",
						stopReason: "error",
						errorMessage: gateway,
						usage: { input: 1, output: 0, totalTokens: 1 },
					},
				}),
				"",
			].join("\n"),
		);
		const gatewayReport = await buildDebugReport({ agentDir: gatewayDir, now: NOW, windowDays: 7 });
		const gatewayRow = gatewayReport.errors[0]!;
		expect(gatewayRow.message_truncated).toHaveLength(200);
		expect(gatewayRow.message_hash).toBe(md5Short(gateway));
		expect(gatewayRow.error_type).toBe("invalid_request_error");
		expect(gatewayRow.error_code).toBe("bad");
		expect(gatewayRow.error_param).toBe("messages");
	});

	test("preview renders the documented errors line", async () => {
		const agentDir = fixtureAgentDir();
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 7 });
		const rendered = renderDebugReport(report);
		expect(rendered.preview).toContain("errors: 1 total (transport: 1)");
	});
});

// ── EV-2026-11-18 B5: sessions/ redaction scope ──

describe("issue #44 — frozen failures: sessions/ redaction scope (B5)", () => {
	test("raw cwd never reaches any rendered file; transcript text stays under sessions/ only", async () => {
		const agentDir = fixtureAgentDir();
		const sessionsDir = join(agentDir, "sessions");
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 7, sessionsDir });
		// Issue #49: transcripts are opt-in; `sessions/` only exists with the flag.
		const rendered = renderDebugReport(report, sessionsDir, { includePrompts: true });

		const names = Object.keys(rendered.files);
		expect(names.some((name) => name.startsWith("sessions/"))).toBe(true);

		const all = Object.values(rendered.files).join("\n");
		expect(all).not.toContain(CWD_SECRET);
		expect(all).toContain(`"cwd":"${md5Short(CWD_SECRET)}"`);

		const rootFiles = Object.entries(rendered.files)
			.filter(([name]) => !name.startsWith("sessions/"))
			.map(([, content]) => content)
			.join("\n");
		expect(rootFiles).not.toContain(CONTENT_LITERAL);

		const sessionsOnly = Object.entries(rendered.files)
			.filter(([name]) => name.startsWith("sessions/"))
			.map(([, content]) => content)
			.join("\n");
		expect(sessionsOnly).toContain(CONTENT_LITERAL);
	});

	test("the rendered README states the sessions/ exception instead of an absolute claim", async () => {
		const agentDir = fixtureAgentDir();
		const sessionsDir = join(agentDir, "sessions");
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 7, sessionsDir });
		const rendered = renderDebugReport(report, sessionsDir);
		const readme = rendered.files["README.md"]!;

		// The default artifact promises no content and documents the opt-in instead
		// of an absolute "never collected" claim (issue #49 S21/S24).
		expect(readme).toContain("--include-prompts");
		expect(readme).toContain("## Not public");
		expect(readme).not.toMatch(/^- Prompt or response content\.$/m);
	});
});

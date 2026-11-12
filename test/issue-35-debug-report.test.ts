/**
 * ACCEPTANCE TESTS — issue #35, part B
 * The deterministic `/nan-debug` collector: redacted report shapes, window
 * filtering, error classification, version/provenance metadata, the captured
 * cf-ray anomalies, and byte-identical zip output.
 *
 * https://github.com/gtrabanco/pi-nan-provider/issues/35
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
	DEFAULT_DEBUG_WINDOW_DAYS,
	buildDebugReport,
	classifyErrorMessage,
	renderDebugReport,
	writeDebugReport,
	writeDebugZip,
} from "../src/debug-report.ts";
import { CACHE_ANOMALY_FILE, CACHE_ANOMALY_KIND, type CacheAnomalyRecord } from "../src/cache-anomaly.ts";

const NOW = new Date("2026-11-11T12:00:00.000Z");
let scratchDirs: string[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "nan-debug-report-"));
	scratchDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
	scratchDirs = [];
});

function md5Short(value: string): string {
	return createHash("md5").update(value).digest("hex").slice(0, 12);
}

interface Turn {
	model?: string;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoning?: number;
	total?: number;
	stopReason?: string;
	responseId?: string | null;
	errorMessage?: string;
	timestamp?: string;
	durationMs?: number;
}

function assistantLine(turn: Turn): string {
	const message: Record<string, unknown> = {
		role: "assistant",
		provider: "nan",
		api: "openai-completions",
		model: turn.model ?? "qwen3.8-flash",
		usage: {
			input: turn.input ?? 100,
			output: turn.output ?? 10,
			cacheRead: turn.cacheRead ?? 0,
			cacheWrite: turn.cacheWrite ?? 0,
			reasoning: turn.reasoning ?? 0,
			totalTokens: turn.total ?? 110,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: turn.stopReason ?? "stop",
		timestamp: Date.parse(turn.timestamp ?? "2026-11-10T10:00:00.000Z"),
		durationMs: turn.durationMs ?? 1000,
		// Content is present in real transcripts and must never be collected.
		content: [{ type: "text", text: "PROMPT-OR-ANSWER-LITERAL" }],
	};
	if (turn.responseId !== null) message.responseId = turn.responseId ?? "chatcmpl-1";
	if (turn.errorMessage) message.errorMessage = turn.errorMessage;
	return JSON.stringify({ type: "message", timestamp: turn.timestamp ?? "2026-11-10T10:00:00.000Z", message });
}

function writeSession(agentDir: string, dirName: string, fileName: string, cwd: string, turns: Turn[]): string {
	const dir = join(agentDir, "sessions", dirName);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, fileName);
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: fileName, cwd, timestamp: "2026-11-10T09:59:00.000Z" }),
		JSON.stringify({ type: "message", message: { role: "user", content: "PROMPT-LITERAL" } }),
		...turns.map(assistantLine),
	];
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

function anomalyRecord(detectedAt: string, cfRays: [string, string]): CacheAnomalyRecord {
	return {
		detected_at: detectedAt,
		kind: CACHE_ANOMALY_KIND,
		model: "qwen3.8-flash",
		id: "chatcmpl-cached",
		created: 1762778096,
		payload_match: true,
		requests: [
			{ cf_ray: cfRays[0], observed_at: detectedAt, payload_sha256: "a" },
			{ cf_ray: cfRays[1], observed_at: detectedAt, payload_sha256: "a" },
		],
	};
}

function fixtureAgentDir(): { agentDir: string; sessionA: string; sessionB: string } {
	const agentDir = scratch();
	const sessionA = writeSession(agentDir, "--home-agent-project--", "2026-11-10T10-00-00-000Z_a.jsonl", "/home/agent/project", [
		{ model: "qwen3.8-flash", input: 100, output: 10, cacheRead: 50, total: 160, responseId: "chatcmpl-1" },
		{
			model: "qwen3.8-flash",
			input: 200,
			output: 0,
			cacheRead: 0,
			total: 200,
			stopReason: "error",
			responseId: "chatcmpl-2",
			errorMessage:
				"NaN timed out the stream before any answer content (reasoning-only stream guard: the 420 s / 45,000-reasoning-character limit).",
		},
	]);
	const sessionB = writeSession(agentDir, "--home-agent-project--", "2026-11-11T11-00-00-000Z_b.jsonl", "/home/agent/project", [
		{ model: "glm5.3-flash", input: 300, output: 30, cacheRead: 0, total: 330, responseId: null },
		{
			model: "glm5.3-flash",
			input: 400,
			output: 0,
			total: 400,
			stopReason: "error",
			responseId: "chatcmpl-4",
			errorMessage: "Invalid request. Check your request parameters.",
		},
	]);
	// Out-of-window session: must not contribute a row.
	writeSession(agentDir, "--home-agent-project--", "2026-10-01T10-00-00-000Z_old.jsonl", "/home/agent/project", [
		{ model: "qwen3.6" },
	]);
	writeFileSync(
		join(agentDir, CACHE_ANOMALY_FILE),
		`${JSON.stringify(anomalyRecord("2026-11-10T10:05:00.000Z", ["ray-a", "ray-b"]))}\n` +
			`${JSON.stringify(anomalyRecord("2026-09-01T10:05:00.000Z", ["ray-old-1", "ray-old-2"]))}\n`,
	);
	return { agentDir, sessionA, sessionB };
}

describe("issue #35 — error classification", () => {
	test("maps raw errors to fixed classes and never returns the raw text", () => {
		expect(classifyErrorMessage("Invalid request. Check your request parameters.")).toBe("invalid_request");
		expect(classifyErrorMessage("429 rate limit exceeded, retry later")).toBe("rate_limited");
		expect(classifyErrorMessage("context overflow: prompt too long for the model window")).toBe("overflow");
		expect(classifyErrorMessage("fetch failed: ECONNRESET")).toBe("transport");
		expect(classifyErrorMessage("something odd happened")).toBe("other");
		expect(classifyErrorMessage(undefined)).toBeNull();
	});
});

describe("issue #35 — report rows and metadata", () => {
	test("collects per-turn usage into redacted session/model rows inside the window", async () => {
		const { agentDir, sessionA, sessionB } = fixtureAgentDir();
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 2 });

		expect(report.window).toEqual({ start: "2026-11-10", end: "2026-11-11", days: 2 });
		expect(report.rows).toHaveLength(2);
		expect(report.counts.sessions).toBe(2);
		expect(report.counts.turns).toBe(4);

		const a = report.rows.find((r) => r.session_id === md5Short(sessionA))!;
		expect(a.worktree_label).toBe(md5Short("/home/agent/project"));
		expect(a.model).toBe("qwen3.8-flash");
		expect(a.turns).toBe(2);
		expect(a.input_tokens).toBe(300);
		expect(a.output_tokens).toBe(10);
		expect(a.cache_read_tokens).toBe(50);
		expect(a.total_tokens).toBe(360);
		expect(a.avg_tokens_per_turn).toBe(180);
		expect(a.stop_reason_counts).toEqual({ stop: 1, error: 1 });
		expect(a.anomalies).toHaveLength(1);
		expect(a.anomalies[0]!.kind).toBe(CACHE_ANOMALY_KIND);

		const b = report.rows.find((r) => r.session_id === md5Short(sessionB))!;
		expect(b.model).toBe("glm5.3-flash");
		expect(b.stop_reason_counts).toEqual({ stop: 1, error: 1 });

		// Per-turn detail: response id collected, created null (not in transcript),
		// errors classified, no content.
		expect(report.turns).toHaveLength(4);
		const first = report.turns.find((t) => t.response_id === "chatcmpl-1")!;
		expect(first.created).toBeNull();
		expect(first.error).toBeNull();
		const reasoningOnly = report.turns.find((t) => t.response_id === "chatcmpl-2")!;
		expect(reasoningOnly.error).toBe("transport");
		expect(report.counts.anomalies.reasoningOnlyStream).toBe(1);
		expect(report.counts.anomalies.contextOverflow).toBe(0);
		expect(report.counts.anomalies.duplicateIdCreated).toBe(1);
	});

	test("metadata carries package, pi-ai, pi versions and catalog provenance", async () => {
		const { agentDir } = fixtureAgentDir();
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 2, topic: "cache" });
		const metadata = report.metadata as Record<string, any>;

		expect(metadata.topic).toBe("cache");
		expect(metadata.generated_at).toBe(NOW.toISOString());
		expect(metadata.versions.provider).toMatch(/^\d+\.\d+\.\d+/);
		expect(metadata.versions.pi_ai).toMatch(/^\d+\.\d+\.\d+/);
		expect(metadata.versions.pi).toMatch(/^\d+\.\d+\.\d+/);
		expect(metadata.catalog.source).toBe("https://models.dev/api.json");
		expect(metadata.catalog.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	test("anomalies are filtered to the window and keep the cf-ray pair", async () => {
		const { agentDir } = fixtureAgentDir();
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 2 });
		expect(report.anomalies).toHaveLength(1);
		expect(report.anomalies[0]!.requests.map((r) => r.cf_ray)).toEqual(["ray-a", "ray-b"]);
	});

	test("the rendered preview has the documented shape and the emit hint", async () => {
		const { agentDir } = fixtureAgentDir();
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 2 });
		const rendered = renderDebugReport(report);
		expect(rendered.preview).toContain("nan-debug report — 2026-11-10 → 2026-11-11 (window: 2d)");
		expect(rendered.preview).toContain("sessions: 2 · turns: 4 · models: 2");
		expect(rendered.preview).toContain("anomalies: 1 duplicate id/created pairs · 1 reasoning-only stream · 0 context overflow");
		expect(rendered.preview).toContain("prompt/response bytes collected");
		expect(rendered.preview).toContain("Run with --emit to write nan-debug-report.zip");
	});

	test("no prompt/response content or raw paths in any rendered file", async () => {
		const { agentDir } = fixtureAgentDir();
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 2 });
		const rendered = renderDebugReport(report);
		const all = Object.values(rendered.files).join("\n");
		expect(all).not.toContain("PROMPT-OR-ANSWER-LITERAL");
		expect(all).not.toContain("PROMPT-LITERAL");
		expect(all).not.toContain("/home/agent/project");
		expect(all).not.toContain(agentDir);
	});

	test("default window is 7 days and the rendered report files follow the declared layout", async () => {
		const { agentDir } = fixtureAgentDir();
		expect(DEFAULT_DEBUG_WINDOW_DAYS).toBe(7);
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: DEFAULT_DEBUG_WINDOW_DAYS });
		const rendered = renderDebugReport(report);
		expect(Object.keys(rendered.files).sort()).toEqual(
			["README.md", "anomalies.jsonl", "anonymized_usage.jsonl", "metadata.json", "turns.jsonl"].sort(),
		);
		expect(() => JSON.parse(rendered.files["metadata.json"]!)).not.toThrow();
		expect(() => JSON.parse(rendered.files["anonymized_usage.jsonl"]!.trim().split("\n")[0]!)).not.toThrow();
	});
});

describe("issue #35 — deterministic zip", () => {
	test("writes the report files and produces byte-identical zips for identical input", async () => {
		const { agentDir } = fixtureAgentDir();
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 2 });
		const rendered = renderDebugReport(report);

		const outDir = scratch();
		writeDebugReport(rendered.files, outDir);
		expect(existsSync(join(outDir, "README.md"))).toBe(true);
		expect(existsSync(join(outDir, "anomalies.jsonl"))).toBe(true);

		const zipA = join(scratch(), "a.zip");
		const zipB = join(scratch(), "b.zip");
		writeDebugZip(rendered.files, zipA);
		writeDebugZip(rendered.files, zipB);
		const a = readFileSync(zipA);
		const b = readFileSync(zipB);
		expect(a.equals(b)).toBe(true);
		// Store-method zip: local header magic + every entry name present.
		expect(a[0]).toBe(0x50);
		expect(a[1]).toBe(0x4b);
		const text = a.toString("latin1");
		for (const name of Object.keys(rendered.files)) expect(text).toContain(name);
	});
});

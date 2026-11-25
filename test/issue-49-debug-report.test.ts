/**
 * ACCEPTANCE TESTS — issue #49, part B
 * The report side of the HTTP attempt tap: `turns.jsonl` gains the gateway
 * `created`, status, attempt count and request parameters; `errors.jsonl`
 * gains status/cf_ray/attempt_n plus the parsed OpenAI-style error body;
 * `metadata.attempt_summary` carries the 429 ratios and streaks; the default
 * artifact carries no prompt/response/tool content; `topic` and path labels
 * are hashed; the emission timestamp names the artifact.
 *
 * Frozen-failure corpus for docs/fix/issue-49-nan-debug-http-attempts/SPEC.md
 * (O9–O15, O21).
 *
 * https://github.com/gtrabanco/pi-nan-provider/issues/49
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
	buildDebugReport,
	debugReportDirName,
	debugReportZipName,
	renderDebugReport,
	writeDebugZip,
} from "../src/debug-report.ts";
import { HTTP_ATTEMPTS_FILE, type HttpAttemptRecord, type HttpResponseRecord } from "../src/http-attempts.ts";

const NOW = new Date("2026-11-24T12:00:00.000Z");
// The home-scrub contract keys on the running user's home directory, so the
// fixture must derive its embedded path from it — a literal like
// /home/agent only scrubs on machines whose home actually is /home/agent.
const HOME_DIR = homedir();
const HOME_EMBEDDED_PATH = join(HOME_DIR, "projects", "x");
const CWD_SECRET = "/home/agent/projects/client-acme";
const PROMPT_LITERAL = "PROMPT-SECRET-LITERAL";
const TOOL_ARG_SECRET = "TOOL-ARG-SECRET";
const TOOL_OUTPUT_SECRET = "TOOL-OUTPUT-SECRET";

let scratchDirs: string[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "nan-49-report-"));
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

const RATE_LIMIT_BODY = JSON.stringify({
	error: {
		message: "Rate limit reached. Please retry shortly.",
		type: "rate_limit_error",
		code: "rate_limit_exceeded",
		param: null,
	},
});

function attempt(overrides: Partial<HttpAttemptRecord>): HttpAttemptRecord {
	return {
		kind: "attempt",
		request_id: "req-1",
		attempt_n: 1,
		model: "qwen3.6",
		started_at: "2026-11-24T09:59:58.000Z",
		ended_at: "2026-11-24T09:59:58.200Z",
		latency_ms: 200,
		status: 200,
		headers: {},
		payload_bytes: 100,
		request: { reasoning_effort: "low", max_tokens: 512, max_tokens_field: "max_tokens", stream: true },
		inflight_process_at_start: 0,
		inflight_same_model_at_start: 0,
		starts_last_60s_process: 1,
		starts_last_60s_same_model: 1,
		error_type: null,
		...overrides,
	};
}

function response(overrides: Partial<HttpResponseRecord>): HttpResponseRecord {
	return {
		kind: "response",
		request_id: "req-1",
		model: "qwen3.6",
		response_id: "chatcmpl-1",
		created: 1763990000,
		status: 200,
		attempts: 2,
		ended_at: "2026-11-24T09:59:59.900Z",
		request: { reasoning_effort: "low", max_tokens: 512, max_tokens_field: "max_tokens", stream: true },
		...overrides,
	};
}

function fixtureAgentDir(): string {
	const agentDir = scratch();
	const dir = join(agentDir, "sessions", "--home-agent-projects-client-acme--");
	mkdirSync(dir, { recursive: true });

	const turn = (message: Record<string, unknown>, timestamp: string) =>
		JSON.stringify({ type: "message", timestamp, message });

	writeFileSync(
		join(dir, "2026-11-24T09-59-00-000Z_a.jsonl"),
		[
			JSON.stringify({ type: "session", version: 3, id: "a", cwd: CWD_SECRET, timestamp: "2026-11-24T09:59:00.000Z" }),
			JSON.stringify({ type: "message", message: { role: "user", content: PROMPT_LITERAL } }),
			turn(
				{
					role: "assistant",
					provider: "nan",
					api: "openai-completions",
					model: "qwen3.6",
					responseId: "chatcmpl-1",
					usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 110 },
					stopReason: "stop",
					timestamp: Date.parse("2026-11-24T10:00:00.000Z"),
					durationMs: 2000,
					content: [
						{ type: "text", text: "final answer" },
						{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: TOOL_ARG_SECRET } },
					],
				},
				"2026-11-24T10:00:00.000Z",
			),
			turn(
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: TOOL_OUTPUT_SECRET }],
					isError: false,
					timestamp: Date.parse("2026-11-24T10:00:01.000Z"),
				},
				"2026-11-24T10:00:01.000Z",
			),
			turn(
				{
					role: "assistant",
					provider: "nan",
					api: "openai-completions",
					model: "glm5.3-flash",
					usage: { input: 400, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 400 },
					stopReason: "error",
					errorMessage: RATE_LIMIT_BODY,
					timestamp: Date.parse("2026-11-24T10:05:00.000Z"),
					durationMs: 8000,
				},
				"2026-11-24T10:05:00.000Z",
			),
			turn(
				{
					role: "assistant",
					provider: "nan",
					api: "openai-completions",
					model: "gemma4",
					usage: { input: 400, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 400 },
					stopReason: "error",
					errorMessage: `stream failed at ${"/home/agent/secret-transport"}/src/index.ts`,
					timestamp: Date.parse("2026-11-24T10:06:00.000Z"),
					durationMs: 1000,
				},
				"2026-11-24T10:06:00.000Z",
			),
			"",
		].join("\n"),
	);

	const requestParams = { reasoning_effort: "low" as const, max_tokens: 512, max_tokens_field: "max_tokens" as const, stream: true };
	const rateParams = { reasoning_effort: "none" as const, max_tokens: 1024, max_tokens_field: "max_tokens" as const, stream: true };
	writeFileSync(
		join(agentDir, HTTP_ATTEMPTS_FILE),
		[
			JSON.stringify(attempt({
				attempt_n: 1,
				status: 429,
				headers: { "cf-ray": "ray-429-first", "retry-after": "2" },
				request: requestParams,
				started_at: "2026-11-24T09:59:56.000Z",
				ended_at: "2026-11-24T09:59:56.200Z",
			})),
			JSON.stringify(attempt({
				attempt_n: 2,
				status: 200,
				headers: { "cf-ray": "ray-200" },
				request: requestParams,
				started_at: "2026-11-24T09:59:58.000Z",
				ended_at: "2026-11-24T09:59:59.900Z",
			})),
			JSON.stringify(response({ request: requestParams })),
			// A failed logical request: three rejected attempts, no response row.
			JSON.stringify(attempt({
				request_id: "req-2",
				attempt_n: 1,
				model: "glm5.3-flash",
				status: 429,
				headers: { "cf-ray": "ray-429-final-1" },
				request: rateParams,
				started_at: "2026-11-24T10:04:57.000Z",
				ended_at: "2026-11-24T10:04:57.500Z",
			})),
			JSON.stringify(attempt({
				request_id: "req-2",
				attempt_n: 2,
				model: "glm5.3-flash",
				status: 429,
				headers: { "cf-ray": "ray-429-final-2" },
				request: rateParams,
				started_at: "2026-11-24T10:04:58.500Z",
				ended_at: "2026-11-24T10:04:58.900Z",
			})),
			JSON.stringify(attempt({
				request_id: "req-2",
				attempt_n: 3,
				model: "glm5.3-flash",
				status: 429,
				headers: { "cf-ray": "ray-429-final" },
				request: rateParams,
				started_at: "2026-11-24T10:04:59.500Z",
				ended_at: "2026-11-24T10:04:59.900Z",
			})),
			"",
		].join("\n"),
	);
	return agentDir;
}

describe("issue #49 — turns join (O9, O7)", () => {
	test("a successful turn carries created, status, attempt_n and the request parameters", async () => {
		const agentDir = fixtureAgentDir();
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 1 });
		const turn = report.turns.find((row) => row.response_id === "chatcmpl-1")!;

		expect(turn.created).toBe(1763990000);
		expect(turn.status).toBe(200);
		expect(turn.attempt_n).toBe(2);
		expect(turn.request).toEqual({
			reasoning_effort: "low",
			max_tokens: 512,
			max_tokens_field: "max_tokens",
			stream: true,
		});

		const rendered = renderDebugReport(report);
		const row = JSON.parse(rendered.files["turns.jsonl"]!.split("\n")[0]!);
		expect(row.created).toBe(1763990000);
		expect(row.status).toBe(200);
		expect(row.attempt_n).toBe(2);
	});

	test("a turn with no attempt evidence keeps null instead of guessing", async () => {
		const agentDir = fixtureAgentDir();
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 1 });
		const transportTurn = report.turns.find((row) => row.model === "gemma4")!;
		expect(transportTurn.created).toBeNull();
		expect(transportTurn.status).toBeNull();
		expect(transportTurn.attempt_n).toBeNull();
		expect(transportTurn.request).toBeNull();
	});
});

describe("issue #49 — errors join (O10, O20)", () => {
	test("a gateway error carries status, cf_ray, attempt_n and the parsed OpenAI-style body", async () => {
		const agentDir = fixtureAgentDir();
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 1 });
		const row = report.errors.find((entry) => entry.model === "glm5.3-flash")!;

		expect(row.status).toBe(429);
		expect(row.cf_ray).toBe("ray-429-final");
		expect(row.attempt_n).toBe(3);
		expect(row.error_type).toBe("rate_limit_error");
		expect(row.error_code).toBe("rate_limit_exceeded");
		expect(row.error_param).toBeNull();
		expect(row.message_truncated).toBe("Rate limit reached. Please retry shortly.");
		expect(row.message_hash).toBe(md5Short(RATE_LIMIT_BODY));

		const rendered = renderDebugReport(report);
		const serialized = JSON.parse(rendered.files["errors.jsonl"]!.split("\n").find((line) => line.includes("glm5.3-flash"))!);
		expect(serialized.status).toBe(429);
		expect(serialized.cf_ray).toBe("ray-429-final");
		expect(serialized.attempt_n).toBe(3);
		expect(serialized.error_type).toBe("rate_limit_error");
		expect(serialized.error_code).toBe("rate_limit_exceeded");
		expect(serialized.error_param).toBeNull();
	});

	test("a transport error stores no message, hash, path or exception text", async () => {
		const agentDir = fixtureAgentDir();
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 1 });
		const row = report.errors.find((entry) => entry.model === "gemma4")!;
		expect(row.message_truncated).toBeNull();
		expect(row.message_hash).toBeNull();
		expect(row.status).toBeNull();
		expect(row.attempt_n).toBeNull();
		expect(row.cf_ray).toBeNull();

		const rendered = renderDebugReport(report);
		expect(rendered.files["errors.jsonl"]).not.toContain(CWD_SECRET);
		expect(rendered.files["errors.jsonl"]).not.toContain("stream failed at");
	});

	test("a server message that embeds the home directory is scrubbed to ~", async () => {
		const agentDir = scratch();
		const dir = join(agentDir, "sessions", "--x--");
		mkdirSync(dir, { recursive: true });
		const body = JSON.stringify({
			error: { message: `bad request in ${HOME_EMBEDDED_PATH}`, type: "invalid_request_error", code: "bad", param: "messages" },
		});
		writeFileSync(
			join(dir, "2026-11-24T10-00-00-000Z_a.jsonl"),
			[
				JSON.stringify({ type: "session", cwd: CWD_SECRET }),
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						provider: "nan",
						model: "qwen3.6",
						stopReason: "error",
						errorMessage: body,
						usage: { input: 1, output: 0, totalTokens: 1 },
					},
				}),
				"",
			].join("\n"),
		);
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 1 });
		const rendered = renderDebugReport(report);
		expect(rendered.files["errors.jsonl"]).toContain("~/projects/x");
		expect(rendered.files["errors.jsonl"]).not.toContain(HOME_DIR);
	});
});

describe("issue #49 — attempt summary (O11)", () => {
	test("metadata carries status counts, per-model/hour 429 ratios and the longest streak", async () => {
		const agentDir = fixtureAgentDir();
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 1 });
		const summary = (report.metadata as Record<string, any>).attempt_summary;

		expect(summary.total).toBe(5);
		expect(summary.by_status).toEqual({ "200": 1, "429": 4 });
		const glm = summary.by_model.find((row: { model: string }) => row.model === "glm5.3-flash");
		expect(glm).toMatchObject({ attempts: 3, rate_limited: 3, rate_limited_pct: 100 });
		const qwen = summary.by_model.find((row: { model: string }) => row.model === "qwen3.6");
		expect(qwen).toMatchObject({ attempts: 2, rate_limited: 1, rate_limited_pct: 50 });
		expect(summary.by_model_hour.length).toBeGreaterThanOrEqual(2);
		expect(summary.longest_429_streak).toMatchObject({
			model: "glm5.3-flash",
			length: 3,
			started_at: "2026-11-24T10:04:57.000Z",
			ended_at: "2026-11-24T10:04:59.900Z",
		});
	});
});

describe("issue #49 — default artifact has no content (O13, O14, O15)", () => {
	test("the default file set has no sessions/, no prompt, no tool call and no tool output", async () => {
		const agentDir = fixtureAgentDir();
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 1, topic: "client-acme-migration" });
		const rendered = renderDebugReport(report, join(agentDir, "sessions"));

		expect(Object.keys(rendered.files).sort()).toEqual([
			"README.md",
			"anomalies.jsonl",
			"anonymized_usage.jsonl",
			"errors.jsonl",
			"http_attempts.jsonl",
			"metadata.json",
			"turns.jsonl",
		]);
		const all = Object.values(rendered.files).join("\n");
		expect(all).not.toContain(PROMPT_LITERAL);
		expect(all).not.toContain(TOOL_ARG_SECRET);
		expect(all).not.toContain(TOOL_OUTPUT_SECRET);
		expect(all).not.toContain(CWD_SECRET);
		expect(all).not.toContain(agentDir);
	});

	test("topic never appears in clear; a 16-char hash is carried", async () => {
		const agentDir = fixtureAgentDir();
		const topic = "client-acme-migration";
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 1, topic });
		const rendered = renderDebugReport(report, join(agentDir, "sessions"));
		const all = Object.values(rendered.files).join("\n");
		expect(all).not.toContain(topic);
		expect((report.metadata as Record<string, unknown>).topic_hash).toBe(md5Short(topic));
	});

	test("session and worktree labels are 16-char MD5 truncations", async () => {
		const agentDir = fixtureAgentDir();
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 1 });
		expect(report.rows).toHaveLength(3);
		for (const row of report.rows) {
			expect(row.session_id).toHaveLength(16);
			expect(row.worktree_label).toBe(md5Short(CWD_SECRET));
		}
	});
});

describe("issue #49 — opt-in content flags (O13)", () => {
	test("--include-prompts embeds the transcript with tool calls and tool results stripped", async () => {
		const agentDir = fixtureAgentDir();
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 1 });
		const rendered = renderDebugReport(report, join(agentDir, "sessions"), { includePrompts: true });

		const sessionFiles = Object.entries(rendered.files).filter(([name]) => name.startsWith("sessions/"));
		expect(sessionFiles).toHaveLength(1);
		const transcript = sessionFiles[0]![1];
		expect(transcript).toContain(PROMPT_LITERAL);
		expect(transcript).toContain("final answer");
		expect(transcript).not.toContain(TOOL_ARG_SECRET);
		expect(transcript).not.toContain(TOOL_OUTPUT_SECRET);
		expect(transcript).not.toContain("toolCall");
		expect(transcript).not.toContain("toolResult");
		// The path header stays hashed even when the transcript is embedded.
		expect(transcript).toContain(`"cwd":"${md5Short(CWD_SECRET)}"`);
		expect(transcript).not.toContain(`"cwd":"${CWD_SECRET}"`);
	});

	test("--include-tools implies prompts and keeps tool calls/results", async () => {
		const agentDir = fixtureAgentDir();
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 1 });
		const rendered = renderDebugReport(report, join(agentDir, "sessions"), { includeTools: true });
		const transcript = Object.entries(rendered.files).find(([name]) => name.startsWith("sessions/"))![1];
		expect(transcript).toContain(PROMPT_LITERAL);
		expect(transcript).toContain(TOOL_ARG_SECRET);
		expect(transcript).toContain(TOOL_OUTPUT_SECRET);
	});

	test("the artifact README scopes the never-collected claims around the opt-in transcripts", async () => {
		const agentDir = fixtureAgentDir();
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 1 });
		const rendered = renderDebugReport(report, join(agentDir, "sessions"), { includePrompts: true });
		const transcript = Object.entries(rendered.files).find(([name]) => name.startsWith("sessions/"))![1];
		const readme = rendered.files["README.md"]!;

		// Transcripts are raw by request (S17): pi-side exception text with an
		// absolute path survives in them (only `cwd` is hashed), so the README's
		// never-collected claim must carry the transcripts qualifier — the
		// EXTERNAL VERIFY 2026-11-24 blocker.
		expect(transcript).toContain("/home/agent/secret-transport");
		expect(readme).toContain("outside the opt-in `sessions/` transcripts");
		expect(readme).toContain("their `cwd` header is still MD5-hashed");
	});

	test("http_attempts.jsonl carries only window-filtered rows", async () => {
		const agentDir = fixtureAgentDir();
		writeFileSync(
			join(agentDir, HTTP_ATTEMPTS_FILE),
			`${readFileSync(join(agentDir, HTTP_ATTEMPTS_FILE), "utf8")}${JSON.stringify(
				attempt({ started_at: "2026-10-01T10:00:00.000Z", ended_at: "2026-10-01T10:00:00.100Z", status: 500 }),
			)}\n`,
		);
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 1 });
		const rendered = renderDebugReport(report);
		const rows = rendered.files["http_attempts.jsonl"]!.trim().split("\n").map((line) => JSON.parse(line));
		expect(rows).toHaveLength(6);
		expect(rendered.files["http_attempts.jsonl"]).not.toContain("2026-10-01");
	});
});

describe("issue #49 — artifact naming and zip (O16, O21)", () => {
	test("the default names carry the emission timestamp in UTC", () => {
		const emitted = new Date("2026-11-19T13:45:02.000Z");
		expect(debugReportDirName(emitted, "linux")).toBe("nan-debug-report-2026-11-19T13:45:02");
		expect(debugReportDirName(emitted, "win32")).toBe("nan-debug-report-2026-11-19T13-45-02");
		expect(debugReportZipName(emitted)).toBe("nan-debug-report-2026-11-19T13-45-02.zip");
	});

	test("identical input produces byte-identical zips", async () => {
		const agentDir = fixtureAgentDir();
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 1 });
		const rendered = renderDebugReport(report);

		const zipA = join(scratch(), "a.zip");
		const zipB = join(scratch(), "b.zip");
		writeDebugZip(rendered.files, zipA);
		writeDebugZip(rendered.files, zipB);
		const a = readFileSync(zipA);
		expect(a.equals(readFileSync(zipB))).toBe(true);
		expect(a[0]).toBe(0x50);
		expect(a[1]).toBe(0x4b);
		const text = a.toString("latin1");
		for (const name of Object.keys(rendered.files)) expect(text).toContain(name);
	});

	test("usage_window.json stays out of the zip unless --all asks for it", () => {
		const files = { "a.txt": "A", "usage_window.json": "U" };
		const zipDefault = join(scratch(), "default.zip");
		writeDebugZip(files, zipDefault);
		expect(readFileSync(zipDefault).toString("latin1")).toContain("a.txt");
		expect(readFileSync(zipDefault).toString("latin1")).not.toContain("usage_window.json");

		const zipAll = join(scratch(), "all.zip");
		writeDebugZip(files, zipAll, { includeUsageWindow: true });
		expect(readFileSync(zipAll).toString("latin1")).toContain("usage_window.json");
	});
});

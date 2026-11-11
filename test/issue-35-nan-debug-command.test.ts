/**
 * ACCEPTANCE TESTS — issue #35, part C
 * `/nan-debug [topic] [--window N] [--out file] [--emit]`: argument parsing,
 * local redacted report writing, preview-before-share, zip only on --emit, and
 * the optional (permission-gated) usage window.
 *
 * https://github.com/gtrabanco/pi-nan-provider/issues/35
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	DEFAULT_DEBUG_WINDOW_DAYS,
	parseDebugArgs,
	type DebugWindow,
} from "../src/debug-report.ts";
import { registerNanDebugCommand } from "../src/debug-command.ts";

const NOW = new Date("2026-11-11T12:00:00.000Z");
let scratchDirs: string[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "nan-debug-cmd-"));
	scratchDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
	scratchDirs = [];
});

function fixtureAgentDir(): string {
	const agentDir = scratch();
	const dir = join(agentDir, "sessions", "--home-agent-project--");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "2026-11-10T10-00-00-000Z_a.jsonl"),
		`${JSON.stringify({ type: "session", id: "s1", cwd: "/home/agent/project", timestamp: "2026-11-10T09:00:00.000Z" })}\n` +
			`${JSON.stringify({
				type: "message",
				timestamp: "2026-11-10T10:00:00.000Z",
				message: {
					role: "assistant",
					provider: "nan",
					api: "openai-completions",
					model: "qwen3.8-flash",
					responseId: "chatcmpl-1",
					usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 12 },
					stopReason: "stop",
					timestamp: 1,
				},
			})}\n`,
	);
	return agentDir;
}

function fakePi() {
	const commands: Array<{
		name: string;
		handler: (args: string, ctx: unknown) => Promise<void>;
	}> = [];
	const pi = {
		registerCommand: (name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.push({ name, ...definition });
		},
	} as never;
	return { pi, commands };
}

function fakeCtx() {
	const notifications: Array<{ message: string; level: string }> = [];
	const ctx = {
		ui: {
			notify: (message: string, level: string) => {
				notifications.push({ message, level });
			},
		},
		modelRegistry: {
			getApiKeyForProvider: async () => "sk-test",
		},
	};
	return { ctx, notifications };
}

describe("issue #35 — /nan-debug argument parsing", () => {
	test("defaults: no topic, 7-day window, no emit, no out", () => {
		const parsed = parseDebugArgs("");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.args).toEqual({ windowDays: DEFAULT_DEBUG_WINDOW_DAYS, windowProvided: false, emit: false });
	});

	test("accepts a topic, --window, --out and --emit in any order", () => {
		const parsed = parseDebugArgs("cache --window 3 --out /tmp/report --emit");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.args).toEqual({ topic: "cache", windowDays: 3, windowProvided: true, out: "/tmp/report", emit: true });
	});

	test("accepts --window and a topic with no other flags", () => {
		const a = parseDebugArgs("--window 2");
		expect(a.ok && a.args.windowDays).toBe(2);
		const b = parseDebugArgs("cache-anomaly_1");
		expect(b.ok && b.args.topic).toBe("cache-anomaly_1");
	});

	test("rejects malformed input with a usage message", () => {
		for (const input of ["--window", "--window 0", "--window 91", "--window nope", "--out", "two topics", "--bogus", "topic --emit x"]) {
			const parsed = parseDebugArgs(input);
			expect(parsed.ok, input).toBe(false);
			if (!parsed.ok) expect(parsed.error).toContain("Usage: /nan-debug");
		}
	});
});

describe("issue #35 — /nan-debug command flow", () => {
	test("registers the command", () => {
		const { pi, commands } = fakePi();
		registerNanDebugCommand(pi, { agentDir: scratch(), now: () => NOW });
		expect(commands.map((c) => c.name)).toEqual(["nan-debug"]);
	});

	test("writes the redacted report and prints the preview without a zip", async () => {
		const agentDir = fixtureAgentDir();
		const { pi, commands } = fakePi();
		registerNanDebugCommand(pi, { agentDir, now: () => NOW });
		const { ctx, notifications } = fakeCtx();

		await commands[0]!.handler("cache --window 2", ctx);

		expect(existsSync(join(agentDir, "nan-debug-report", "README.md"))).toBe(true);
		expect(existsSync(join(agentDir, "nan-debug-report", "anonymized_usage.jsonl"))).toBe(true);
		expect(existsSync(join(agentDir, "nan-debug-report.zip"))).toBe(false);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]!.message).toContain("nan-debug report — 2026-11-10 → 2026-11-11");
		expect(notifications[0]!.message).toContain("Run with --emit");
	});

	test("--emit writes the zip next to the report", async () => {
		const agentDir = fixtureAgentDir();
		const { pi, commands } = fakePi();
		registerNanDebugCommand(pi, { agentDir, now: () => NOW });
		const { ctx, notifications } = fakeCtx();

		await commands[0]!.handler("--window 2 --emit", ctx);

		expect(existsSync(join(agentDir, "nan-debug-report.zip"))).toBe(true);
		expect(notifications[0]!.message).toContain(join(agentDir, "nan-debug-report.zip"));
	});

	test("--out sets the report directory and the zip path", async () => {
		const agentDir = fixtureAgentDir();
		const out = join(scratch(), "evidence");
		const { pi, commands } = fakePi();
		registerNanDebugCommand(pi, { agentDir, now: () => NOW });
		const { ctx } = fakeCtx();

		await commands[0]!.handler(`--window 2 --out ${out} --emit`, ctx);

		expect(existsSync(join(out, "metadata.json"))).toBe(true);
		expect(existsSync(`${out}.zip`)).toBe(true);
	});

	test("--window fetches the official usage for the same window", async () => {
		const agentDir = fixtureAgentDir();
		const calls: Array<{ window: DebugWindow; apiKey: string }> = [];
		const { pi, commands } = fakePi();
		registerNanDebugCommand(pi, {
			agentDir,
			now: () => NOW,
			fetchUsage: async (window, apiKey) => {
				calls.push({ window, apiKey });
				return { object: "usage.report", totals: { total_tokens: 42, by_model: [] } };
			},
		});
		const { ctx } = fakeCtx();

		await commands[0]!.handler("--window 2", ctx);

		expect(calls).toEqual([{ window: { start: "2026-11-10", end: "2026-11-11", days: 2 }, apiKey: "sk-test" }]);
		expect(existsSync(join(agentDir, "nan-debug-report", "usage_window.json"))).toBe(true);
	});

	test("without --window no usage request is made", async () => {
		const agentDir = fixtureAgentDir();
		let calls = 0;
		const { pi, commands } = fakePi();
		registerNanDebugCommand(pi, {
			agentDir,
			now: () => NOW,
			fetchUsage: async () => {
				calls += 1;
				return {};
			},
		});
		const { ctx } = fakeCtx();

		await commands[0]!.handler("", ctx);

		expect(calls).toBe(0);
		expect(existsSync(join(agentDir, "nan-debug-report", "usage_window.json"))).toBe(false);
	});

	test("invalid arguments print usage and write nothing", async () => {
		const agentDir = fixtureAgentDir();
		const { pi, commands } = fakePi();
		registerNanDebugCommand(pi, { agentDir, now: () => NOW });
		const { ctx, notifications } = fakeCtx();

		await commands[0]!.handler("--window 999", ctx);

		expect(notifications).toHaveLength(1);
		expect(notifications[0]!.level).toBe("warning");
		expect(notifications[0]!.message).toContain("Usage: /nan-debug");
		expect(existsSync(join(agentDir, "nan-debug-report"))).toBe(false);
	});
});

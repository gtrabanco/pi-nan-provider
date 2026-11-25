/**
 * ACCEPTANCE TESTS — issue #49, part C
 * `/nan-debug` at the command boundary: the emission-timestamped default
 * names, the content flags (`--include-prompts`, `--include-tools`, `--all`),
 * the sharing preview, and the usage-window zip exclusion.
 *
 * Frozen-failure corpus for docs/fix/issue-49-nan-debug-http-attempts/SPEC.md
 * (O16–O18).
 *
 * https://github.com/gtrabanco/pi-nan-provider/issues/49
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { debugReportDirName, debugReportZipName, parseDebugArgs } from "../src/debug-report.ts";
import { registerNanDebugCommand } from "../src/debug-command.ts";

const NOW = new Date("2026-11-19T13:45:02.000Z");

let scratchDirs: string[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "nan-49-cmd-"));
	scratchDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
	scratchDirs = [];
});

/** Entry names from a store-method zip's central directory. */
function zipEntries(zip: Buffer): string[] {
	const names: string[] = [];
	let offset = 0;
	while (offset >= 0 && offset < zip.length) {
		const signature = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), offset);
		if (signature < 0) break;
		const nameLength = zip.readUInt16LE(signature + 28);
		names.push(zip.subarray(signature + 46, signature + 46 + nameLength).toString("utf8"));
		offset = signature + 4;
	}
	return names;
}

function fixtureAgentDir(): string {
	const agentDir = scratch();
	const dir = join(agentDir, "sessions", "--proj--");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "2026-11-19T12-00-00-000Z_a.jsonl"),
		`${JSON.stringify({ type: "session", cwd: "/home/agent/proj", timestamp: "2026-11-19T12:00:00.000Z" })}\n` +
			`${JSON.stringify({ type: "message", message: { role: "user", content: "PROMPT-LITERAL" } })}\n` +
			`${JSON.stringify({
				type: "message",
				timestamp: "2026-11-19T12:00:01.000Z",
				message: {
					role: "assistant",
					provider: "nan",
					api: "openai-completions",
					model: "qwen3.6",
					responseId: "chatcmpl-1",
					usage: { input: 1, output: 1, totalTokens: 2 },
					stopReason: "stop",
					timestamp: 1,
					content: [{ type: "text", text: "answer" }],
				},
			})}\n`,
	);
	return agentDir;
}

function fakePi() {
	const commands: Array<{ name: string; handler: (args: string, ctx: unknown) => Promise<void> }> = [];
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
		modelRegistry: { getApiKeyForProvider: async () => "sk-test" },
	};
	return { ctx, notifications };
}

describe("issue #49 — flags parse (O13, O17)", () => {
	test("content flags parse and stay mutually compatible", () => {
		const prompts = parseDebugArgs("--include-prompts");
		expect(prompts.ok && prompts.args.includePrompts).toBe(true);
		expect(prompts.ok && prompts.args.includeTools).toBe(false);

		const tools = parseDebugArgs("--include-tools");
		expect(tools.ok && tools.args.includeTools).toBe(true);
		// "incluye además": tool calls only make sense inside a transcript.
		expect(tools.ok && tools.args.includePrompts).toBe(true);

		const all = parseDebugArgs("cache --window 2 --all --emit");
		expect(all.ok).toBe(true);
		if (all.ok) {
			expect(all.args.includePrompts).toBe(true);
			expect(all.args.includeTools).toBe(true);
			expect(all.args.all).toBe(true);
			expect(all.args.emit).toBe(true);
			expect(all.args.topic).toBe("cache");
		}
	});

	test("defaults keep the artifact content-free", () => {
		const parsed = parseDebugArgs("");
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.args.includePrompts).toBe(false);
			expect(parsed.args.includeTools).toBe(false);
			expect(parsed.args.all).toBe(false);
		}
	});
});

describe("issue #49 — emission-timestamped defaults (O16)", () => {
	test("the default run writes the timestamped directory", async () => {
		const agentDir = fixtureAgentDir();
		const { pi, commands } = fakePi();
		registerNanDebugCommand(pi, { agentDir, now: () => NOW });
		const { ctx } = fakeCtx();

		await commands[0]!.handler("--window 2", ctx);

		const dir = join(agentDir, debugReportDirName(NOW));
		expect(existsSync(join(dir, "README.md"))).toBe(true);
		expect(existsSync(join(agentDir, "nan-debug-report"))).toBe(false);
	});

	test("--emit writes the timestamped portable zip", async () => {
		const agentDir = fixtureAgentDir();
		const { pi, commands } = fakePi();
		registerNanDebugCommand(pi, { agentDir, now: () => NOW });
		const { ctx, notifications } = fakeCtx();

		await commands[0]!.handler("--window 2 --emit", ctx);

		const zip = join(agentDir, debugReportZipName(NOW));
		expect(existsSync(zip)).toBe(true);
		expect(zip.endsWith("nan-debug-report-2026-11-19T13-45-02.zip")).toBe(true);
		expect(notifications[0]!.message).toContain(zip);
	});

	test("an explicit --out is respected verbatim", async () => {
		const agentDir = fixtureAgentDir();
		const out = join(scratch(), "evidence");
		const { pi, commands } = fakePi();
		registerNanDebugCommand(pi, { agentDir, now: () => NOW });
		const { ctx } = fakeCtx();

		await commands[0]!.handler(`--window 2 --out ${out} --emit`, ctx);

		expect(existsSync(join(out, "metadata.json"))).toBe(true);
		expect(existsSync(`${out}.zip`)).toBe(true);
	});
});

describe("issue #49 — sharing preview and content flags (O13, O17, O18)", () => {
	test("the preview states what is shared and what needs a flag", async () => {
		const agentDir = fixtureAgentDir();
		const { pi, commands } = fakePi();
		registerNanDebugCommand(pi, { agentDir, now: () => NOW });
		const { ctx, notifications } = fakeCtx();

		await commands[0]!.handler("--window 2", ctx);

		const message = notifications[0]!.message;
		expect(message).toContain("shared by default");
		expect(message).toContain("--include-prompts");
		expect(message).toContain("--include-tools");
		expect(message).toContain("--all");
	});

	test("the default written artifact has no transcripts; --include-prompts adds them", async () => {
		const agentDir = fixtureAgentDir();
		const { pi, commands } = fakePi();
		registerNanDebugCommand(pi, { agentDir, now: () => NOW });
		const { ctx } = fakeCtx();

		await commands[0]!.handler("--window 2", ctx);
		const defaultDir = join(agentDir, debugReportDirName(NOW));
		expect(readFileSync(join(defaultDir, "metadata.json"), "utf8")).toContain('"transcripts_included": false');
		expect(existsSync(join(defaultDir, "sessions"))).toBe(false);

		const out = join(scratch(), "with-prompts");
		await commands[0]!.handler(`--window 2 --include-prompts --out ${out}`, ctx);
		expect(existsSync(join(out, "sessions"))).toBe(true);
		expect(readFileSync(join(out, "metadata.json"), "utf8")).toContain('"transcripts_included": true');
	});

	test("--include-prompts writes sessions/; --all also writes usage_window.json into the zip", async () => {
		const agentDir = fixtureAgentDir();
		const out = join(scratch(), "full");
		const { pi, commands } = fakePi();
		registerNanDebugCommand(pi, {
			agentDir,
			now: () => NOW,
			fetchUsage: async () => ({ object: "usage.report", credits: { allowance: 100 } }),
		});
		const { ctx } = fakeCtx();

		await commands[0]!.handler(`--window 2 --all --out ${out} --emit`, ctx);

		expect(existsSync(join(out, "sessions", "--proj--", "2026-11-19T12-00-00-000Z_a.jsonl"))).toBe(true);
		expect(existsSync(join(out, "usage_window.json"))).toBe(true);
		const entries = zipEntries(readFileSync(`${out}.zip`));
		expect(entries).toContain("usage_window.json");
		expect(entries.some((name) => name.startsWith("sessions/"))).toBe(true);
	});

	test("--window without --all keeps usage_window.json out of the zip", async () => {
		const agentDir = fixtureAgentDir();
		const out = join(scratch(), "windowed");
		const { pi, commands } = fakePi();
		registerNanDebugCommand(pi, {
			agentDir,
			now: () => NOW,
			fetchUsage: async () => ({ object: "usage.report", credits: { allowance: 100 } }),
		});
		const { ctx } = fakeCtx();

		await commands[0]!.handler(`--window 2 --out ${out} --emit`, ctx);

		expect(existsSync(join(out, "usage_window.json"))).toBe(true);
		expect(zipEntries(readFileSync(`${out}.zip`))).not.toContain("usage_window.json");
	});
});

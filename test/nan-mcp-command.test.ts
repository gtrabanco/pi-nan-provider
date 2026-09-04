import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerNanMcpCommand } from "../src/commands.ts";
import {
	mediaMcpEnabled,
	mediaMcpSource,
	readMediaMcpState,
	NAN_STATE_FILE,
	writeMediaMcpState,
} from "../src/mcp/nan-media.ts";

const agentDir = mkdtempSync(join(tmpdir(), "nan-mcp-cmd-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

afterEach(() => {
	delete process.env.NAN_MEDIA_MCP;
	rmSync(join(agentDir, NAN_STATE_FILE), { force: true });
});

interface FakeCommandContext {
	notifications: Array<{ message: string; type?: string }>;
}

function fakeCommandPi(): {
	pi: ExtensionAPI;
	command: { name: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> } | undefined;
	registeredTools: string[];
	ctx: FakeCommandContext;
	commandCtx: ExtensionCommandContext;
} {
	const registeredTools: string[] = [];
	let command: { name: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> } | undefined;
	const ctx = { notifications: [] as Array<{ message: string; type?: string }> };
	const pi = {
		registerTool: (tool: { name: string }) => registeredTools.push(tool.name),
		registerCommand: (name: string, definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
			command = { name, handler: definition.handler };
		},
	} as unknown as ExtensionAPI;
	registerNanMcpCommand(pi, {
		registerMediaTools: () => {
			// Simulates index.ts's idempotent registrar: register what is not yet registered.
			// The real path is covered by compat tests; here we just prove it is invoked.
			registeredTools.push("<registerMediaTools called>");
		},
	});
	const commandCtx = {
		ui: {
			notify: (message: string, type?: string) => {
				ctx.notifications.push({ message, type });
			},
		},
	} as unknown as ExtensionCommandContext;
	return { pi, command, registeredTools, ctx, commandCtx };
}

describe("/nan-mcp command (persistent media MCP enablement)", () => {
	test("enable persists the toggle and registers tools immediately", async () => {
		const { command, registeredTools, ctx, commandCtx } = fakeCommandPi();
		expect(command?.name).toBe("nan-mcp");
		expect(mediaMcpEnabled()).toBe(false);

		// Tolerates the muscle-memory trailing token from `/mcp enable nan-mcp-server`.
		await command!.handler("enable nan-mcp-server", commandCtx);

		expect(mediaMcpEnabled()).toBe(true);
		expect(mediaMcpSource()).toBe("persisted");
		expect(readMediaMcpState()).toBe(true);
		expect(registeredTools).toContain("<registerMediaTools called>");
		expect(ctx.notifications[0]?.type).toBe("info");
	});

	test("disable persists the toggle for future sessions", async () => {
		writeMediaMcpState(true);
		const { command, ctx, commandCtx } = fakeCommandPi();
		await command!.handler("disable", commandCtx);
		expect(readMediaMcpState()).toBe(false);
		expect(mediaMcpEnabled()).toBe(false);
		expect(ctx.notifications[0]?.type).toBe("warning");
	});

	test("status reports source and state", async () => {
		const { command, ctx, commandCtx } = fakeCommandPi();
		await command!.handler("status", commandCtx);
		expect(ctx.notifications[0]?.message).toContain("Media MCP (nan-mcp-server): disabled");
		expect(ctx.notifications[0]?.message).toContain("default (off");

		writeMediaMcpState(true);
		await command!.handler("status", commandCtx);
		expect(ctx.notifications[1]?.message).toContain("persisted in <agentDir>/nan-provider.json");
	});

	test("unknown subcommand shows usage", async () => {
		const { command, ctx, commandCtx } = fakeCommandPi();
		await command!.handler("frobnicate", commandCtx);
		expect(ctx.notifications[0]?.type).toBe("warning");
		expect(ctx.notifications[0]?.message).toContain("Usage: /nan-mcp");
	});

	test("env var overrides the persisted toggle (one-session escape hatch)", () => {
		writeMediaMcpState(false);
		process.env.NAN_MEDIA_MCP = "1";
		try {
			expect(mediaMcpEnabled()).toBe(true);
			expect(mediaMcpSource()).toBe("env");
		} finally {
			delete process.env.NAN_MEDIA_MCP;
		}

		writeMediaMcpState(true);
		process.env.NAN_MEDIA_MCP = "0";
		try {
			expect(mediaMcpEnabled()).toBe(false);
		} finally {
			delete process.env.NAN_MEDIA_MCP;
		}
	});
});
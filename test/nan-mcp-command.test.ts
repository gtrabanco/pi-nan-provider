import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerNanMcpCommand } from "../src/commands.ts";
import { mediaMcpEnabled, mediaMcpSource } from "../src/mcp/nan-media.ts";
import { webSearchBridgeEnabled, webSearchBridgeSource } from "../src/mcp/nan-search.ts";
import { NAN_STATE_FILE, readBridgeState, writeBridgeState } from "../src/mcp/state.ts";

const agentDir = mkdtempSync(join(tmpdir(), "nan-mcp-cmd-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

afterEach(() => {
	for (const key of ["NAN_MEDIA_MCP", "NAN_MCP_TOOLS"]) delete process.env[key];
	rmSync(join(agentDir, NAN_STATE_FILE), { force: true });
});

function fakeCommandPi() {
	const registeredTools: string[] = [];
	let command: { name: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> } | undefined;
	const notifications: Array<{ message: string; type?: string }> = [];
	registerNanMcpCommand(
		{
			registerTool: (tool: { name: string }) => registeredTools.push(tool.name),
			registerCommand: (name: string, definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
				command = { name, handler: definition.handler };
			},
		} as unknown as ExtensionAPI,
		{
			registerWebSearchTools: () => registeredTools.push("<registerWebSearchTools called>"),
			registerMediaTools: () => registeredTools.push("<registerMediaTools called>"),
		},
	);
	const commandCtx = {
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		},
	} as unknown as ExtensionCommandContext;
	return { command, registeredTools, notifications, commandCtx };
}

describe("/nan-mcp command (configures both MCP bridges)", () => {
	test("registers under the nan-mcp name", () => {
		const { command } = fakeCommandPi();
		expect(command?.name).toBe("nan-mcp");
	});

	test("enable with no target enables and persists BOTH bridges", async () => {
		const { command, registeredTools, notifications, commandCtx } = fakeCommandPi();
		expect(webSearchBridgeEnabled()).toBe(true); // default
		expect(mediaMcpEnabled()).toBe(true); // default

		await command!.handler("disable", commandCtx); // both off (persisted)
		expect(webSearchBridgeEnabled()).toBe(false);
		expect(mediaMcpEnabled()).toBe(false);

		await command!.handler("enable", commandCtx); // both on again, persisted
		expect(webSearchBridgeEnabled()).toBe(true);
		expect(mediaMcpEnabled()).toBe(true);
		expect(mediaMcpSource()).toBe("persisted");
		expect(webSearchBridgeSource()).toBe("persisted");
		expect(registeredTools).toContain("<registerWebSearchTools called>");
		expect(registeredTools).toContain("<registerMediaTools called>");
		expect(notifications.at(-1)?.type).toBe("info");
		expect(readBridgeState("webSearch")).toBe(true);
		expect(readBridgeState("mediaMcp")).toBe(true);
	});

	test("enable accepts per-bridge targets and aliases", async () => {
		const { command, registeredTools, commandCtx } = fakeCommandPi();
		await command!.handler("disable", commandCtx);

		await command!.handler("enable nan-mcp-server", commandCtx); // community bridge only
		expect(webSearchBridgeEnabled()).toBe(false);
		expect(mediaMcpEnabled()).toBe(true);
		expect(registeredTools).toContain("<registerMediaTools called>");
		expect(registeredTools).not.toContain("<registerWebSearchTools called>");

		await command!.handler("enable web-search", commandCtx); // official bridge only
		expect(webSearchBridgeEnabled()).toBe(true);
		expect(registeredTools).toContain("<registerWebSearchTools called>");
	});

	test("enable accepts the /mcp muscle-memory alias for the media server", async () => {
		const { command, commandCtx } = fakeCommandPi();
		await command!.handler("disable", commandCtx);
		// The user's original `/mcp enable nan-mcp-server` maps to the media bridge.
		await command!.handler("enable media", commandCtx);
		expect(mediaMcpEnabled()).toBe(true);
		expect(webSearchBridgeEnabled()).toBe(false);
	});

	test("disable persists per bridge; unknown target shows a warning", async () => {
		const { command, notifications, commandCtx } = fakeCommandPi();
		await command!.handler("disable nan-mcp-server", commandCtx);
		expect(mediaMcpEnabled()).toBe(false);
		expect(webSearchBridgeEnabled()).toBe(true);
		expect(notifications.at(-1)?.type).toBe("warning");

		await command!.handler("enable frobnicator", commandCtx);
		const last = notifications.at(-1)!;
		expect(last.type).toBe("warning");
		expect(last.message).toContain("Unknown target");
	});

	test("status reports both bridges with their sources", async () => {
		const { command, notifications, commandCtx } = fakeCommandPi();
		await command!.handler("status", commandCtx);
		const message = notifications.at(-1)!.message;
		expect(message).toContain("web-search bridge (official NaN MCP");
		expect(message).toContain("nan-mcp-server bridge (community media MCP");
		expect(message).toContain("enabled — default (both bridges are enabled and lazy by default)");

		await command!.handler("disable web-search", commandCtx);
		await command!.handler("status", commandCtx);
		expect(notifications.at(-1)!.message).toContain("persisted in <agentDir>/nan-provider.json (web-search: false)");
	});

	test("env vars override the persisted toggles (one-session escape hatch)", () => {
		writeBridgeState("mediaMcp", false);
		writeBridgeState("webSearch", false);
		process.env.NAN_MEDIA_MCP = "1";
		process.env.NAN_MCP_TOOLS = "0";
		try {
			expect(mediaMcpEnabled()).toBe(true);
			expect(mediaMcpSource()).toBe("env");
			expect(webSearchBridgeEnabled()).toBe(false);
			expect(webSearchBridgeSource()).toBe("env");
		} finally {
			delete process.env.NAN_MEDIA_MCP;
			delete process.env.NAN_MCP_TOOLS;
		}
	});

	test("state file keeps both toggles in one JSON", async () => {
		const { command, commandCtx } = fakeCommandPi();
		await command!.handler("disable web-search", commandCtx);
		await command!.handler("enable", commandCtx);
		const state = JSON.parse(readFileSync(join(agentDir, NAN_STATE_FILE), "utf8")) as Record<string, boolean>;
		expect(state.webSearch).toBe(true);
		expect(state.mediaMcp).toBe(true);
	});
});
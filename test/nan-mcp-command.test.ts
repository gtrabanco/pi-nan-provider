/**
 * /nan-mcp command tests — reworked for native MCP registration.
 *
 * Retargeted from registerTool-callback tests:
 * - Old: verified registerWebSearchTools/registerMediaTools callbacks
 * - New: verifies pi.registerMcpServer / pi.unregisterMcpServer directly
 *
 * Justification: the command now owns the native registration directly.
 * Messages changed: "pi has no unregisterTool" → "unregistered — tools hidden immediately".
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerNanMcpCommand } from "../src/commands.ts";
import { mediaMcpEnabled, mediaMcpSource } from "../src/mcp/media-server.ts";
import { webSearchBridgeEnabled, webSearchBridgeSource } from "../src/mcp/api-key.ts";
import { NAN_STATE_FILE, readBridgeState, writeBridgeState } from "../src/mcp/state.ts";

const agentDir = mkdtempSync(join(tmpdir(), "nan-mcp-cmd-native-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

afterEach(() => {
	for (const key of ["NAN_MEDIA_MCP", "NAN_MCP_TOOLS", "NAN_API_KEY"]) delete process.env[key];
	rmSync(join(agentDir, NAN_STATE_FILE), { force: true });
});

interface RecordedServer {
	name: string;
	config: Record<string, unknown>;
}

function fakeCommandPi() {
	const servers: RecordedServer[] = [];
	let command: { name: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> } | undefined;
	const notifications: Array<{ message: string; type?: string }> = [];

	registerNanMcpCommand(
		{
			registerTool: () => {}, // unused with native MCP
			registerCommand: (name: string, definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
				command = { name, handler: definition.handler };
			},
			registerMcpServer: (name: string, config: Record<string, unknown>) => {
				servers.push({ name, config });
			},
			unregisterMcpServer: (name: string) => {
				const idx = servers.findIndex((s) => s.name === name);
				if (idx !== -1) servers.splice(idx, 1);
			},
			getMcpServers: () => servers,
		} as unknown as ExtensionAPI,
	);

	const commandCtx = {
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		},
	} as unknown as ExtensionCommandContext;

	return { command, servers, notifications, commandCtx };
}

describe("/nan-mcp command (native MCP registration)", () => {
	test("registers under the nan-mcp name", () => {
		const { command } = fakeCommandPi();
		expect(command?.name).toBe("nan-mcp");
	});

	test("enable with no target registers BOTH native servers", async () => {
		// Web-search registration needs NAN_API_KEY (resolved at enable time)
		process.env.NAN_API_KEY = "sk-test";
		const { command, servers, notifications, commandCtx } = fakeCommandPi();
		expect(webSearchBridgeEnabled()).toBe(true);
		expect(mediaMcpEnabled()).toBe(true);

		await command!.handler("enable", commandCtx);

		const nanSearch = servers.find((s) => s.name === "nan-search");
		const nanMedia = servers.find((s) => s.name === "nan-media");
		expect(nanSearch).toBeDefined();
		expect(nanMedia).toBeDefined();
		expect(nanSearch!.config.exposure).toBe("direct");
		expect(nanMedia!.config.exposure).toBe("direct");
		expect(notifications.at(-1)?.type).toBe("info");
		expect(readBridgeState("webSearch")).toBe(true);
		expect(readBridgeState("mediaMcp")).toBe(true);
	});

	test("enable accepts per-bridge targets and aliases", async () => {
		process.env.NAN_API_KEY = "sk-test";
		const { command, servers, commandCtx } = fakeCommandPi();
		await command!.handler("disable", commandCtx);

		await command!.handler("enable nan-mcp-server", commandCtx);
		expect(servers.find((s) => s.name === "nan-search")).toBeUndefined();
		expect(servers.find((s) => s.name === "nan-media")).toBeDefined();

		await command!.handler("enable web-search", commandCtx);
		expect(servers.find((s) => s.name === "nan-search")).toBeDefined();
		expect(servers.find((s) => s.name === "nan-media")).toBeDefined();
	});

	test("enable accepts the /mcp muscle-memory alias for the media server", async () => {
		const { command, servers, commandCtx } = fakeCommandPi();
		await command!.handler("disable", commandCtx);
		await command!.handler("enable media", commandCtx);
		expect(servers.find((s) => s.name === "nan-media")).toBeDefined();
		expect(servers.find((s) => s.name === "nan-search")).toBeUndefined();
	});

	test("disable unregisters immediately", async () => {
		process.env.NAN_API_KEY = "sk-test";
		const { command, servers, notifications, commandCtx } = fakeCommandPi();
		await command!.handler("enable", commandCtx);
		expect(servers.find((s) => s.name === "nan-search")).toBeDefined();
		expect(servers.find((s) => s.name === "nan-media")).toBeDefined();

		await command!.handler("disable web-search", commandCtx);
		expect(servers.find((s) => s.name === "nan-search")).toBeUndefined();
		expect(servers.find((s) => s.name === "nan-media")).toBeDefined();
		expect(notifications.at(-1)?.type).toBe("warning");
		expect(notifications.at(-1)?.message).toContain("tools hidden immediately");
	});

	test("unknown target shows a warning", async () => {
		const { command, notifications, commandCtx } = fakeCommandPi();
		await command!.handler("enable frobnicator", commandCtx);
		const last = notifications.at(-1)!;
		expect(last.type).toBe("warning");
		expect(last.message).toContain("Unknown target");
	});

	test("status reports both bridges with registration state", async () => {
		const { command, notifications, commandCtx } = fakeCommandPi();
		await command!.handler("status", commandCtx);
		const message = notifications.at(-1)!.message;
		expect(message).toContain("web-search bridge (official NaN MCP");
		expect(message).toContain("nan-mcp-server bridge (community media MCP");
		expect(message).toContain("default (both bridges are enabled by default)");

		await command!.handler("disable web-search", commandCtx);
		await command!.handler("status", commandCtx);
		expect(notifications.at(-1)!.message).toContain("persisted in <agentDir>/nan-provider.json (web-search: false)");
	});

	test("env vars override the persisted toggles", () => {
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

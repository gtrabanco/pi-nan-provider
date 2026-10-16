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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerNanMcpCommand } from "../src/commands.ts";
import { mediaMcpEnabled, mediaMcpSource } from "../src/mcp/media-server.ts";
import { NAN_STATE_FILE, readBridgeState, writeBridgeState } from "../src/mcp/state.ts";

const agentDir = mkdtempSync(join(tmpdir(), "nan-mcp-cmd-native-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

afterEach(() => {
	for (const key of ["NAN_MEDIA_MCP", "NAN_API_KEY"]) delete process.env[key];
	rmSync(join(agentDir, NAN_STATE_FILE), { force: true });
	rmSync(join(agentDir, "auth.json"), { force: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
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

	const modelRegistry = {
		getApiKeyForProvider: async (provider: string): Promise<string | undefined> => undefined,
	} as unknown as { getApiKeyForProvider: (provider: string) => Promise<string | undefined> };

	const commandCtx = {
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		},
		modelRegistry,
	} as unknown as ExtensionCommandContext;

	return { command, servers, notifications, commandCtx, modelRegistry };
}

describe("/nan-mcp command (native MCP registration)", () => {
	test("registers under the nan-mcp name", () => {
		const { command } = fakeCommandPi();
		expect(command?.name).toBe("nan-mcp");
	});

	test("enable with no target registers the media native server", async () => {
		// Registration needs NAN_API_KEY (resolved at enable time)
		process.env.NAN_API_KEY = "sk-test";
		const { command, servers, notifications, commandCtx } = fakeCommandPi();
		expect(mediaMcpEnabled()).toBe(true);

		await command!.handler("enable", commandCtx);

		const nanMedia = servers.find((s) => s.name === "nan-media");
		expect(nanMedia).toBeDefined();
		expect(nanMedia!.config.exposure).toBe("direct");
		expect(notifications.at(-1)?.type).toBe("info");
		expect(readBridgeState("mediaMcp")).toBe(true);
	});

	test("enable accepts the target and its aliases", async () => {
		process.env.NAN_API_KEY = "sk-test";
		const { command, servers, commandCtx } = fakeCommandPi();
		await command!.handler("disable", commandCtx);
		expect(servers.find((s) => s.name === "nan-media")).toBeUndefined();

		await command!.handler("enable", commandCtx);
		expect(servers.find((s) => s.name === "nan-media")).toBeDefined();

		await command!.handler("disable", commandCtx);
		await command!.handler("enable media", commandCtx);
		expect(servers.find((s) => s.name === "nan-media")).toBeDefined();
	});

	test("disable unregisters immediately", async () => {
		process.env.NAN_API_KEY = "sk-test";
		const { command, servers, notifications, commandCtx } = fakeCommandPi();
		await command!.handler("enable", commandCtx);
		expect(servers.find((s) => s.name === "nan-media")).toBeDefined();

		await command!.handler("disable", commandCtx);
		expect(servers.find((s) => s.name === "nan-media")).toBeUndefined();
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

	test("status reports the media bridge with registration state", async () => {
		const { command, notifications, commandCtx } = fakeCommandPi();
		await command!.handler("status", commandCtx);
		const message = notifications.at(-1)!.message;
		expect(message).toContain("nan-mcp-server bridge");
		expect(message).toContain("default (bridge is enabled by default)");

		await command!.handler("disable", commandCtx);
		await command!.handler("status", commandCtx);
		expect(notifications.at(-1)!.message).toContain("persisted in <agentDir>/nan-provider.json (nan-mcp-server: false)");
	});

	test("env vars override the persisted toggles", () => {
		writeBridgeState("mediaMcp", false);
		process.env.NAN_MEDIA_MCP = "1";
		try {
			expect(mediaMcpEnabled()).toBe(true);
			expect(mediaMcpSource()).toBe("env");
		} finally {
			delete process.env.NAN_MEDIA_MCP;
		}
	});

	test("state file persists the media toggle", async () => {
		const { command, commandCtx } = fakeCommandPi();
		await command!.handler("disable", commandCtx);
		await command!.handler("enable", commandCtx);
		const state = JSON.parse(readFileSync(join(agentDir, NAN_STATE_FILE), "utf8")) as Record<string, boolean>;
		expect(state.mediaMcp).toBe(true);
	});

	test("status with registry key shows 'resolved', NOT [object Promise]", async () => {
		process.env.NAN_API_KEY = "sk-test";
		const registryKeyPromise = Promise.resolve("sk-registry");
		const commandCtxWithRegistry = {
			ui: {
				notify: (message: string, type?: string) => notifications.push({ message, type }),
			},
			modelRegistry: {
				getApiKeyForProvider: async () => "sk-registry",
			} as unknown as { getApiKeyForProvider: (provider: string) => Promise<string | undefined> },
		} as unknown as ExtensionCommandContext;
		const { command, notifications, servers, commandCtx } = fakeCommandPi();

		await command!.handler("status", commandCtxWithRegistry);
		const message = notifications.at(-1)!.message;
		expect(message).toContain("nan-mcp-server bridge");
		expect(message).toContain("API key: resolved");
		expect(message).not.toContain("[object Promise]");
	});

	test("enable with no key: no registration, warning, no false success", async () => {
		delete process.env.NAN_API_KEY;
		const commandCtxWithRegistry = {
			ui: {
				notify: (message: string, type?: string) => notifications.push({ message, type }),
			},
						modelRegistry: {
				getApiKeyForProvider: async () => undefined,
			} as unknown as { getApiKeyForProvider: (provider: string) => Promise<string | undefined> },
		} as unknown as ExtensionCommandContext;
		const { command, notifications, servers, commandCtx } = fakeCommandPi();

		await command!.handler("enable", commandCtxWithRegistry);

		expect(servers.find((s) => s.name === "nan-media")).toBeUndefined();
		// Should show a warning about missing key, NOT the success message
		const lastNotif = notifications.at(-1);
		expect(lastNotif?.type).toBe("warning");
		expect(lastNotif?.message).not.toContain("Native server registered for this session");
	});

	test("enable media with stored credential and no env key registers with correct env", async () => {
		const authPath = join(agentDir, "auth.json");
		writeFileSync(authPath, JSON.stringify({
			nan: { type: "api_key", key: "sk-stored-media" },
		}), "utf8");
		delete process.env.NAN_API_KEY;
		const commandCtxWithRegistry = {
			ui: {
				notify: (message: string, type?: string) => notifications.push({ message, type }),
			},
						modelRegistry: {
				getApiKeyForProvider: async () => undefined,
			} as unknown as { getApiKeyForProvider: (provider: string) => Promise<string | undefined> },
		} as unknown as ExtensionCommandContext;
		const { command, notifications, servers, commandCtx } = fakeCommandPi();

		await command!.handler("enable nan-mcp-server", commandCtxWithRegistry);

		const nanMedia = servers.find((s) => s.name === "nan-media");
		expect(nanMedia).toBeDefined();
		const env = nanMedia!.config.env as Record<string, string>;
		expect(env["NAN_API_KEY"]).toBe("sk-stored-media");
		expect(notifications.at(-1)?.type).toBe("info");
		expect(notifications.at(-1)?.message).toContain("Native server registered for this session");
	});
});

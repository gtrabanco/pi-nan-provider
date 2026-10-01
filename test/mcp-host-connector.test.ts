/**
 * Host-connector guard tests.
 *
 * Reproduces the pi error seen in hosts that load NO built-in extensions:
 *
 *   MCP server "nan-media" is registered, but no loaded extension connects MCP
 *   servers; another extension may have replaced the built-in MCP support
 *
 * Root cause (verified on pi 0.99.1 / pi-web 1.202609.1): pi-web builds its
 * sessions through `createAgentSessionServices` → `new DefaultResourceLoader(...)`
 * WITHOUT `extensionFactories`, so no `builtin:*` extension loads — including
 * `builtin:mcp`, the one that connects `pi.registerMcpServer()` registrations
 * and registers the `/mcp` command. Our extension still registers `nan-search`
 * / `nan-media`, and `AgentSession.bindExtensions()` calls
 * `runner.reportUnhandledMcpServers()` right after the `session_start` emit,
 * which reports every registration while no extension handles
 * `mcp_servers_change`.
 *
 * Expected behavior:
 * - `session_start` with our servers registered and no `/mcp` command →
 *   claim `mcp_servers_change` (pi's report then sees a handler and stays
 *   silent) and notify once with actionable guidance.
 * - `/mcp` present (healthy pi CLI) → no claim, no notification: pi's own
 *   handling is untouched.
 * - No servers registered (pi <0.99 guard, gates off) → nothing to say.
 * - `/nan-mcp status` states the missing connector; `/nan-mcp enable` does not
 *   register servers that can never connect.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { hasMcpConnector, registerMcpHostGuard } from "../src/mcp/host-support.ts";
import { registerNanMcpCommand } from "../src/commands.ts";
import { NAN_STATE_FILE } from "../src/mcp/state.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface RecordedServer {
	name: string;
	config: Record<string, unknown>;
}

interface CapturedNotify {
	message: string;
	type?: string;
}

/**
 * A pi surface that records event handlers, registrations, and notifications.
 * `commands` mirrors `pi.getCommands()` (names only): `null` = pi without the
 * API (old pi / minimal mocks) → detection must stay conservative.
 */
function mockHost(commands: string[] | null) {
	const servers: RecordedServer[] = [];
	const handlers = new Map<string, Handler[]>();
	const notifications: CapturedNotify[] = [];
	const ui = { notify: (message: string, type?: string) => notifications.push({ message, type }) };

	const pi = {
		registerProvider: () => {},
		registerTool: () => {},
		registerCommand: () => {},
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {
				const current = handlers.get(event) ?? [];
				const index = current.indexOf(handler);
				if (index !== -1) current.splice(index, 1);
				// pi's `on()` unsubscribe deletes the key once the last handler is gone
				// (dist/core/extensions/loader.js), so mirror that shape.
				if (current.length === 0) handlers.delete(event);
			};
		},
		registerMcpServer: (name: string, config: Record<string, unknown>) => {
			servers.push({ name, config: { ...config } });
		},
		unregisterMcpServer: (name: string) => {
			const index = servers.findIndex((server) => server.name === name);
			if (index !== -1) servers.splice(index, 1);
		},
		getMcpServers: () => servers,
		...(commands === null
			? {}
			: { getCommands: () => commands.map((name) => ({ name, source: "extension", sourceInfo: {} })) }),
		ui,
	} as unknown as ExtensionAPI;

	const emitSessionStart = async () => {
		for (const handler of handlers.get("session_start") ?? []) {
			await handler({ type: "session_start", reason: "startup" }, { ui });
		}
	};

	return { pi, ui, handlers, servers, notifications, emitSessionStart };
}

const agentDir = mkdtempSync(join(tmpdir(), "mcp-host-connector-"));

afterEach(() => {
	for (const key of ["NAN_MEDIA_MCP", "NAN_MCP_TOOLS", "NAN_API_KEY"]) delete process.env[key];
	rmSync(join(agentDir, NAN_STATE_FILE), { force: true });
});

describe("hasMcpConnector", () => {
	test("detects the built-in /mcp command", () => {
		expect(hasMcpConnector(mockHost(["mcp"]).pi)).toBe(true);
		expect(hasMcpConnector(mockHost(["nan-mcp", "clear"]).pi)).toBe(false);
	});

	test("accepts a duplicate-name invocation (mcp:2)", () => {
		expect(hasMcpConnector(mockHost(["mcp:2"]).pi)).toBe(true);
	});

	test("stays conservative when pi has no getCommands", () => {
		expect(hasMcpConnector(mockHost(null).pi)).toBe(true);
	});
});

describe("session_start guard (no MCP connector)", () => {
	test("claims mcp_servers_change and warns when /mcp is missing", async () => {
		const { pi, handlers, servers, notifications, emitSessionStart } = mockHost([]);
		registerMcpHostGuard(pi);
		servers.push({ name: "nan-media", config: {} }, { name: "nan-search", config: {} });

		await emitSessionStart();

		expect(handlers.get("mcp_servers_change")?.length).toBe(1);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]!.type).toBe("warning");
		expect(notifications[0]!.message).toContain("/mcp");
		expect(notifications[0]!.message).toContain("nan-media");
		expect(notifications[0]!.message).toContain("nan-search");
		// Servers stay registered: the guard only claims the event and explains.
		expect(servers.map((server) => server.name)).toEqual(["nan-media", "nan-search"]);
	});

	test("keeps servers and stays silent when the built-in /mcp is loaded", async () => {
		const { pi, handlers, servers, notifications, emitSessionStart } = mockHost(["mcp"]);
		registerMcpHostGuard(pi);
		servers.push({ name: "nan-media", config: {} });

		await emitSessionStart();

		expect(handlers.get("mcp_servers_change")).toBeUndefined();
		expect(notifications).toEqual([]);
		expect(servers).toHaveLength(1);
	});

	test("stays silent when this extension registered no server", async () => {
		const { pi, handlers, notifications, emitSessionStart } = mockHost([]);

		registerMcpHostGuard(pi);
		await emitSessionStart();

		expect(handlers.get("mcp_servers_change")).toBeUndefined();
		expect(notifications).toEqual([]);
	});

	test("claims exactly once across repeated session starts", async () => {
		const { pi, handlers, servers, notifications, emitSessionStart } = mockHost([]);
		registerMcpHostGuard(pi);
		servers.push({ name: "nan-media", config: {} });

		await emitSessionStart();
		await emitSessionStart();

		expect(handlers.get("mcp_servers_change")?.length).toBe(1);
		expect(notifications).toHaveLength(2);
	});

	test("releases the claim when a connector appears on a later session", async () => {
		const host = mockHost([]);
		registerMcpHostGuard(host.pi);
		host.servers.push({ name: "nan-media", config: {} });

		await host.emitSessionStart();
		expect(host.handlers.get("mcp_servers_change")?.length).toBe(1);

		// A reloaded session where an extension providing /mcp loaded.
		const withConnector = host.pi as unknown as { getCommands: () => unknown };
		withConnector.getCommands = () => [{ name: "mcp" }];
		await host.emitSessionStart();

		expect(host.handlers.get("mcp_servers_change")).toBeUndefined();
	});

	test("the extension entrypoint wires the guard", async () => {
		const host = mockHost([]);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.NAN_API_KEY = "sk-test";
		try {
			await extension(host.pi);
			expect(host.handlers.has("session_start")).toBe(true);
		} finally {
			delete process.env.PI_CODING_AGENT_DIR;
			delete process.env.NAN_API_KEY;
		}
	});
});

describe("/nan-mcp status and enable without a connector", () => {
	function commandHost(commands: string[] | null) {
		const host = mockHost(commands);
		let command: { name: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> } | undefined;
		registerNanMcpCommand({
			registerCommand: (name: string, definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
				command = { name, handler: definition.handler };
			},
			registerMcpServer: (name: string, config: Record<string, unknown>) =>
				host.pi.registerMcpServer(name, config as never),
			unregisterMcpServer: (name: string) => host.pi.unregisterMcpServer(name),
			getMcpServers: () => host.pi.getMcpServers(),
			...(commands === null ? {} : { getCommands: (host.pi as { getCommands: () => unknown }).getCommands }),
			ui: host.ui,
		} as unknown as ExtensionAPI);
		const ctx = { ui: { notify: (message: string, type?: string) => host.notifications.push({ message, type }) } } as unknown as ExtensionCommandContext;
		return { command, host, ctx };
	}

	test("status reports the missing connector", async () => {
		const { command, host, ctx } = commandHost([]);
		await command!.handler("status", ctx);
		const message = host.notifications.at(-1)!;
		expect(message.message).toContain("connector");
		expect(message.message.toLowerCase()).toContain("missing");
	});

	test("status does not mention a missing connector when /mcp is loaded", async () => {
		const { command, host, ctx } = commandHost(["mcp"]);
		await command!.handler("status", ctx);
		expect(host.notifications.at(-1)!.message).not.toContain("MISSING");
	});

	test("enable persists the toggle but refuses to register an unconnectable server", async () => {
		process.env.NAN_API_KEY = "sk-test";
		const { command, host, ctx } = commandHost([]);

		await command!.handler("enable", ctx);

		expect(host.servers).toEqual([]);
		const message = host.notifications.at(-1)!;
		expect(message.type).toBe("warning");
		expect(message.message).toContain("/mcp");
		const { readBridgeState } = await import("../src/mcp/state.ts");
		expect(readBridgeState("mediaMcp")).toBe(true);
	});

	test("enable registers normally when the connector is loaded", async () => {
		process.env.NAN_API_KEY = "sk-test";
		const { command, host, ctx } = commandHost(["mcp"]);

		await command!.handler("enable", ctx);

		expect(host.servers.map((server) => server.name).sort()).toEqual(["nan-media", "nan-search"]);
	});
});

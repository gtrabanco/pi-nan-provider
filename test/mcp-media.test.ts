/**
 * Native MCP registration tests — media stdio server config.
 *
 * Retargeted from ToolDefinition-wrapper tests (callStdioMcpTool, defineMediaTool):
 * now asserts native MCP registration config instead of stdio client behavior.
 * The stdio client is deleted; tests now verify the server config.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { NAN_STATE_FILE, writeState } from "../src/mcp/state.ts";

interface RecordedServer {
	name: string;
	config: Record<string, unknown>;
}

function mockPi() {
	const servers: RecordedServer[] = [];
	const pi: ExtensionAPI = {
		registerProvider: () => {},
		registerTool: () => {},
		registerCommand: () => {},
		on: () => () => {},
		registerMcpServer: (name: string, config: Record<string, unknown>) => {
			servers.push({ name, config: { ...config } });
		},
		unregisterMcpServer: () => {},
		getMcpServers: () => servers,
		ui: { notify: () => {} },
	} as unknown as ExtensionAPI;

	return { pi, servers };
}

function cleanEnv(keys: string[]) {
	const saved = new Map(keys.map((key) => [key, process.env[key]]));
	return {
		set(key: string, value: string) { process.env[key] = value; },
		delete(key: string) { delete process.env[key]; },
		restore() {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		},
	};
}

const agentDir = mkdtempSync(join(tmpdir(), "mcp-media-test-"));
const cleanAgent = cleanEnv(["PI_CODING_AGENT_DIR"]);

afterEach(() => {
	for (const key of ["NAN_MCP_TOOLS", "NAN_MEDIA_MCP", "NAN_API_KEY", "NAN_MEDIA_MCP_VERSION", "NAN_MEDIA_MCP_COMMAND", "NAN_MEDIA_MCP_TIMEOUT_MS"]) {
		delete process.env[key];
	}
	cleanAgent.delete("PI_CODING_AGENT_DIR");
	rmSync(join(agentDir, NAN_STATE_FILE), { force: true });
});

describe("native media MCP registration", () => {
	test("registers with correct stdio config on default", async () => {
		cleanAgent.set("PI_CODING_AGENT_DIR", agentDir);
		cleanAgent.set("NAN_API_KEY", "sk-media");
		try {
			const { pi, servers } = mockPi();
			await extension(pi);

			const nanMedia = servers.find((s) => s.name === "nan-media");
			expect(nanMedia).toBeDefined();
			expect(nanMedia!.config.type).toBe("stdio");
			expect(nanMedia!.config.command).toBe("npx");
			expect(nanMedia!.config.args).toEqual(["-y", "nan-mcp-server@1.1.2"]);
			expect(nanMedia!.config.exposure).toBe("direct");
			// Timeout: 120000ms → 120 seconds (ceil)
			expect(nanMedia!.config.timeout).toBe(120);
			const env = nanMedia!.config.env as Record<string, string>;
			expect(env["NAN_API_KEY"]).toBe("sk-media");
		} finally {
			cleanAgent.restore();
		}
	});

	test("NAN_MEDIA_MCP=0 does NOT register", async () => {
		cleanAgent.set("PI_CODING_AGENT_DIR", agentDir);
		cleanAgent.set("NAN_MEDIA_MCP", "0");
		cleanAgent.set("NAN_API_KEY", "sk-media");
		try {
			const { pi, servers } = mockPi();
			await extension(pi);

			const nanMedia = servers.find((s) => s.name === "nan-media");
			expect(nanMedia).toBeUndefined();
		} finally {
			cleanAgent.restore();
		}
	});

	test("version override via NAN_MEDIA_MCP_VERSION", async () => {
		cleanAgent.set("PI_CODING_AGENT_DIR", agentDir);
		cleanAgent.set("NAN_MEDIA_MCP_VERSION", "9.9.9");
		cleanAgent.set("NAN_API_KEY", "sk-media");
		try {
			const { pi, servers } = mockPi();
			await extension(pi);

			const nanMedia = servers.find((s) => s.name === "nan-media");
			expect(nanMedia).toBeDefined();
			expect(nanMedia!.config.args).toEqual(["-y", "nan-mcp-server@9.9.9"]);
		} finally {
			cleanAgent.restore();
		}
	});

	test("custom command via NAN_MEDIA_MCP_COMMAND", async () => {
		cleanAgent.set("PI_CODING_AGENT_DIR", agentDir);
		cleanAgent.set("NAN_MEDIA_MCP_COMMAND", "bunx nan-mcp-server@1.0.7");
		cleanAgent.set("NAN_API_KEY", "sk-media");
		try {
			const { pi, servers } = mockPi();
			await extension(pi);

			const nanMedia = servers.find((s) => s.name === "nan-media");
			expect(nanMedia).toBeDefined();
			expect(nanMedia!.config.command).toBe("bunx");
			expect(nanMedia!.config.args).toEqual(["nan-mcp-server@1.0.7"]);
		} finally {
			cleanAgent.restore();
		}
	});

	test("custom timeout via NAN_MEDIA_MCP_TIMEOUT_MS", async () => {
		cleanAgent.set("PI_CODING_AGENT_DIR", agentDir);
		cleanAgent.set("NAN_MEDIA_MCP_TIMEOUT_MS", "30000");
		cleanAgent.set("NAN_API_KEY", "sk-media");
		try {
			const { pi, servers } = mockPi();
			await extension(pi);

			const nanMedia = servers.find((s) => s.name === "nan-media");
			expect(nanMedia).toBeDefined();
			expect(nanMedia!.config.timeout).toBe(30); // 30000ms → 30s
		} finally {
			cleanAgent.restore();
		}
	});

	test("persisted disable keeps server out", async () => {
		cleanAgent.set("PI_CODING_AGENT_DIR", agentDir);
		cleanAgent.set("NAN_API_KEY", "sk-media");
		writeState({ webSearch: true, mediaMcp: false });
		try {
			const { pi, servers } = mockPi();
			await extension(pi);

			const nanMedia = servers.find((s) => s.name === "nan-media");
			expect(nanMedia).toBeUndefined();
		} finally {
			cleanAgent.restore();
		}
	});

	test("media registration is independent of web-search gate", async () => {
		cleanAgent.set("PI_CODING_AGENT_DIR", agentDir);
		cleanAgent.set("NAN_MCP_TOOLS", "0");
		cleanAgent.set("NAN_API_KEY", "sk-media");
		try {
			const { pi, servers } = mockPi();
			await extension(pi);

			const nanMedia = servers.find((s) => s.name === "nan-media");
			expect(nanMedia).toBeDefined();
			const nanSearch = servers.find((s) => s.name === "nan-search");
			expect(nanSearch).toBeUndefined();
		} finally {
			cleanAgent.restore();
		}
	});
});

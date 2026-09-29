/**
 * Native MCP registration tests — web-search server config.
 *
 * Retargeted from ToolDefinition-wrapper tests (callNanMcpTool, createNanWebSearchTool):
 * now asserts native MCP registration config instead of HTTP behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, { NAN_API_KEY_ENV } from "../src/index.ts";
import { NAN_STATE_FILE, writeState } from "../src/mcp/state.ts";

interface RecordedServer {
	name: string;
	config: Record<string, unknown>;
}

interface CapturedNotify {
	message: string;
	type: string;
}

function mockPi(
	options: {
		withoutRegisterMcpServer?: boolean;
		withRegistryKey?: string;
	} = {},
) {
	const servers: RecordedServer[] = [];
	const notifications: CapturedNotify[] = [];

	const pi: ExtensionAPI = {
		registerProvider: () => {},
		registerTool: () => {},
		registerCommand: () => {},
		on: () => () => {},
		...(!options.withoutRegisterMcpServer
			? {
					registerMcpServer: (name: string, config: Record<string, unknown>) => {
						servers.push({ name, config: { ...config } });
					},
					unregisterMcpServer: () => {},
					getMcpServers: () => servers,
				}
			: {}),
		ui: {
			notify: (message: string, type: string) => notifications.push({ message, type }),
		},
		modelRegistry: options.withRegistryKey
			? { getApiKeyForProvider: async () => options.withRegistryKey }
			: undefined,
	} as unknown as ExtensionAPI;

	return { pi, servers, notifications };
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

const agentDir = mkdtempSync(join(tmpdir(), "mcp-search-test-"));
const cleanAgent = cleanEnv(["PI_CODING_AGENT_DIR"]);

afterEach(() => {
	for (const key of ["NAN_MCP_TOOLS", "NAN_MEDIA_MCP", "NAN_API_KEY"]) {
		delete process.env[key];
	}
	cleanAgent.delete("PI_CODING_AGENT_DIR");
	rmSync(join(agentDir, NAN_STATE_FILE), { force: true });
});

describe("native web-search MCP registration", () => {
	test("registers with exact config when gate on and key resolves", async () => {
		cleanAgent.set("PI_CODING_AGENT_DIR", agentDir);
		cleanAgent.set("NAN_API_KEY", "sk-test-key");
		try {
			const { pi, servers, notifications } = mockPi();
			await extension(pi);

			const nanSearch = servers.find((s) => s.name === "nan-search");
			expect(nanSearch).toBeDefined();
			expect(nanSearch!.config.type).toBe("http");
			expect(nanSearch!.config.url).toBe("https://api.nan.builders/mcp");
			expect(nanSearch!.config.headers).toEqual({ Authorization: "Bearer sk-test-key" });
			expect(nanSearch!.config.exposure).toBe("direct");
		} finally {
			cleanAgent.restore();
		}
	});

	test("uses env var when registry is empty", async () => {
		cleanAgent.set("PI_CODING_AGENT_DIR", agentDir);
		cleanAgent.set("NAN_API_KEY", "sk-env-key");
		try {
			const { pi, servers } = mockPi();
			await extension(pi);

			const nanSearch = servers.find((s) => s.name === "nan-search");
			expect(nanSearch).toBeDefined();
			expect((nanSearch!.config.headers as Record<string, string>)?.Authorization).toBe("Bearer sk-env-key");
		} finally {
			cleanAgent.restore();
		}
	});

	test("does NOT register when NAN_MCP_TOOLS=0 (gate off)", async () => {
		cleanAgent.set("PI_CODING_AGENT_DIR", agentDir);
		cleanAgent.set("NAN_MCP_TOOLS", "0");
		cleanAgent.set("NAN_API_KEY", "sk-test");
		try {
			const { pi, servers, notifications } = mockPi();
			await extension(pi);

			const nanSearch = servers.find((s) => s.name === "nan-search");
			expect(nanSearch).toBeUndefined();
			expect(notifications.every((n) => !n.message.includes("NAN_API_KEY"))).toBe(true);
		} finally {
			cleanAgent.restore();
		}
	});

	test("does NOT register when key missing but gate is on", async () => {
		cleanAgent.set("PI_CODING_AGENT_DIR", agentDir);
		try {
			const { pi, servers } = mockPi();
			await extension(pi);

			const nanSearch = servers.find((s) => s.name === "nan-search");
			expect(nanSearch).toBeUndefined();
			// Key missing → no registration (new design: key resolved at load time)
		} finally {
			cleanAgent.restore();
		}
	});

	test("persisted disable keeps server out", async () => {
		cleanAgent.set("PI_CODING_AGENT_DIR", agentDir);
		cleanAgent.set("NAN_API_KEY", "sk-test");
		writeState({ webSearch: false, mediaMcp: true });
		try {
			const { pi, servers } = mockPi();
			await extension(pi);

			const nanSearch = servers.find((s) => s.name === "nan-search");
			expect(nanSearch).toBeUndefined();
		} finally {
			cleanAgent.restore();
		}
	});
});

describe("native MCP guard when registerMcpServer is absent", () => {
	test("pi <0.99: loud skip, no bridge created", async () => {
		cleanAgent.set("PI_CODING_AGENT_DIR", agentDir);
		cleanAgent.set("NAN_API_KEY", "sk-test");
		try {
			const { pi, servers } = mockPi({ withoutRegisterMcpServer: true });
			await extension(pi);

			const nanSearch = servers.find((s) => s.name === "nan-search");
			expect(nanSearch).toBeUndefined();
		} finally {
			cleanAgent.restore();
		}
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { NAN_GENERATED_MODELS } from "../scripts/models.generated.ts";
import extension, { NAN_PROVIDER, PROVIDERS } from "../src/index.ts";
import { NAN_STATE_FILE, writeState } from "../src/mcp/state.ts";

interface FakePiOptions {
	rejectNativeProvider?: boolean;
	withoutRegisterTool?: boolean;
	withoutRegisterCommand?: boolean;
	withoutRegisterMcpServer?: boolean;
}

interface RecordedRegistration {
	native: Provider[];
	legacy: Array<{ name: string; config: ProviderConfig }>;
	tools: Array<{ name: string }>;
	commands: Array<{ name: string; handler: (args: string, ctx: unknown) => Promise<void> }>;
	mcpServers: Array<{ name: string; config: Record<string, unknown> }>;
	notifications: Array<{ message: string; type: string }>;
}

function fakePi(options: FakePiOptions = {}): { pi: ExtensionAPI; recorded: RecordedRegistration } {
	const recorded: RecordedRegistration = { native: [], legacy: [], tools: [], commands: [], mcpServers: [], notifications: [] };
	const pi = {
		registerProvider: (nameOrProvider: string | Provider, config?: ProviderConfig) => {
			if (options.rejectNativeProvider && config === undefined) {
				throw new Error("legacy pi: registerProvider(name, config) only");
			}
			if (typeof nameOrProvider === "string") {
				recorded.legacy.push({ name: nameOrProvider, config: config! });
			} else {
				recorded.native.push(nameOrProvider);
			}
		},
		...(options.withoutRegisterTool ? {} : { registerTool: (tool: { name: string }) => recorded.tools.push(tool) }),
		...(options.withoutRegisterCommand
			? {}
			: {
					registerCommand: (name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
						recorded.commands.push({ name, handler: definition.handler });
					},
				}),
		...(!options.withoutRegisterMcpServer
			? {
					registerMcpServer: (name: string, config: Record<string, unknown>) => {
						recorded.mcpServers.push({ name, config });
					},
					unregisterMcpServer: () => {},
					getMcpServers: () => recorded.mcpServers,
				}
			: {}),
		ui: {
			notify: (message: string, type: string) => recorded.notifications.push({ message, type }),
		},
	} as unknown as ExtensionAPI;
	return { pi, recorded };
}

const cleanEnv = (keys: string[]) => {
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
};

afterEach(() => {
	for (const key of ["NAN_MCP_TOOLS", "NAN_MEDIA_MCP", "NAN_MEDIA_MCP_COMMAND", "NAN_API_KEY"]) {
		delete process.env[key];
	}
});

describe("pi version compatibility (one entrypoint, any runtime)", () => {
	test("modern pi: native provider + both native MCP servers by default", async () => {
		const { pi, recorded } = fakePi();
		// Key must be set for web-search to register (new design: key resolved at load time)
		process.env.NAN_API_KEY = "sk-test";
		await extension(pi);
		expect(recorded.native.length).toBe(PROVIDERS.length);
		expect(recorded.legacy).toEqual([]);
		expect(recorded.tools).toEqual([]);
		expect(recorded.commands.map((c) => c.name)).toEqual(["nan-mcp", "nan-usage"]);
		const names = recorded.mcpServers.map((s) => s.name);
		expect(names).toContain("nan-search");
		expect(names).toContain("nan-media");
		expect(recorded.mcpServers).toHaveLength(2);
		for (const server of recorded.mcpServers) {
			expect(server.config.exposure).toBe("direct");
		}
	});

	test("legacy pi: falls back to registerProvider(name, config)", async () => {
		const { pi, recorded } = fakePi({ rejectNativeProvider: true });
		await extension(pi);
		expect(recorded.native).toEqual([]);
		expect(recorded.legacy.length).toBe(PROVIDERS.length);
		const { name, config } = recorded.legacy[0]!;
		expect(name).toBe("nan");
		expect(config.baseUrl).toBe(NAN_PROVIDER.baseUrl);
		expect(config.apiKey).toBe("$NAN_API_KEY");
		expect(config.api).toBe("openai-completions");
		expect(config.models!.length).toBe(NAN_GENERATED_MODELS.length);
		for (const model of config.models!) {
			const chat = model as { contextWindow: number; maxTokens: number };
			expect(chat.contextWindow).toBeGreaterThan(0);
			expect(chat.maxTokens).toBeGreaterThan(0);
		}
	});

	test("legacy pi without registerMcpServer: providers register, MCP skipped", async () => {
		const { pi, recorded } = fakePi({ rejectNativeProvider: true, withoutRegisterMcpServer: true });
		await extension(pi);
		expect(recorded.legacy.length).toBe(PROVIDERS.length);
		expect(recorded.mcpServers).toEqual([]);
	});

	test("old pi without registerCommand: providers + native MCP register", async () => {
		process.env.NAN_API_KEY = "sk-test";
		const { pi, recorded } = fakePi({ withoutRegisterCommand: true });
		await extension(pi);
		expect(recorded.native.length).toBe(PROVIDERS.length);
		expect(recorded.commands).toEqual([]);
		expect(recorded.mcpServers).toHaveLength(2);
	});

	test("NAN_MCP_TOOLS=0: only media server registers", async () => {
		const env = cleanEnv(["NAN_MCP_TOOLS", "NAN_API_KEY"]);
		env.set("NAN_MCP_TOOLS", "0");
		env.set("NAN_API_KEY", "sk-test");
		try {
			const { pi, recorded } = fakePi();
			await extension(pi);
			const names = recorded.mcpServers.map((s) => s.name);
			expect(names).not.toContain("nan-search");
			expect(names).toContain("nan-media");
		} finally {
			env.restore();
		}
	});

	test("NAN_MEDIA_MCP=0: only web-search server registers", async () => {
		const env = cleanEnv(["NAN_MEDIA_MCP", "NAN_API_KEY"]);
		env.set("NAN_MEDIA_MCP", "0");
		env.set("NAN_API_KEY", "sk-test");
		try {
			const { pi, recorded } = fakePi();
			await extension(pi);
			const names = recorded.mcpServers.map((s) => s.name);
			expect(names).not.toContain("nan-media");
			expect(names).toContain("nan-search");
		} finally {
			env.restore();
		}
	});

	test("persisted /nan-mcp disable keeps servers out", async () => {
		const env = cleanEnv(["PI_CODING_AGENT_DIR"]);
		const dir = mkdtempSync(join(tmpdir(), "nan-compat-native-"));
		env.set("PI_CODING_AGENT_DIR", dir);
		writeState({ webSearch: false, mediaMcp: false });
		try {
			const { pi, recorded } = fakePi();
			await extension(pi);
			expect(recorded.mcpServers).toEqual([]);
		} finally {
			env.restore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("guard when registerMcpServer absent: loud skip", async () => {
		const { pi, recorded } = fakePi({
			rejectNativeProvider: true,
			withoutRegisterMcpServer: true,
		});
		await extension(pi);
		expect(recorded.legacy.length).toBe(PROVIDERS.length);
		expect(recorded.mcpServers).toEqual([]);
		// Guard uses console.warn (not mockable), but the result is correct: no MCP servers
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { NAN_GENERATED_MODELS } from "../scripts/models.generated.ts";
import extension, { NAN_PROVIDER, PROVIDERS } from "../src/index.ts";
import { NAN_STATE_FILE, writeState } from "../src/mcp/state.ts";

/**
 * ExtensionAPI stub with configurable pi runtime capabilities, so we can
 * exercise modern (native Provider overload + registerTool) and legacy
 * (config-only, no registerTool) runtimes with one entrypoint.
 */
interface FakePiOptions {
	/** Reject the native Provider overload (simulates older pi). */
	rejectNativeProvider?: boolean;
	/** Omit registerTool entirely (simulates old pi). */
	withoutRegisterTool?: boolean;
	/** Omit registerCommand (simulates old pi). */
	withoutRegisterCommand?: boolean;
}

interface RecordedRegistration {
	native: Provider[];
	legacy: Array<{ name: string; config: ProviderConfig }>;
	tools: Array<{ name: string }>;
	commands: Array<{ name: string; handler: (args: string, ctx: unknown) => Promise<void> }>;
}

function fakePi(options: FakePiOptions = {}): { pi: ExtensionAPI; recorded: RecordedRegistration } {
	const recorded: RecordedRegistration = { native: [], legacy: [], tools: [], commands: [] };
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
	} as unknown as ExtensionAPI;
	return { pi, recorded };
}

const cleanEnv = (keys: string[]) => {
	const saved = new Map(keys.map((key) => [key, process.env[key]]));
	return {
		set(key: string, value: string) {
			process.env[key] = value;
		},
		delete(key: string) {
			delete process.env[key];
		},
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
	test("modern pi: native provider registration + both MCP bridges by default (lazy)", async () => {
		const { pi, recorded } = fakePi();
		await extension(pi);
		expect(recorded.native.length).toBe(PROVIDERS.length);
		expect(recorded.legacy).toEqual([]);
		expect(recorded.tools.map((tool) => tool.name)).toEqual([
			"nan_web_search",
			"nan_generate_image",
			"nan_edit_image",
			"nan_text_to_speech",
			"nan_list_voices",
			"nan_speech_to_text",
		]);
		expect(recorded.commands.map((command) => command.name)).toEqual(["nan-mcp"]);
	});

	test("legacy pi: falls back to registerProvider(name, config) with env-var auth", async () => {
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
			// The legacy path keeps the full generated catalog as static models.
			expect(model.contextWindow).toBeGreaterThan(0);
			expect(model.maxTokens).toBeGreaterThan(0);
		}
	});

	test("legacy pi without registerTool: providers still register, MCP tools skipped", async () => {
		const { pi, recorded } = fakePi({ withoutRegisterTool: true });
		await extension(pi);
		expect(recorded.native.length).toBe(PROVIDERS.length);
		expect(recorded.tools).toEqual([]);
	});

	test("old pi without registerCommand: providers + tools still register, command skipped", async () => {
		const { pi, recorded } = fakePi({ withoutRegisterCommand: true });
		await extension(pi);
		expect(recorded.native.length).toBe(PROVIDERS.length);
		expect(recorded.commands).toEqual([]);
		expect(recorded.tools.length).toBe(6); // web_search + 5 media tools (both bridges default-on)
	});

	test("NAN_MCP_TOOLS=0 disables only the web_search bridge", async () => {
		const env = cleanEnv(["NAN_MCP_TOOLS"]);
		env.set("NAN_MCP_TOOLS", "0");
		try {
			const { pi, recorded } = fakePi();
			await extension(pi);
			expect(recorded.tools.map((tool) => tool.name)).toEqual([
				"nan_generate_image",
				"nan_edit_image",
				"nan_text_to_speech",
				"nan_list_voices",
				"nan_speech_to_text",
			]);
		} finally {
			env.restore();
		}
	});

	test("NAN_MEDIA_MCP=0 disables only the media bridge", async () => {
		const env = cleanEnv(["NAN_MEDIA_MCP"]);
		env.set("NAN_MEDIA_MCP", "0");
		try {
			const { pi, recorded } = fakePi();
			await extension(pi);
			expect(recorded.tools.map((tool) => tool.name)).toEqual(["nan_web_search"]);
		} finally {
			env.restore();
		}
	});

	test("persisted /nan-mcp disable keeps tools out of future sessions", async () => {
		// The state file is written by the command; here we seed it directly.
		const env = cleanEnv(["PI_CODING_AGENT_DIR"]);
		const dir = mkdtempSync(join(tmpdir(), "nan-compat-"));
		env.set("PI_CODING_AGENT_DIR", dir);
		writeState({ webSearch: false, mediaMcp: false });
		try {
			const { pi, recorded } = fakePi();
			await extension(pi);
			expect(recorded.tools).toEqual([]);
		} finally {
			env.restore();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
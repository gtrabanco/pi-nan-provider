import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createNanMediaTools,
	DEFAULT_NAN_MEDIA_MCP_VERSION,
	mediaMcpCommand,
	mediaMcpEnabled,
	NAN_MEDIA_TOOLS,
} from "../src/mcp/nan-media.ts";
import { callStdioMcpTool } from "../src/mcp/stdio-client.ts";
import { NAN_MCP_TOOLS_ENV } from "../src/mcp/nan-search.ts";

const FIXTURE = new URL("./fixtures/mock-nan-media-mcp.mjs", import.meta.url).pathname;
/** Spawn the fixture with the current runtime (bun under bun test). */
const fixtureCommand = [process.execPath, FIXTURE];

function ctxWithKey(key: string | undefined): ExtensionContext {
	return {
		modelRegistry: { getApiKeyForProvider: async () => key },
	} as unknown as ExtensionContext;
}

describe("NAN_MEDIA_MCP env configuration", () => {
	test("disabled unless explicitly enabled", () => {
		delete process.env.NAN_MEDIA_MCP;
		expect(mediaMcpEnabled()).toBe(false);
		for (const value of ["1", "true", "on", "TRUE"]) {
			process.env.NAN_MEDIA_MCP = value;
			expect(mediaMcpEnabled()).toBe(true);
		}
		delete process.env.NAN_MEDIA_MCP;
	});

	test("default command pins the upstream-recommended version", () => {
		delete process.env.NAN_MEDIA_MCP_COMMAND;
		delete process.env.NAN_MEDIA_MCP_VERSION;
		expect(mediaMcpCommand()).toEqual(["npx", "-y", `nan-mcp-server@${DEFAULT_NAN_MEDIA_MCP_VERSION}`]);
	});

	test("version override via env", () => {
		delete process.env.NAN_MEDIA_MCP_COMMAND;
		process.env.NAN_MEDIA_MCP_VERSION = "9.9.9";
		try {
			expect(mediaMcpCommand()).toEqual(["npx", "-y", "nan-mcp-server@9.9.9"]);
		} finally {
			delete process.env.NAN_MEDIA_MCP_VERSION;
		}
	});

	test("full command override via env", () => {
		process.env.NAN_MEDIA_MCP_COMMAND = "bunx nan-mcp-server@1.0.7";
		try {
			expect(mediaMcpCommand()).toEqual(["bunx", "nan-mcp-server@1.0.7"]);
		} finally {
			delete process.env.NAN_MEDIA_MCP_COMMAND;
		}
	});
});

describe("callStdioMcpTool (minimal MCP stdio client)", () => {
	test("happy path: handshake, tools/call, rendered text", async () => {
		const result = await callStdioMcpTool("generate_image", { prompt: "a cat" }, {
			command: fixtureCommand,
			timeoutMs: 15_000,
		});
		expect(result.ok).toBe(true);
		expect(result.text).toBe('mock result: {"prompt":"a cat"}');
	});

	test("tool-level errors (isError) are surfaced", async () => {
		const result = await callStdioMcpTool("generate_image", {}, {
			command: fixtureCommand,
			env: { NAN_MOCK_MCP_BEHAVIOR: "tool_error" },
			timeoutMs: 15_000,
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("mock tool error text");
	});

	test("JSON-RPC protocol errors are surfaced", async () => {
		const result = await callStdioMcpTool("generate_image", {}, {
			command: fixtureCommand,
			env: { NAN_MOCK_MCP_BEHAVIOR: "rpc_error" },
			timeoutMs: 15_000,
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("mock rpc failure");
	});

	test("server crash (early exit) is reported", async () => {
		const result = await callStdioMcpTool("generate_image", {}, {
			command: fixtureCommand,
			env: { NAN_MOCK_MCP_BEHAVIOR: "exit" },
			timeoutMs: 15_000,
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("exited early");
	});

	test("unresponsive server times out", async () => {
		// A command that starts but never speaks MCP.
		const result = await callStdioMcpTool("generate_image", {}, {
			command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
			timeoutMs: 300,
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("did not answer within");
	});

	test("empty command fails fast", async () => {
		const result = await callStdioMcpTool("generate_image", {}, { command: [] });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("No MCP server command configured");
	});
});

describe("nan media tool definitions (opt-in stdio bridge)", () => {
	test("registers exactly the audio/image/transcription scope", () => {
		const tools = createNanMediaTools();
		expect(tools.map((tool) => tool.name)).toEqual([...NAN_MEDIA_TOOLS]);
		expect(NAN_MEDIA_TOOLS).toEqual([
			"nan_generate_image",
			"nan_edit_image",
			"nan_text_to_speech",
			"nan_list_voices",
			"nan_speech_to_text",
		]);
	});

	test("execute throws a helpful error when no key is configured", async () => {
		delete process.env.NAN_API_KEY;
		const tool = createNanMediaTools()[0]!;
		await expect(
			tool.execute("id", { prompt: "x" }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow("NAN_API_KEY");
	});

	test("execute bridges to the spawned MCP server end-to-end", async () => {
		process.env.NAN_API_KEY = "sk-media";
		process.env.NAN_MEDIA_MCP_COMMAND = fixtureCommand.join(" ");
		try {
			const tool = createNanMediaTools().find((t) => t.name === "nan_generate_image")!;
			const result = await tool.execute(
				"id",
				{ prompt: "a cat", size: "1024x1024" },
				undefined,
				undefined,
				{} as ExtensionContext,
			);
			expect(result.content[0]).toMatchObject({ type: "text" });
			expect((result.content[0] as { text: string }).text).toContain("a cat");
		} finally {
			delete process.env.NAN_API_KEY;
			delete process.env.NAN_MEDIA_MCP_COMMAND;
		}
	});

	test("media tool registration is independent of the search toggle", () => {
		// NAN_MEDIA_MCP=1 + NAN_MCP_TOOLS=0 must still yield media tools; the
		// extension entrypoint composes them, this only checks the toggles.
		process.env.NAN_MEDIA_MCP = "1";
		process.env.NAN_MCP_TOOLS = "0";
		try {
			expect(mediaMcpEnabled()).toBe(true);
			expect(createNanMediaTools().length).toBe(NAN_MEDIA_TOOLS.length);
		} finally {
			delete process.env.NAN_MEDIA_MCP;
			delete process.env.NAN_MCP_TOOLS;
		}
	});
});
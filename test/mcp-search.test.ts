import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	callNanMcpTool,
	createNanWebSearchTool,
	mcpToolsDisabled,
	NAN_MCP_URL,
	resolveNanApiKey,
} from "../src/mcp/nan-search.ts";

function jsonFetch(body: unknown, status = 200): typeof fetch {
	return (async () =>
		new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
}

function mcpPayload(overrides: Record<string, unknown> = {}) {
	return {
		jsonrpc: "2.0",
		id: 1,
		result: {
			content: [{ type: "text", text: "result one" }, { type: "text", text: "result two" }],
			...overrides,
		},
	};
}

/** Fetch stub capturing the JSON-RPC request for assertions. */
function capturingJsonFetch(body: unknown, status = 200): { fetch: typeof fetch; bodies: string[]; headers: Record<string, string>[] } {
	const bodies: string[] = [];
	const headers: Record<string, string>[] = [];
	const stub = (async (input: unknown, init?: RequestInit) => {
		bodies.push(String(init?.body));
		headers.push(init?.headers as Record<string, string>);
		return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
	}) as unknown as typeof fetch;
	return { fetch: stub, bodies, headers };
}

function hangingFetch(): typeof fetch {
	return ((_input: unknown, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new Error("Aborted")));
		})) as unknown as typeof fetch;
}

describe("resolveNanApiKey", () => {
	test("stored credential (registry) wins over env var", async () => {
		process.env.NAN_API_KEY = "env-key";
		try {
			const key = await resolveNanApiKey({
				modelRegistry: { getApiKeyForProvider: async () => "stored-key" },
			});
			expect(key).toBe("stored-key");
		} finally {
			delete process.env.NAN_API_KEY;
		}
	});

	test("env var is used when the registry yields nothing", async () => {
		process.env.NAN_API_KEY = "env-key";
		try {
			const key = await resolveNanApiKey({});
			expect(key).toBe("env-key");
		} finally {
			delete process.env.NAN_API_KEY;
		}
	});

	test("registry errors degrade to the env fallback", async () => {
		process.env.NAN_API_KEY = "env-key";
		try {
			const key = await resolveNanApiKey({
				modelRegistry: {
					getApiKeyForProvider: async () => {
						throw new Error("boom");
					},
				},
			});
			expect(key).toBe("env-key");
		} finally {
			delete process.env.NAN_API_KEY;
		}
	});

	test("undefined when nothing is configured", async () => {
		delete process.env.NAN_API_KEY;
		const key = await resolveNanApiKey({});
		expect(key).toBeUndefined();
	});
});

describe("callNanMcpTool (official remote MCP bridge)", () => {
	test("posts a JSON-RPC tools/call with bearer auth to the MCP endpoint", async () => {
		const { fetch: stub, bodies, headers } = capturingJsonFetch(mcpPayload());
		const result = await callNanMcpTool("web_search", { query: "kubernetes" }, { apiKey: "sk-test", fetchImpl: stub });
		expect(result.ok).toBe(true);
		expect(result.text).toBe("result one\n\nresult two");
		const body = JSON.parse(bodies[0]!) as { method: string; params: { name: string; arguments: Record<string, unknown> } };
		expect(body.method).toBe("tools/call");
		expect(body.params.name).toBe("web_search");
		expect(body.params.arguments).toEqual({ query: "kubernetes" });
		expect(headers[0]!.Authorization).toBe("Bearer sk-test");
	});

	test("missing api key short-circuits without a network call", async () => {
		let called = false;
		const result = await callNanMcpTool("web_search", {}, {
			fetchImpl: (async () => {
				throw new Error("should not be called");
			}) as unknown as typeof fetch,
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("NAN_API_KEY");
		expect(result.error).toContain("/login nan");
	});

	test("HTTP 401 reports the auth problem", async () => {
		const result = await callNanMcpTool("web_search", { query: "x" }, {
			apiKey: "sk-bad",
			fetchImpl: jsonFetch({ error: {} }, 401),
		});
		expect(result.ok).toBe(false);
		expect(result.error ?? "").toContain("401");
		expect(result.error ?? "").toContain("NaN API key");
	});

	test("JSON-RPC protocol errors are surfaced", async () => {
		const result = await callNanMcpTool("web_search", { query: "x" }, {
			apiKey: "sk-test",
			fetchImpl: jsonFetch({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "quota exceeded" } }),
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("quota exceeded");
	});

	test("tool-level errors (result.isError) are surfaced with the tool text", async () => {
		const result = await callNanMcpTool("web_search", { query: "x" }, {
			apiKey: "sk-test",
			fetchImpl: jsonFetch(mcpPayload({ isError: true })),
		});
		expect(result.ok).toBe(false);
		expect(result.text).toContain("result one");
	});

	test("timeout aborts the call and reports the timeout", async () => {
		const result = await callNanMcpTool("web_search", { query: "x" }, {
			apiKey: "sk-test",
			timeoutMs: 25,
			fetchImpl: hangingFetch(),
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("timed out");
	});
});

describe("nan_web_search tool definition", () => {
	test("execute throws a helpful error when no key is configured", async () => {
		delete process.env.NAN_API_KEY;
		const tool = createNanWebSearchTool();
		expect(tool.name).toBe("nan_web_search");
		const ctx = {} as ExtensionContext;
		await expect(
			tool.execute("id", { query: "x" }, undefined, undefined, ctx),
		).rejects.toThrow("NAN_API_KEY");
	});

	test("execute returns the flattened MCP text on success", async () => {
		process.env.NAN_API_KEY = "sk-test";
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(mcpPayload()), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
		try {
			const tool = createNanWebSearchTool();
			const result = await tool.execute(
				"id",
				{ query: "kubernetes", count: 5 },
				undefined,
				undefined,
				{} as ExtensionContext,
			);
			expect(result.content[0]).toEqual({ type: "text", text: "result one\n\nresult two" });
		} finally {
			globalThis.fetch = originalFetch;
			delete process.env.NAN_API_KEY;
		}
	});

	test("execute uses the stored credential when env is unset", async () => {
		delete process.env.NAN_API_KEY;
		const tool = createNanWebSearchTool();
		const ctx = {
			modelRegistry: { getApiKeyForProvider: async () => "stored-key" },
		} as unknown as ExtensionContext;
		const originalFetch = globalThis.fetch;
		let usedKey = "";
		globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
			usedKey = (init?.headers as Record<string, string | undefined>).Authorization ?? "";
			return new Response(JSON.stringify(mcpPayload()), { status: 200 });
		}) as unknown as typeof fetch;
		try {
			const result = await tool.execute("id", { query: "x" }, undefined, undefined, ctx);
			expect(usedKey).toBe("Bearer stored-key");
			expect(result.content[0]).toMatchObject({ type: "text" });
		} finally {
			globalThis.fetch = originalFetch;
			delete process.env.NAN_API_KEY;
		}
	});
});

describe("NAN_MCP_TOOLS env toggle", () => {
	test("disabled for 0/false/off", () => {
		for (const value of ["0", "false", "off", "OFF"]) {
			process.env.NAN_MCP_TOOLS = value;
			expect(mcpToolsDisabled()).toBe(true);
		}
		delete process.env.NAN_MCP_TOOLS;
		expect(mcpToolsDisabled()).toBe(false);
	});
});
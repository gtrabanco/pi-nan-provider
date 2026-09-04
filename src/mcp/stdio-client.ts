/**
 * Minimal MCP (Model Context Protocol) stdio client — just enough protocol to
 * call one tool per spawned process, so bridging stdio MCP servers is lazy by
 * construction: nothing starts, connects, or costs anything until a tool is
 * actually invoked.
 *
 * Protocol: JSON-RPC 2.0 over the child's stdin/stdout, one message per line
 * (MCP stdio transport). Handshake: `initialize` request → `initialized`
 * notification → request. The child process is terminated after the call, so
 * each invocation pays a fresh spawn (~npx overhead on first use, cached
 * afterwards) in exchange for zero idle cost and no daemon management.
 */

import { spawn } from "node:child_process";

/** Oldest stable protocol version; accepted by every MCP SDK server. */
const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "pi-nan-provider", version: "0.2.0" };

export interface StdioMcpCallOptions {
	/** Command to spawn, e.g. ["npx", "-y", "nan-mcp-server@1.0.7"]. */
	command: readonly string[];
	/** Extra environment for the child (merged over process.env). */
	env?: Record<string, string | undefined>;
	/** Kill the child and fail the call after this long. */
	timeoutMs?: number;
	/** Cooperative cancellation from the host tool call. */
	signal?: AbortSignal;
	/** Working directory for the child. */
	cwd?: string;
}

export interface StdioMcpToolResult {
	/** true when the tool call completed without a tool-level or transport error. */
	ok: boolean;
	/** Concatenated text content returned by the tool. */
	text: string;
	/** Error description when ok is false. */
	error?: string;
	/** Server stderr tail, attached to failures for diagnosis. */
	stderrTail?: string;
}

interface JsonRpcMessage {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: unknown;
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
		tools?: unknown[];
	};
	error?: { code?: number; message?: string };
}

function renderContent(result: JsonRpcMessage["result"]): string {
	const parts: string[] = [];
	for (const item of result?.content ?? []) {
		if (item?.type === "text" && typeof item.text === "string") {
			parts.push(item.text);
		} else if (item?.type === "image") {
			parts.push("[image returned by tool]");
		}
	}
	return parts.join("\n\n");
}

/**
 * Spawn the MCP server, run the handshake, call one tool, and terminate the
 * process. Never throws — every failure mode resolves to
 * `{ ok: false, error }` so callers can decide how to surface it.
 */
export async function callStdioMcpTool(
	toolName: string,
	toolArguments: Record<string, unknown> | undefined,
	options: StdioMcpCallOptions,
): Promise<StdioMcpToolResult> {
	const { command, env, timeoutMs = 120_000, signal, cwd } = options;

	if (command.length === 0) {
		return { ok: false, text: "", error: "No MCP server command configured" };
	}

	return new Promise<StdioMcpToolResult>((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command[0]!, command.slice(1), {
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, ...env },
				...(cwd ? { cwd } : {}),
			});
		} catch (error) {
			resolve({
				ok: false,
				text: "",
				error: `Failed to start MCP server: ${error instanceof Error ? error.message : String(error)}`,
			});
			return;
		}

		let settled = false;
		let stdoutBuffer = "";
		let stderr = "";
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		let lastResponse: JsonRpcMessage | undefined;

		const cleanup = () => {
			if (timeoutId !== undefined) clearTimeout(timeoutId);
			if (signal) signal.removeEventListener("abort", onAbort);
			try {
				child.stdin?.end();
			} catch {
				// stdin already closed
			}
			if (!child.killed) {
				child.kill("SIGTERM");
			}
			// Escalate if the server ignores SIGTERM.
			const escalate = setTimeout(() => child.kill("SIGKILL"), 1_000);
			child.once("exit", () => clearTimeout(escalate));
		};

		const finish = (result: StdioMcpToolResult) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};

		const onAbort = () => finish({ ok: false, text: "", error: "MCP tool call aborted" });
		signal?.addEventListener("abort", onAbort, { once: true });

		const fail = (error: string): void => {
			finish({
				ok: false,
				text: "",
				error,
				...(stderr ? { stderrTail: stderr.split("\n").slice(-5).join("\n").slice(-500) } : {}),
			});
		};

		timeoutId = setTimeout(() => {
			fail(`MCP server did not answer within ${timeoutMs}ms`);
		}, timeoutMs);

		const send = (message: object) => {
			child.stdin?.write(`${JSON.stringify(message)}\n`);
		};

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdoutBuffer += chunk;
			let newlineIndex = stdoutBuffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = stdoutBuffer.slice(0, newlineIndex).trim();
				stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
				if (line.length > 0) {
					try {
						handleLine(JSON.parse(line) as JsonRpcMessage);
					} catch {
						// Non-JSON stdout line — tolerate server banners/logs.
					}
				}
				newlineIndex = stdoutBuffer.indexOf("\n");
			}
		});

		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
			if (stderr.length > 8_000) stderr = stderr.slice(-4_000);
		});

		child.once("error", (error) => {
			fail(`MCP server process error: ${error instanceof Error ? error.message : String(error)}`);
		});
		child.once("exit", (code, exitSignal) => {
			if (!settled) fail(`MCP server exited early (code=${code ?? "null"}, signal=${exitSignal ?? "null"})`);
		});

		const handleLine = (message: JsonRpcMessage) => {
			if (message.id === 1) {
				// initialize response → complete handshake, then call the tool.
				if (message.error) {
					fail(`MCP handshake failed: ${message.error.message ?? "unknown error"}`);
					return;
				}
				send({ jsonrpc: "2.0", method: "notifications/initialized" });
				send({
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: { name: toolName, arguments: toolArguments ?? {} },
				});
				return;
			}
			if (message.id === 2) {
				lastResponse = message;
				if (message.error) {
					fail(`MCP tool error ${message.error.code ?? ""}: ${message.error.message ?? "unknown"}`);
					return;
				}
				const text = renderContent(message.result);
				if (message.result?.isError) {
					finish({ ok: false, text, error: text || "MCP tool reported an error" });
					return;
				}
				finish({ ok: true, text: text || "(empty response)" });
			}
			// Other lines (notifications, keep-alives) are ignored.
		};

		// Handshake start.
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
		});
	});
}

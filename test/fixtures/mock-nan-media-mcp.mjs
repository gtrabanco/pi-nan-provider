// Minimal MCP stdio server used by tests to exercise the stdio client:
// speaks JSON-RPC over newline-delimited stdio, answers `initialize`, then
// completes `tools/call` with a deterministic result.
//
// Behavior via NAN_MOCK_MCP_BEHAVIOR:
//   (unset) | "ok"    -> initialize + normal tool result
//   "tool_error"      -> tools/call result with isError: true
//   "rpc_error"       -> tools/call JSON-RPC error response
//   "exit"            -> exits immediately after stdin opens (crash path)

import readline from "node:readline";

const behavior = process.env.NAN_MOCK_MCP_BEHAVIOR || "ok";

if (behavior === "exit") {
	process.exit(2);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return; // tolerate banners
	}

	if (message.method === "initialize" && message.id !== undefined) {
		process.stdout.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: "2024-11-05",
					capabilities: { tools: {} },
					serverInfo: { name: "mock-nan-media-mcp", version: "0.0.0" },
				},
			})}\n`,
		);
		return;
	}

	if (message.method === "tools/call" && message.id !== undefined) {
		if (behavior === "rpc_error") {
			process.stdout.write(
				`${JSON.stringify({
					jsonrpc: "2.0",
					id: message.id,
					error: { code: -32000, message: "mock rpc failure" },
				})}\n`,
			);
			return;
		}
		const isError = behavior === "tool_error";
		process.stdout.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					content: [{ type: "text", text: isError ? "mock tool error text" : `mock result: ${JSON.stringify(message.params?.arguments ?? {})}` }],
					...(isError ? { isError: true } : {}),
				},
			})}\n`,
		);
	}
});
/**
 * Host-side MCP connector detection plus the `session_start` guard that keeps
 * this package's registrations from tripping pi's cryptic extension error.
 *
 * pi connects servers registered with `pi.registerMcpServer()` from the
 * built-in `mcp` extension: it registers the `/mcp` command and handles
 * `mcp_servers_change`. When NO loaded extension handles that event, pi reports
 * every registration as an extension error right after the `session_start`
 * emit (`ExtensionRunner.reportUnhandledMcpServers()` called from
 * `AgentSession.bindExtensions()`):
 *
 *   MCP server "nan-media" is registered, but no loaded extension connects MCP
 *   servers; another extension may have replaced the built-in MCP support
 *
 * Hosts that build pi's `DefaultResourceLoader` without `extensionFactories`
 * load no `builtin:*` extension at all — including `builtin:mcp`. PI WEB does
 * exactly that (`createAgentSessionServices` → `new DefaultResourceLoader(...)`,
 * verified on pi 0.99.1 / pi-web 1.202609.1), so in every PI WEB session this
 * package's registrations are dead and pi reports the error above.
 *
 * Detection: the built-in MCP extension always registers `/mcp`, and pi's
 * replacement contract is phrased in the same terms ("an extension that
 * registers `/mcp` ... replaces the built-in one"). When `pi.getCommands()` is
 * unavailable (older pi, minimal mocks) the answer is unknowable, so we stay
 * conservative and assume a connector exists — pi's own behavior is untouched.
 *
 * With no connector we claim `mcp_servers_change` ourselves: handling the event
 * is pi's signal that somebody connects the servers, so its report stays silent
 * and our warning (with the fix) replaces the cryptic one. The claim is
 * released by a later `session_start` that finds a connector. Known trade-off:
 * while claimed, pi's report is silent for every extension's registration, not
 * only ours — that is the price of replacing an error we cannot scope, and our
 * warning still names the missing connector.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MCP_SERVER_NAMES } from "./state.ts";

/** Built-in MCP command; duplicate registrations resolve to `mcp:<n>`. */
const MCP_COMMAND_PATTERN = /^mcp(?::\d+)?$/;

/** Servers this package registers; only they are ours to explain or claim for. */
const OWNED_SERVER_NAMES: string[] = Object.values(MCP_SERVER_NAMES);

/**
 * Whether some loaded extension connects MCP servers.
 *
 * `true` whenever it cannot be determined (no `pi.getCommands()`), so callers
 * only ever act on a positively missing connector.
 */
export function hasMcpConnector(pi: ExtensionAPI): boolean {
	if (typeof pi.getCommands !== "function") return true;
	try {
		const commands = pi.getCommands();
		if (!Array.isArray(commands)) return true;
		return commands.some((command) => MCP_COMMAND_PATTERN.test(command?.name ?? ""));
	} catch {
		return true;
	}
}

/** Actionable explanation of a missing connector, naming the affected servers. */
export function connectorMissingMessage(serverNames: string[]): string {
	const names = serverNames.map((name) => `\`${name}\``).join(" and ");
	return (
		"MCP connector: MISSING — no loaded extension connects MCP servers in this session " +
		"(pi's built-in `/mcp` command is not loaded), so " +
		`${names} cannot expose tools. Load the built-in connector with \`pi config\` ` +
		"→ Built-in extensions → `mcp`; hosts that load no built-in extensions " +
		"(PI WEB sessions) have no MCP support at all."
	);
}

/**
 * Guard against pi's "registered, but no loaded extension connects MCP servers"
 * error. Registered from the extension entrypoint; see the module comment.
 */
export function registerMcpHostGuard(pi: ExtensionAPI): void {
	if (typeof pi.on !== "function") return; // old pi without event hooks
	let releaseClaim: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		releaseClaim?.();
		releaseClaim = undefined;
		const registered = typeof pi.getMcpServers === "function" ? pi.getMcpServers() : [];
		const owned = registered
			.map((server) => server.name)
			.filter((name) => OWNED_SERVER_NAMES.includes(name));
		// Nothing registered (pi <0.99 guard, gates off) → nothing to explain.
		if (owned.length === 0) return;
		if (hasMcpConnector(pi)) return;
		releaseClaim = pi.on("mcp_servers_change", () => {});
		ctx.ui.notify(connectorMissingMessage(owned), "warning");
	});
}

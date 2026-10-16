/**
 * `/nan-mcp` — slash command configuring the native MCP server this
 * package registers:
 *
 * - `nan-media` — the community stdio media server (flux-2-klein / kokoro /
 *   whisper), exposing `mcp__nan_media__generate_image` etc. Default: enabled.
 *   (pi 0.99.0–0.99.1 used the hyphenated form `mcp__nan-media__*`.)
 *
 * The server is session-scoped (visible in /mcp, source "extension").
 * /nan-mcp enables/disables it via pi.registerMcpServer / pi.unregisterMcpServer,
 * persisting the toggle in nan-provider.json.
 *
 * Target aliases: `nan-mcp-server` (`media`, `media-mcp`, `nan-media`).
 * Explicit env var (NAN_MEDIA_MCP) overrides the persisted toggle for the session.
 *
 * Native behavior:
 * - `disable` IMMEDIATELY hides tools (unregisterMcpServer disconnects the
 *   server; the MCP extension hides tools when disconnected).
 * - `enable` IMMEDIATELY registers the server for the current session.
 * - `status` reads the server state from pi.getMcpServers().
 * - Missing API key at load: server is NOT registered; guidance notification
 *   replaces the old "errors at call time" behavior.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mediaMcpCommand, mediaMcpEnabled, mediaMcpSource, mediaMcpEnvExplicit, mediaMcpEnvTruthy, mediaMcpTimeoutSec } from "./mcp/media-server.ts";
import { NAN_API_KEY_ENV, tryResolveNanApiKeyViaRegistry, resolveStoredNanApiKey } from "./mcp/api-key.ts";
import { NAN_STATE_FILE, MCP_SERVER_NAMES, readBridgeState, writeBridgeState, type BridgeKey, readState, writeState } from "./mcp/state.ts";
import { connectorMissingMessage, hasMcpConnector } from "./mcp/host-support.ts";

const USAGE =
	"Usage: /nan-mcp [status] · /nan-mcp enable [nan-mcp-server] · /nan-mcp disable [nan-mcp-server]";

/** Canonical bridge targets with aliases. */
const TARGETS: Record<string, BridgeKey> = {
	"nan-mcp-server": "mediaMcp",
	media: "mediaMcp",
	"media-mcp": "mediaMcp",
	"nan-media": "mediaMcp",
};

function envOverrideLabel(): string {
	return `env NAN_MEDIA_MCP=${process.env.NAN_MEDIA_MCP ?? ""} (overrides persisted)`;
}

function sourceLabel(source: "env" | "persisted" | "default"): string {
	if (source === "env") return envOverrideLabel();
	if (source === "persisted") {
		return `persisted in <agentDir>/${NAN_STATE_FILE} (nan-mcp-server: ${readBridgeState("mediaMcp")})`;
	}
	return "default (bridge is enabled by default)";
}

/** Check if a native server of this name is currently registered. */
function nativeServerRegistered(pi: ExtensionAPI, name: string): boolean {
	try {
		return pi.getMcpServers().some((s) => s.name === name);
	} catch {
		return false;
	}
}

/** Status message listing the media bridge gate state and native registration.
 * `ctx` is the command context (provides modelRegistry for key lookup).
 */
async function statusMessage(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<string> {
	const lines: string[] = [];

	if (!hasMcpConnector(pi)) {
		lines.push(connectorMissingMessage([MCP_SERVER_NAMES.mediaMcp]));
	}

	const enabled = mediaMcpEnabled();
	const source = mediaMcpSource();
	const regStatus = nativeServerRegistered(pi, MCP_SERVER_NAMES.mediaMcp) ? "registered (native)" : "not registered";
	lines.push(`nan-mcp-server bridge: ${enabled ? "enabled" : "disabled"} — ${sourceLabel(source)}, ${regStatus}.`);
	lines.push(`  Media spawn command: ${mediaMcpCommand().join(" ")}.`);
	lines.push(`  API key: ${await resolveKeyStatus(ctx)}.`);
	lines.push("Configure with /nan-mcp enable|disable [nan-mcp-server]; no target for the media server.");
	return lines.join("\n");
}

/** Check API key resolution status. */
async function resolveKeyStatus(ctx: ExtensionCommandContext): Promise<string> {
	const registryKey = await tryResolveNanApiKeyViaRegistry(ctx.modelRegistry);
	const storedKey = resolveStoredNanApiKey();
	const envKey = process.env[NAN_API_KEY_ENV];
	if (registryKey || storedKey || envKey) return "resolved";
	return "NOT SET — run /login nan or export NAN_API_KEY";
}

/** Parse an optional target argument; no target = media server. */
function parseTarget(token: string | undefined): string | undefined {
	if (token === undefined) return "mediaMcp";
	return TARGETS[token.toLowerCase()];
}

export function registerNanMcpCommand(pi: ExtensionAPI): void {
	pi.registerCommand("nan-mcp", {
		description:
			"NaN MCP configuration: enable/disable/status for the community media server",
		getArgumentCompletions: (argumentPrefix: string) => {
			const prefix = argumentPrefix.trim().toLowerCase();
			const items = [
				{ value: "enable", label: "enable", description: "Enable the media server and persist it" },
				{ value: "disable", label: "disable", description: "Disable the media server persistently" },
				{ value: "status", label: "status", description: "Show current server status and registration" },
				{ value: "enable nan-mcp-server", label: "enable nan-mcp-server", description: "Enable the community media server" },
			];
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const [rawSubcommand = "status", rawTarget, ...rest] = tokens;
			const subcommand = rawSubcommand.toLowerCase();

			if (subcommand === "status") {
				ctx.ui.notify(await statusMessage(pi, ctx), "info");
				return;
			}

			if (subcommand === "enable" || subcommand === "disable") {
				const parsed = parseTarget(rawTarget);
				if (parsed === undefined || rest.length > 0) {
					ctx.ui.notify(
						parsed === undefined
							? `Unknown target "${[rawTarget, ...rest].filter(Boolean).join(" ")}". Target: nan-mcp-server (or omit).`
							: USAGE,
						"warning",
					);
					return;
				}
				const enabled = subcommand === "enable";
				const where = rawTarget ? `for "${rawTarget.toLowerCase()}"` : "for the media server";

				writeBridgeState("mediaMcp", enabled);

				const persistence = `persisted in <agentDir>/${NAN_STATE_FILE}`;

				// Without an extension that handles `mcp_servers_change` pi cannot connect the
				// servers; registering would only trigger its "no loaded extension connects MCP
				// servers" error (see src/mcp/host-support.ts). The toggle above still persists,
				// so it applies as soon as a connector (built-in `mcp`) is available.
				if (enabled && !hasMcpConnector(pi)) {
					ctx.ui.notify(
						`Enabled ${where}, ${persistence} — NOT registered. ` +
							connectorMissingMessage([MCP_SERVER_NAMES.mediaMcp]),
						"warning",
					);
					return;
				}

				// Immediate native registration/unregistration.
				const name = MCP_SERVER_NAMES.mediaMcp;
				if (enabled) {
					if (mediaMcpEnabled()) {
						const registryKey = await tryResolveNanApiKeyViaRegistry(ctx.modelRegistry);
						const storedKey = resolveStoredNanApiKey();
						const apiKey = storedKey ?? registryKey ?? process.env[NAN_API_KEY_ENV];
						if (apiKey) {
							const mediaArgs = mediaMcpCommand();
							pi.registerMcpServer(name, {
								type: "stdio",
								command: mediaArgs[0]!,
								args: mediaArgs.slice(1),
								env: { [NAN_API_KEY_ENV]: apiKey },
								exposure: "direct",
								timeout: mediaMcpTimeoutSec(),
							});
						} else {
							ctx.ui.notify(
								`${NAN_API_KEY_ENV} is not set. Export it or run /login nan.`,
								"warning",
							);
						}
					}
				} else {
					pi.unregisterMcpServer(name);
				}

				if (enabled) {
					if (nativeServerRegistered(pi, name)) {
						ctx.ui.notify(
							`Enabled ${where}, ${persistence}. Native server registered for this session.`,
							"info",
						);
					} else {
						ctx.ui.notify(
							`Enabled ${where}, ${persistence} — API key missing; server not registered.`,
							"warning",
						);
					}
				} else {
					ctx.ui.notify(
						`Disabled ${where}, ${persistence}. Native server unregistered — tools hidden immediately.`,
						"warning",
					);
				}
				return;
			}

			ctx.ui.notify(USAGE, "warning");
		},
	});
}
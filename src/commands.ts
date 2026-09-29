/**
 * `/nan-mcp` — slash command configuring both native MCP servers this
 * package registers:
 *
 * - `nan-search` — the official NaN remote MCP server (api.nan.builders/mcp),
 *   exposing `mcp__nan-search__web_search`. Default: enabled.
 * - `nan-media` — the community stdio media server (flux-2-klein / kokoro /
 *   whisper), exposing `mcp__nan-media__generate_image` etc. Default: enabled.
 *
 * Both are session-scoped native servers (visible in /mcp, source "extension").
 * /nan-mcp enables/disables them via pi.registerMcpServer / pi.unregisterMcpServer,
 * persisting the toggle in nan-provider.json.
 *
 * Targets accept aliases: `web-search` (`search`, `web_search`, `official`,
 * `nan-web-search`) and `nan-mcp-server` (`media`, `media-mcp`, `nan-media`).
 * Explicit env vars (NAN_MCP_TOOLS, NAN_MEDIA_MCP) override the persisted
 * toggles for the session.
 *
 * Native behavior changes from the old bridge:
 * - `disable` IMMEDIATELY hides tools (unregisterMcpServer disconnects the
 *   server; the MCP extension hides tools when disconnected).
 * - `enable` IMMEDIATELY registers the server for the current session.
 * - `status` reads the server state from pi.getMcpServers().
 * - Missing API key at load: server is NOT registered; guidance notification
 *   replaces the old "errors at call time" behavior.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mediaMcpCommand, mediaMcpEnabled, mediaMcpSource, mediaMcpEnvExplicit, mediaMcpEnvTruthy, mediaMcpTimeoutSec } from "./mcp/media-server.ts";
import { webSearchBridgeEnabled, webSearchBridgeSource, mcpToolsEnvExplicit, mcpToolsDisabled } from "./mcp/api-key.ts";
import { NAN_API_KEY_ENV, tryResolveNanApiKeyViaRegistry } from "./mcp/api-key.ts";
import { NAN_STATE_FILE, readBridgeState, writeBridgeState, type BridgeKey, readState, writeState } from "./mcp/state.ts";

const USAGE =
	"Usage: /nan-mcp [status] · /nan-mcp enable [web-search|nan-mcp-server] · /nan-mcp disable [web-search|nan-mcp-server]";

/** Canonical bridge targets with aliases. */
const TARGETS: Record<string, BridgeKey> = {
	"web-search": "webSearch",
	search: "webSearch",
	web_search: "webSearch",
	official: "webSearch",
	"nan-web-search": "webSearch",
	"nan-mcp-server": "mediaMcp",
	media: "mediaMcp",
	"media-mcp": "mediaMcp",
	"nan-media": "mediaMcp",
};

function targetName(bridge: BridgeKey): string {
	return bridge === "webSearch" ? "web-search" : "nan-mcp-server";
}

function envOverrideLabel(bridge: BridgeKey): string {
	return bridge === "webSearch"
		? `env NAN_MCP_TOOLS=${process.env.NAN_MCP_TOOLS ?? ""} (overrides persisted)`
		: `env NAN_MEDIA_MCP=${process.env.NAN_MEDIA_MCP ?? ""} (overrides persisted)`;
}

function sourceLabel(bridge: BridgeKey, source: "env" | "persisted" | "default"): string {
	if (source === "env") return envOverrideLabel(bridge);
	if (source === "persisted") {
		return `persisted in <agentDir>/${NAN_STATE_FILE} (${targetName(bridge)}: ${readBridgeState(bridge)})`;
	}
	return "default (both bridges are enabled by default)";
}

/** Resolve a bridge key to its native server name. */
function serverName(bridge: BridgeKey): string {
	return bridge === "webSearch" ? "nan-search" : "nan-media";
}

/** Describe the bridge in the status message. */
function bridgeDescription(bridge: BridgeKey): string {
	return bridge === "webSearch"
		? "web-search bridge (official NaN MCP → mcp__nan-search__web_search)"
		: "nan-mcp-server bridge (community media MCP → mcp__nan-media__generate_image/edit_image/text_to_speech/list_voices/speech_to_text)";
}

/** Check if a native server of this name is currently registered. */
function nativeServerRegistered(pi: ExtensionAPI, name: string): boolean {
	try {
		return pi.getMcpServers().some((s) => s.name === name);
	} catch {
		return false;
	}
}

/** Status message listing both bridges' gate state and native registration. */
function statusMessage(pi: ExtensionAPI): string {
	const lines: string[] = [];

	for (const bridge of ["webSearch" as BridgeKey, "mediaMcp" as BridgeKey]) {
		const enabled = bridge === "webSearch" ? webSearchBridgeEnabled() : mediaMcpEnabled();
		const source = bridge === "webSearch" ? webSearchBridgeSource() : mediaMcpSource();
		const regStatus = nativeServerRegistered(pi, serverName(bridge)) ? "registered (native)" : "not registered";
		lines.push(`${bridgeDescription(bridge)}: ${enabled ? "enabled" : "disabled"} — ${sourceLabel(bridge, source)}, ${regStatus}.`);

		if (bridge === "webSearch") {
			// Key status for web-search
			const keyStatus = resolveKeyStatus(pi);
			lines.push(`  API key: ${keyStatus}.`);
		}
		if (bridge === "mediaMcp") {
			lines.push(`  Media spawn command: ${mediaMcpCommand().join(" ")}.`);
		}
	}

	lines.push("Configure with /nan-mcp enable|disable [web-search|nan-mcp-server]; no target = both.");
	return lines.join("\n");
}

/** Check API key resolution status for web-search. */
async function resolveKeyStatus(pi: ExtensionAPI): Promise<string> {
	// @ts-expect-error — modelRegistry is a runtime surface.
	const registryKey = await tryResolveNanApiKeyViaRegistry(pi.modelRegistry);
	const envKey = process.env[NAN_API_KEY_ENV];
	if (registryKey || envKey) return "resolved";
	return "NOT SET — run /login nan or export NAN_API_KEY";
}

/** Parse an optional target argument; no target = both bridges. */
function parseTarget(token: string | undefined): { bridges: BridgeKey[]; target?: string } | undefined {
	if (token === undefined) return { bridges: ["webSearch", "mediaMcp"] };
	const key = TARGETS[token.toLowerCase()];
	if (!key) return undefined;
	return { bridges: [key], target: token.toLowerCase() };
}

function describeBridges(bridges: BridgeKey[]): string {
	const names = bridges.map((bridge) => targetName(bridge));
	return names.length === 2 ? "both bridges" : names.join(" and ");
}

/**
 * Check if a bridge is effectively enabled (gate resolved).
 */
function bridgeEffectivelyEnabled(bridge: BridgeKey): boolean {
	return bridge === "webSearch" ? webSearchBridgeEnabled() : mediaMcpEnabled();
}

export function registerNanMcpCommand(pi: ExtensionAPI): void {
	pi.registerCommand("nan-mcp", {
		description:
			"NaN MCP configuration: enable/disable/status for both native servers (official web-search + community media)",
		getArgumentCompletions: (argumentPrefix: string) => {
			const prefix = argumentPrefix.trim().toLowerCase();
			const items = [
				{ value: "enable", label: "enable", description: "Enable a native server (or both) and persist it" },
				{ value: "disable", label: "disable", description: "Disable a native server (or both) persistently" },
				{ value: "status", label: "status", description: "Show current server status and registration" },
				{ value: "enable web-search", label: "enable web-search", description: "Enable the official NaN web-search server" },
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
				ctx.ui.notify(statusMessage(pi), "info");
				return;
			}

			if (subcommand === "enable" || subcommand === "disable") {
				const parsed = parseTarget(rawTarget);
				if (parsed === undefined || rest.length > 0) {
					ctx.ui.notify(
						parsed === undefined
							? `Unknown target "${[rawTarget, ...rest].filter(Boolean).join(" ")}". Targets: web-search, nan-mcp-server (or omit for both).`
							: USAGE,
						"warning",
					);
					return;
				}
				const { bridges, target } = parsed;
				const enabled = subcommand === "enable";

				for (const bridge of bridges) {
					writeBridgeState(bridge, enabled);
				}

				// Immediate native registration/unregistration.
				for (const bridge of bridges) {
					const name = serverName(bridge);
					if (enabled) {
						// Only register if gate allows it.
						if (bridgeEffectivelyEnabled(bridge)) {
							if (bridge === "webSearch") {
								// @ts-expect-error — modelRegistry is a runtime surface.
								const registryKey = await tryResolveNanApiKeyViaRegistry(pi.modelRegistry);
								const apiKey = registryKey ?? process.env[NAN_API_KEY_ENV];
								if (apiKey) {
									pi.registerMcpServer(name, {
										type: "http",
										url: "https://api.nan.builders/mcp",
										headers: { Authorization: `Bearer ${apiKey}` },
										exposure: "direct",
									});
								} else {
									ctx.ui.notify(
										`${NAN_API_KEY_ENV} is not set. Export it or run /login nan.`,
										"warning",
									);
								}
							} else {
								const mediaArgs = mediaMcpCommand();
								pi.registerMcpServer(name, {
									type: "stdio",
									command: mediaArgs[0]!,
									args: mediaArgs.slice(1),
									env: { [NAN_API_KEY_ENV]: process.env[NAN_API_KEY_ENV] ?? "" },
									exposure: "direct",
									timeout: mediaMcpTimeoutSec(),
								});
							}
						}
					} else {
						pi.unregisterMcpServer(name);
					}
				}

				const where = target ? `for "${target}"` : "for both bridges";
				const persistence = `persisted in <agentDir>/${NAN_STATE_FILE}`;
				if (enabled) {
					ctx.ui.notify(
						`Enabled ${describeBridges(bridges)} ${where}, ${persistence}. Native servers registered for this session.`,
						"info",
					);
				} else {
					ctx.ui.notify(
						`Disabled ${describeBridges(bridges)} ${where}, ${persistence}. Native servers unregistered — tools hidden immediately.`,
						"warning",
					);
				}
				return;
			}

			ctx.ui.notify(USAGE, "warning");
		},
	});
}
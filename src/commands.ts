/**
 * `/nan-mcp` — slash command managing this addon's MCP configuration.
 *
 * pi has no MCP client and therefore no `/mcp` command of its own, so this
 * command owns the toggles for the MCP bridges we register as pi tools:
 *
 * - `/nan-mcp` or `/nan-mcp status` — current state of both bridges.
 * - `/nan-mcp enable [nan-mcp-server]` — enable the community media MCP
 *   server and persist it (`<agentDir>/nan-provider.json`): it stays enabled
 *   across sessions until disabled. Tools register immediately for the
 *   current session too.
 * - `/nan-mcp disable [nan-mcp-server]` — disable persistently. pi has no
 *   unregisterTool, so already-registered tools remain until the next
 *   session; the persisted toggle governs future sessions.
 *
 * Trailing tokens (e.g. `nan-mcp-server`) are tolerated so muscle memory
 * like `/mcp enable nan-mcp-server` maps to `/nan-mcp enable nan-mcp-server`.
 * An explicit NAN_MEDIA_MCP env var overrides the persisted toggle.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	createNanMediaTools,
	mediaMcpCommand,
	mediaMcpEnabled,
	mediaMcpSource,
	readMediaMcpState,
	writeMediaMcpState,
} from "./mcp/nan-media.ts";
import { mcpToolsDisabled } from "./mcp/nan-search.ts";

export interface NanMcpCommandOptions {
	/**
	 * Register media tools for the current session (called by `enable`).
	 * Implementations must be idempotent: skip tools already registered.
	 */
	registerMediaTools: () => void;
}

const SUBCOMMANDS = ["enable", "disable", "status"] as const;

const USAGE =
	"Usage: /nan-mcp enable [nan-mcp-server] · /nan-mcp disable · /nan-mcp status";

function statusMessage(): string {
	const enabled = mediaMcpEnabled();
	const source = mediaMcpSource();
	const sourceLabel =
		source === "env"
			? `env var NAN_MEDIA_MCP=${process.env.NAN_MEDIA_MCP} (overrides the persisted toggle)`
			: source === "persisted"
				? `persisted in <agentDir>/${"nan-provider.json"} (mediaMcp: ${readMediaMcpState()})`
				: "default (off; nothing persisted)";
	return [
		`Media MCP (nan-mcp-server): ${enabled ? "enabled" : "disabled"} — source: ${sourceLabel}.`,
		`Spawn command: ${mediaMcpCommand().join(" ")} (per tool call, terminated after).`,
		`Official web_search bridge: ${mcpToolsDisabled() ? "disabled (NAN_MCP_TOOLS=0)" : "enabled (default)"}.`,
		enabled ? "" : "Enable persistently with /nan-mcp enable (or NAN_MEDIA_MCP=1 for this session only).",
	]
		.filter(Boolean)
		.join("\n");
}

export function registerNanMcpCommand(pi: ExtensionAPI, options: NanMcpCommandOptions): void {
	pi.registerCommand("nan-mcp", {
		description: "NaN MCP configuration: enable/disable/status of the media MCP bridge (nan-mcp-server)",
		getArgumentCompletions: (argumentPrefix: string) => {
			const prefix = argumentPrefix.trim().toLowerCase();
			const items = SUBCOMMANDS.map((sub) => ({
				value: sub,
				label: sub,
				description:
					sub === "enable"
						? "Enable the nan-mcp-server media bridge and persist it"
						: sub === "disable"
							? "Disable the nan-mcp-server media bridge persistently"
							: "Show current MCP bridge status",
			}));
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [rawSubcommand = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = rawSubcommand.toLowerCase();

			switch (subcommand) {
				case "status": {
					ctx.ui.notify(statusMessage(), "info");
					return;
				}
				case "enable": {
					// Accept trailing tokens like "nan-mcp-server" but reject unknown targets.
					if (rest.length > 0 && !rest.every((token) => token.toLowerCase().includes("nan"))) {
						ctx.ui.notify(`Unknown target "${rest.join(" ")}". Only the nan-mcp-server bridge is configurable.`, "warning");
						return;
					}
					writeMediaMcpState(true);
					options.registerMediaTools();
					ctx.ui.notify(
						`nan-mcp-server media bridge enabled and persisted (${sourceLabelForState(true)}). ` +
							"Tools are available now; they spawn the MCP server per call, so nothing runs until invoked.",
						"info",
					);
					return;
				}
				case "disable": {
					writeMediaMcpState(false);
					ctx.ui.notify(
						"nan-mcp-server media bridge disabled and persisted. pi has no unregisterTool, so tools already " +
							"registered in this session remain available until you restart pi (or /reload); " +
							"future sessions will not register them.",
						"warning",
					);
					return;
				}
				default:
					ctx.ui.notify(USAGE, "warning");
			}
		},
	});
}

function sourceLabelForState(enabled: boolean): string {
	if (enabled) {
		return "nan-provider.json in your pi agent dir; an explicit NAN_MEDIA_MCP env var overrides it";
	}
	return "nan-provider.json in your pi agent dir; /nan-mcp enable to turn it back on";
}

/** Build the media tools set, skipping names already registered this session. */
export function makeIdempotentMediaToolRegistrar(
	pi: ExtensionAPI,
	registeredToolNames: Set<string>,
): () => void {
	return () => {
		for (const tool of createNanMediaTools()) {
			if (registeredToolNames.has(tool.name)) continue;
			registeredToolNames.add(tool.name);
			pi.registerTool(tool);
		}
	};
}
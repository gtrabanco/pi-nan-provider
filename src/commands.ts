/**
 * `/nan-mcp` — slash command configuring BOTH MCP bridges this package
 * registers as pi tools:
 *
 * - `web-search` — the official NaN remote MCP server (api.nan.builders/mcp),
 *   exposing `nan_web_search`. Default: enabled.
 * - `nan-mcp-server` — the community stdio media server (image generation /
 *   editing, TTS, STT). Default: enabled, lazy (spawned per tool call).
 *
 * pi has no MCP client and therefore no `/mcp` command of its own, so this
 * command owns the toggles:
 *
 * - `/nan-mcp` or `/nan-mcp status` — state of both bridges and their source.
 * - `/nan-mcp enable [target]` — enable a bridge (or both, when no target is
 *   given) and persist it in `<agentDir>/nan-provider.json`; enabled bridges
 *   register their tools immediately for the current session.
 * - `/nan-mcp disable [target]` — disable persistently. pi has no
 *   unregisterTool, so already-registered tools remain until the next
 *   session/restart; the persisted toggle governs future sessions.
 *
 * Targets accept aliases: `web-search` (`search`, `web_search`, `official`,
 * `nan-web-search`) and `nan-mcp-server` (`media`, `media-mcp`, `nan-media`).
 * Explicit env vars (NAN_MCP_TOOLS, NAN_MEDIA_MCP) override the persisted
 * toggles for the session.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mediaMcpCommand, mediaMcpEnabled, mediaMcpSource } from "./mcp/nan-media.ts";
import { webSearchBridgeEnabled, webSearchBridgeSource } from "./mcp/nan-search.ts";
import { NAN_STATE_FILE, readBridgeState, writeBridgeState, type BridgeKey } from "./mcp/state.ts";

export interface NanMcpCommandOptions {
	/** Register web-search bridge tools now; must skip already-registered tools. */
	registerWebSearchTools: () => void;
	/** Register media bridge tools now; must skip already-registered tools. */
	registerMediaTools: () => void;
}

const USAGE =
	"Usage: /nan-mcp [status] · /nan-mcp enable [web-search|nan-mcp-server] · /nan-mcp disable [web-search|nan-mcp-server]";

/** Canonical bridge targets with aliases (e.g. `/mcp enable nan-mcp-server` muscle memory). */
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
	return "default (both bridges are enabled and lazy by default)";
}

function statusMessage(): string {
	return [
		`web-search bridge (official NaN MCP → nan_web_search): ${webSearchBridgeEnabled() ? "enabled" : "disabled"} — ${sourceLabel("webSearch", webSearchBridgeSource())}.`,
		`nan-mcp-server bridge (community media MCP → nan_generate_image/nan_edit_image/nan_text_to_speech/nan_list_voices/nan_speech_to_text): ${mediaMcpEnabled() ? "enabled" : "disabled"} — ${sourceLabel("mediaMcp", mediaMcpSource())}.`,
		`Media spawn command: ${mediaMcpCommand().join(" ")} (per tool call, terminated after).`,
		"Configure with /nan-mcp enable|disable [web-search|nan-mcp-server]; no target = both.",
	].join("\n");
}

/** Parse an optional target argument; no target = both bridges. Returns undefined target name on unknown. */
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

export function registerNanMcpCommand(pi: ExtensionAPI, options: NanMcpCommandOptions): void {
	pi.registerCommand("nan-mcp", {
		description:
			"NaN MCP configuration: enable/disable/status for both bridges (official web-search + community nan-mcp-server)",
		getArgumentCompletions: (argumentPrefix: string) => {
			const prefix = argumentPrefix.trim().toLowerCase();
			const items = [
				{ value: "enable", label: "enable", description: "Enable a bridge (or both) and persist it" },
				{ value: "disable", label: "disable", description: "Disable a bridge (or both) persistently" },
				{ value: "status", label: "status", description: "Show current bridge status" },
				{ value: "enable web-search", label: "enable web-search", description: "Enable the official NaN web-search bridge" },
				{ value: "enable nan-mcp-server", label: "enable nan-mcp-server", description: "Enable the community media bridge" },
			];
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const [rawSubcommand = "status", rawTarget, ...rest] = tokens;
			const subcommand = rawSubcommand.toLowerCase();

			if (subcommand === "status") {
				ctx.ui.notify(statusMessage(), "info");
				return;
			}

			if (subcommand === "enable" || subcommand === "disable") {
				// Trailing tokens beyond the target (e.g. duplicate target names) are ignored.
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
				if (enabled) {
					if (bridges.includes("webSearch")) options.registerWebSearchTools();
					if (bridges.includes("mediaMcp")) options.registerMediaTools();
				}

				const where = target ? `for "${target}"` : "for both bridges";
				const persistence = `persisted in <agentDir>/${NAN_STATE_FILE}`;
				if (enabled) {
					ctx.ui.notify(
						`Enabled ${describeBridges(bridges)} ${where}, ${persistence}. Tools are available now; both bridges are lazy (web-search calls the endpoint per request, nan-mcp-server spawns per call), so nothing runs until invoked.` +
							" An explicit NAN_MCP_TOOLS / NAN_MEDIA_MCP env var would override this toggle.",
						"info",
					);
				} else {
					ctx.ui.notify(
						`Disabled ${describeBridges(bridges)} ${where}, ${persistence}. pi has no unregisterTool, so tools already registered in this session remain until restart (or /reload); future sessions will not register them.` +
							" An explicit NAN_MCP_TOOLS / NAN_MEDIA_MCP env var overrides this toggle.",
						"warning",
					);
				}
				return;
			}

			ctx.ui.notify(USAGE, "warning");
		},
	});
}
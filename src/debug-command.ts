/**
 * `/nan-debug` command (issue #35) — deterministic, redacted evidence
 * collection following the `/nan-usage` precedent.
 *
 * Flow: parse → collect → write the redacted report locally → notify a preview.
 * The shareable zip is written only with `--emit` (the explicit confirmation
 * the issue asks for). `/v1/usage` is consulted only with `--window`, and it
 * stays permission-gated: the user invoked the command with that flag.
 */

import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { NAN_API_KEY_ENV, resolveStoredNanApiKey, tryResolveNanApiKeyViaRegistry } from "./mcp/api-key.ts";
import {
	DEBUG_USAGE_LINE,
	NAN_DEBUG_REPORT_DIR,
	NAN_DEBUG_ZIP,
	buildDebugReport,
	fetchDebugUsageWindow,
	parseDebugArgs,
	renderDebugReport,
	writeDebugReport,
	writeDebugZip,
	type FetchUsageWindow,
} from "./debug-report.ts";

export interface NanDebugCommandDeps {
	/** Injectable for tests; defaults to pi's agent dir. */
	agentDir?: string;
	/** Injectable clock for deterministic tests. */
	now?: () => Date;
	/** Injectable `GET /v1/usage` client for tests; defaults to the live call. */
	fetchUsage?: FetchUsageWindow;
	/** Injectable key resolution for tests. */
	resolveApiKey?: (ctx: ExtensionCommandContext) => Promise<string | undefined>;
}

async function defaultResolveApiKey(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const registryKey = await tryResolveNanApiKeyViaRegistry(ctx.modelRegistry);
	return registryKey ?? resolveStoredNanApiKey() ?? (process.env[NAN_API_KEY_ENV] || undefined);
}

export function registerNanDebugCommand(pi: ExtensionAPI, deps: NanDebugCommandDeps = {}): void {
	pi.registerCommand("nan-debug", {
		description:
			"Collect a redacted NaN evidence report locally; --emit writes the shareable zip (/nan-debug help)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (args.trim().toLowerCase() === "help") {
				ctx.ui.notify(DEBUG_USAGE_LINE, "info");
				return;
			}

			const parsed = parseDebugArgs(args);
			if (!parsed.ok) {
				ctx.ui.notify(parsed.error, "warning");
				return;
			}

			const now = deps.now?.() ?? new Date();
			const agentDir = deps.agentDir ?? getAgentDir();
			const apiKey = parsed.args.windowProvided
				? await (deps.resolveApiKey ?? defaultResolveApiKey)(ctx)
				: undefined;

			let rendered;
			try {
				const report = await buildDebugReport({
					agentDir,
					now,
					windowDays: parsed.args.windowDays,
					topic: parsed.args.topic,
					apiKey,
					includeUsage: parsed.args.windowProvided,
					fetchUsage: parsed.args.windowProvided ? (deps.fetchUsage ?? fetchDebugUsageWindow) : undefined,
				});
				rendered = renderDebugReport(report);
			} catch (error) {
				ctx.ui.notify(
					`nan-debug failed to collect the report: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
				return;
			}

			const explicitZip = parsed.args.out?.endsWith(".zip") ? parsed.args.out : undefined;
			const outDir = explicitZip
				? explicitZip.replace(/\.zip$/, "")
				: (parsed.args.out ?? join(agentDir, NAN_DEBUG_REPORT_DIR));
			const zipPath = explicitZip ?? (parsed.args.out ? `${parsed.args.out}.zip` : join(agentDir, NAN_DEBUG_ZIP));

			try {
				writeDebugReport(rendered.files, outDir);
				if (parsed.args.emit) writeDebugZip(rendered.files, zipPath);
			} catch (error) {
				ctx.ui.notify(
					`nan-debug wrote nothing: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
				return;
			}

			const message = parsed.args.emit
				? `${rendered.preview}\n→ zip written to ${zipPath}`
				: `${rendered.preview}\n→ local report: ${outDir}`;
			ctx.ui.notify(message, "info");
		},
	});
}

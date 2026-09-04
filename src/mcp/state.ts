/**
 * Persisted toggles for the MCP bridges this package registers, stored in
 * pi's agent dir (e.g. ~/.pi/agent/nan-provider.json) so `/nan-mcp` changes
 * survive across sessions.
 *
 * Resolution order for each bridge:
 *   1. Explicit bridge env var (any value, including 0 — one-session override).
 *   2. Persisted toggle written by /nan-mcp.
 *   3. Default: enabled (both bridges are on and lazy by default).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Persisted-toggle state file inside pi's agent dir. */
export const NAN_STATE_FILE = "nan-provider.json";

export interface NanProviderState {
	/** Persisted enablement of the official web_search MCP bridge. */
	webSearch?: boolean;
	/** Persisted enablement of the community nan-mcp-server media bridge. */
	mediaMcp?: boolean;
}

export type BridgeKey = keyof NanProviderState;

export type BridgeSource = "env" | "persisted" | "default";

function stateFilePath(): string {
	return join(getAgentDir(), NAN_STATE_FILE);
}

/**
 * Read the persisted state. Never throws: a missing or corrupted file yields
 * an empty state (defaults apply).
 */
export function readState(): NanProviderState {
	try {
		const parsed = JSON.parse(readFileSync(stateFilePath(), "utf8")) as NanProviderState;
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

/** Persist a patch over the current state. Creates the agent dir if needed. */
export function writeState(patch: Partial<NanProviderState>): void {
	const path = stateFilePath();
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...readState(), ...patch }, null, "\t")}\n`);
}

/** Persisted value for one bridge; `undefined` = not persisted (default applies). */
export function readBridgeState(bridge: BridgeKey): boolean | undefined {
	const value = readState()[bridge];
	return typeof value === "boolean" ? value : undefined;
}

export function writeBridgeState(bridge: BridgeKey, enabled: boolean): void {
	writeState({ [bridge]: enabled });
}

/** Where the effective value of a bridge comes from (for /nan-mcp status). */
export function bridgeSource(bridge: BridgeKey, envExplicit: boolean): BridgeSource {
	if (envExplicit) return "env";
	return readBridgeState(bridge) !== undefined ? "persisted" : "default";
}

/** Effective value: explicit env → persisted → default. */
export function resolveBridgeEnabled(bridge: BridgeKey, envExplicit: boolean, envTruthy: boolean, defaultValue: boolean): boolean {
	if (envExplicit) return envTruthy;
	return readBridgeState(bridge) ?? defaultValue;
}

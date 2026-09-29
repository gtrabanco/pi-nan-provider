/**
 * Media server construction helpers — version pin, command, timeout.
 * Also exports bridge gate resolution (mediaMcpEnabled / mediaMcpSource)
 * to keep the native MCP registration in index.ts minimal.
 */
import { bridgeSource, resolveBridgeEnabled, type BridgeSource } from "./state.ts";

/**
 * Default spawn: `npx -y nan-mcp-server@<pinned version>` (npx caches after first use).
 */
export function mediaMcpCommand(version = process.env[NAN_MEDIA_MCP_VERSION_ENV] || DEFAULT_NAN_MEDIA_MCP_VERSION): string[] {
	const custom = process.env[NAN_MEDIA_MCP_COMMAND_ENV]?.trim();
	if (custom) return custom.split(/\s+/);
	return ["npx", "-y", `nan-mcp-server@${version}`];
}

/** Per-request timeout in milliseconds. Native MCP uses seconds. */
export function mediaMcpTimeoutMs(): number {
	const parsed = Number.parseInt(process.env[NAN_MEDIA_MCP_TIMEOUT_ENV] ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MEDIA_MCP_TIMEOUT_MS;
}

/** Per-request timeout in **seconds** for the native MCP config. */
export function mediaMcpTimeoutSec(): number {
	return Math.ceil(mediaMcpTimeoutMs() / 1000);
}

export const NAN_MEDIA_MCP_ENV = "NAN_MEDIA_MCP";

export const DEFAULT_NAN_MEDIA_MCP_VERSION = "1.1.2";
export const DEFAULT_MEDIA_MCP_TIMEOUT_MS = 120_000;
export const NAN_MEDIA_MCP_VERSION_ENV = "NAN_MEDIA_MCP_VERSION";
export const NAN_MEDIA_MCP_COMMAND_ENV = "NAN_MEDIA_MCP_COMMAND";
export const NAN_MEDIA_MCP_TIMEOUT_ENV = "NAN_MEDIA_MCP_TIMEOUT_MS";

/** Whether NAN_MEDIA_MCP is explicitly set (any value). */
export function mediaMcpEnvExplicit(): boolean {
	const value = process.env[NAN_MEDIA_MCP_ENV];
	return value !== undefined && value.trim() !== "";
}

/** Whether NAN_MEDIA_MCP is explicitly set and truthy. */
export function mediaMcpEnvTruthy(): boolean {
	const value = process.env[NAN_MEDIA_MCP_ENV]?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "on";
}

/** Whether the media bridge is enabled by gate (env → persisted → default). */
export function mediaMcpEnabled(): boolean {
	return resolveBridgeEnabled("mediaMcp", mediaMcpEnvExplicit(), mediaMcpEnvTruthy(), true);
}

/** Source of the effective media enablement. */
export function mediaMcpSource(): BridgeSource {
	return bridgeSource("mediaMcp", mediaMcpEnvExplicit());
}
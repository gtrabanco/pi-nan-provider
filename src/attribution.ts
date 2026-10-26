/**
 * Provider attribution: an identity header on every outgoing request that
 * says this package (and its exact version) is serving the models.
 *
 * pi-ai merges `model.headers` over its own identity headers in
 * `createClient` (`{ ...getIdentityHeaders(model, identity), ...model.headers }`,
 * the same shape since pi-ai 0.99.1), so attaching the header to every model
 * entry — generated catalog, live merge, unknown-id placeholders, live-only
 * documented entries, the stale-catalog overlay and image models — reaches
 * the gateway on every supported host without touching the request payload
 * or pi's own `User-Agent`.
 *
 * The header is additive: a dedicated `X-Pi-Provider` value, never a rewrite
 * of headers pi-ai or the host already sends. If the package version cannot
 * be resolved (e.g. a virtual-module bundle with no readable package.json),
 * the header is simply omitted — attribution must never break a request.
 *
 * PRIVACY GATE: the header identifies this package, so it is subject to pi's
 * telemetry setting. The extension entrypoint wires
 * {@link configureProviderAttribution} to `pi.getSettings()` and the header
 * disappears whenever `enableInstallTelemetry` is `false` (the gate is
 * evaluated on every read, so toggling the setting mid-session takes effect
 * on the next request without a restart). Uncancellable-by-settings callers
 * (direct library use of `createNanCompatibleProvider` without the extension
 * entrypoint) get the enabled default; if the gate itself throws, attribution
 * falls back to pi's shipped default (enabled).
 */

import { readFileSync } from "node:fs";

/** Header added to every model registered by this package's providers. */
export const PROVIDER_ATTRIBUTION_HEADER = "X-Pi-Provider";

/** Package identity used as the header value prefix (npm scope without the `@`). */
const PACKAGE_IDENTITY = "gtrabanco/pi-nan-provider";

const ATTRIBUTION_CACHE_KEY = Symbol.for("gtrabanco.pi-nan-provider.attribution");

interface AttributionCache {
	value?: string;
	resolved: boolean;
}

/** Cache on globalThis so multi-load (extension + tests + host) resolves once. */
function cache(): AttributionCache {
	const store = globalThis as typeof globalThis & Record<symbol, unknown>;
	if (!store[ATTRIBUTION_CACHE_KEY]) store[ATTRIBUTION_CACHE_KEY] = { resolved: false };
	return store[ATTRIBUTION_CACHE_KEY] as AttributionCache;
}

/**
 * The attribution header value: `gtrabanco/pi-nan-provider@<version>`, or
 * `undefined` when this package's version cannot be read (header omitted).
 */
export function providerAttributionHeaderValue(): string | undefined {
	const state = cache();
	if (state.resolved) return state.value;
	state.resolved = true;
	try {
		const pkg = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
		) as { version?: unknown };
		if (typeof pkg.version === "string" && pkg.version.length > 0) {
			state.value = `${PACKAGE_IDENTITY}@${pkg.version}`;
		}
	} catch {
		// Unreadable package.json (virtual-module bundle, atypical loader):
		// attribution is best-effort — omit the header, never fail a request.
	}
	return state.value;
}

type AttributionGate = () => boolean;

let gate: AttributionGate = () => true;

/**
 * Read the current enablement. Overridable via {@link configureProviderAttribution};
 * the default (no gate configured) is enabled. A throwing gate — e.g. a host
 * without `getSettings()` — falls back to enabled (pi's shipped default).
 */
export function providerAttributionEnabled(): boolean {
	try {
		return gate();
	} catch {
		return true;
	}
}

/**
 * Install the enablement gate. The extension entrypoint passes a closure over
 * `pi.getSettings().enableInstallTelemetry`, evaluated FRESH on every call so
 * a mid-session settings change applies on the next request.
 */
export function configureProviderAttribution(isEnabled: AttributionGate): void {
	gate = isEnabled;
}

/**
 * Attach the attribution header to a model (or any object carrying
 * `headers`), preserving existing headers. Returns the same object when the
 * version is unavailable or the privacy gate is disabled. Our own header wins
 * over any pre-existing value.
 */
export function withProviderAttribution<T extends { headers?: Record<string, string> }>(model: T): T {
	const value = providerAttributionEnabled() ? providerAttributionHeaderValue() : undefined;
	if (!value) return model;
	return { ...model, headers: { ...model.headers, [PROVIDER_ATTRIBUTION_HEADER]: value } } as T;
}

/**
 * Remove the attribution header from a model that already carries it (factory-
 * time entries baked the header when the gate was enabled). Used on read paths
 * so a mid-session gate flip takes effect without rebuilding the catalog.
 */
export function stripProviderAttribution<T extends { headers?: Record<string, string> }>(model: T): T {
	if (!model.headers || !(PROVIDER_ATTRIBUTION_HEADER in model.headers)) return model;
	const { [PROVIDER_ATTRIBUTION_HEADER]: _drop, ...rest } = model.headers;
	return { ...model, headers: rest } as T;
}

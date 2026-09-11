/**
 * Network guard for the test suite (preloaded via bunfig.toml).
 *
 * Every test must inject its own `fetch` (`fetchImpl` / `options.fetch`) or
 * spawn the local fixture in `test/fixtures/`. A test — or a helper that
 * silently falls back to the global fetch — must never reach a live endpoint,
 * and never with a developer's `NAN_API_KEY` (which would spend real quota
 * against api.nan.builders).
 *
 * Replacing `globalThis.fetch` with a loud throw makes an accidental live call
 * fail immediately instead of burning tokens. This caught nothing at the time
 * it was added: the suite was already fully mocked. It exists to keep it that
 * way.
 */

const originalFetch = globalThis.fetch;

globalThis.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
	const input = args[0];
	const url =
		typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
	throw new Error(
		`[test-network-guard] Refusing a real network call to ${url}. ` +
			"Inject fetchImpl/options.fetch or use a local fixture — the test suite must never hit live endpoints.",
	);
}) as typeof fetch;

export { originalFetch };

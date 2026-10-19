/**
 * Runtime pi-ai version detection.
 *
 * Resolves the `@earendil-works/pi-ai` package instance the HOST loaded — the
 * same host-anchored strategy `src/pi-ai-loader.ts` uses, because an
 * extension-relative resolve can return a stale copy from the extension's own
 * npm tree (issue #8) — and reads that copy's package.json version. The result
 * feeds version-gated behavior, currently the cross-model thinking guard
 * (registered only while the host's pi-ai is older than 1.3.0, where pi-ai
 * still replays cross-model thinking as unbounded text).
 *
 * Failure is NOT an error: an unresolvable package or an unreadable version
 * returns `undefined`, and callers fall back to the conservative older-pi
 * behavior (the guard stays on — harmless on modern hosts, essential on old
 * ones). Guarded by `test/pi-ai-version.test.ts`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostAnchorUrl, PI_AI_PACKAGE_SPECIFIER, resolvePiAiSpecifier } from "./pi-ai-loader.ts";

/** A parsed semver triple (`1.3.0-beta.1` → `{ major: 1, minor: 3, patch: 0 }`). */
export interface PiAiVersion {
	major: number;
	minor: number;
	patch: number;
}

/** Parse a semver string; prerelease/build suffixes are ignored. */
export function parsePiAiVersion(version: string): PiAiVersion | undefined {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
	if (!match) return undefined;
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Read the pi-ai version from a resolved specifier (path or `file://` URL) of
 * any entry file inside the package. Walks up from the entry's directory until
 * a package.json whose `name` is exactly `@earendil-works/pi-ai` is found —
 * matching the name prevents picking up an unrelated package.json in a
 * workspace layout — and returns its `version`. Bounded walk (8 levels);
 * `undefined` when nothing matches.
 */
export function piAiVersionFromResolvedEntry(entry: string): string | undefined {
	let dir: string;
	try {
		dir = dirname(entry.startsWith("file://") ? fileURLToPath(entry) : entry);
	} catch {
		return undefined;
	}
	for (let depth = 0; depth < 8; depth++) {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
				name?: unknown;
				version?: unknown;
			};
			if (pkg.name === PI_AI_PACKAGE_SPECIFIER && typeof pkg.version === "string") {
				return pkg.version;
			}
		} catch {
			// No readable package.json at this level — keep walking up.
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

/** Cache for {@link resolvePiAiVersion}; resolution runs once per process. */
let cachedVersion: string | undefined;
let resolved = false;

/**
 * Version of the pi-ai instance the host loaded, or `undefined` when it cannot
 * be determined (unresolvable specifier, unreadable package.json, odd runtime).
 * Resolution happens once and is cached for the process lifetime.
 */
export function resolvePiAiVersion(): string | undefined {
	if (resolved) return cachedVersion;
	resolved = true;
	try {
		const entry = resolvePiAiSpecifier(PI_AI_PACKAGE_SPECIFIER, {
			anchorUrl: hostAnchorUrl(process.argv[1]),
		});
		cachedVersion = piAiVersionFromResolvedEntry(entry);
	} catch {
		cachedVersion = undefined;
	}
	return cachedVersion;
}

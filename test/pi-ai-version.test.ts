/**
 * Runtime pi-ai version detection (`src/pi-ai-version.ts`).
 *
 * The cross-model thinking guard is version-gated on the resolved pi-ai
 * version, so the resolution mechanics are contract: they must read the
 * version of the package the resolved entry actually belongs to (name-checked,
 * not just any package.json up the tree) and fail soft (undefined) instead of
 * throwing.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePiAiVersion, piAiVersionFromResolvedEntry, resolvePiAiVersion } from "../src/pi-ai-version.ts";

describe("parsePiAiVersion", () => {
	test("parses plain semver", () => {
		expect(parsePiAiVersion("1.3.0")).toEqual({ major: 1, minor: 3, patch: 0 });
		expect(parsePiAiVersion("0.99.2")).toEqual({ major: 0, minor: 99, patch: 2 });
	});

	test("ignores prerelease and build suffixes", () => {
		expect(parsePiAiVersion("1.3.0-beta.1")).toEqual({ major: 1, minor: 3, patch: 0 });
		expect(parsePiAiVersion("1.3.0+build.7")).toEqual({ major: 1, minor: 3, patch: 0 });
	});

	test("tolerates surrounding whitespace and rejects garbage", () => {
		expect(parsePiAiVersion("  1.2.0 ")).toEqual({ major: 1, minor: 2, patch: 0 });
		expect(parsePiAiVersion("latest")).toBeUndefined();
		expect(parsePiAiVersion("1.2")).toBeUndefined();
		expect(parsePiAiVersion("")).toBeUndefined();
	});
});

describe("piAiVersionFromResolvedEntry", () => {
	// The devDependency IS a real @earendil-works/pi-ai install; resolving it
	// gives a genuine entry file without pinning the test to a version. The
	// package is ESM-only (no "require" export condition), so resolution goes
	// through import.meta.resolve, exactly like the production loader.
	const devDepEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
	const devDepPackageJson = JSON.parse(
		readFileSync(join(devDepEntry, "..", "..", "package.json"), "utf-8"),
	) as { version: string };

	test("reads the version of the package the entry belongs to", () => {
		expect(piAiVersionFromResolvedEntry(devDepEntry)).toBe(devDepPackageJson.version);
	});

	test("accepts file:// URLs and paths alike", () => {
		const asFileUrl = `file://${devDepEntry}`;
		expect(piAiVersionFromResolvedEntry(asFileUrl)).toBe(devDepPackageJson.version);
	});

	test("does not pick up unrelated package.json files up the tree", () => {
		// The repo root's package.json is NOT @earendil-works/pi-ai: a walk that
		// matched on file existence instead of package name would return the
		// wrong version. It must give up instead.
		expect(piAiVersionFromResolvedEntry(new URL(import.meta.url).pathname)).toBeUndefined();
		expect(piAiVersionFromResolvedEntry("/definitely/not/a/real/path/index.js")).toBeUndefined();
	});
});

describe("resolvePiAiVersion", () => {
	test("returns a valid semver string or undefined — never throws", () => {
		const version = resolvePiAiVersion();
		if (version !== undefined) {
			expect(parsePiAiVersion(version)).toBeDefined();
		}
	});

	test("is cached: repeated calls return the same result", () => {
		expect(resolvePiAiVersion()).toBe(resolvePiAiVersion());
	});
});

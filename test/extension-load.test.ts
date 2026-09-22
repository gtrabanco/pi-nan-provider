/**
 * Regression test for the extension-load failure reported on pi 0.84.4:
 *
 *   Failed to load extension: Cannot find module
 *   '...pi-ai/dist/compat.js/api/openai-completions.lazy'
 *
 * Root cause: pi's extension loader intercepts the bare
 * `@earendil-works/pi-ai` specifier and maps it to the compat entrypoint
 * (VIRTUAL_MODULES in pi's dist/core/extensions/loader.js, same mechanism on
 * 0.83 and 0.84). The alias applies as a PREFIX, so a subpath import like
 * `@earendil-works/pi-ai/api/openai-completions.lazy` resolves to
 * `<compat.js>/api/openai-completions.lazy`, which does not exist — and the
 * native fallback fails on hosts where the extension has no resolvable
 * pi-ai copy of its own. The extension module then fails to import and
 * nothing registers (which is also why `nan` disappeared from /login once
 * models.json was deleted).
 *
 * Exception (issue #8): on pi-web's sessiond-on-Bun loader path the bare root
 * `@earendil-works/pi-ai` is NOT aliased to `/compat`, and resolves to
 * pi-core's 0.87 internal package (which lacks `openAICompletionsApi`), while a
 * bare SUBPATH import can resolve to a stale hoisted `@earendil-works/pi-ai@
 * 0.85.1` in the extension tree — whose `estimateMessageTokens` crashes on pi
 * 0.87 transcripts. The fix (`src/pi-ai-loader.ts`) derives file URLs from
 * `import.meta.resolve` so every lazy-api import stays bound to the same
 * package instance as the bare-root import.
 *
 * Contract enforced here: src/ must not use bare pi-ai subpath specifiers at
 * all (static OR dynamic); the loader derives a file URL from
 * `import.meta.resolve` and never imports a raw subpath.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

function* tsFiles(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* tsFiles(path);
		else if (name.endsWith(".ts")) yield path;
	}
}

/** Type-only statements are erased by the transpiler before resolution; safe. */
const TYPE_ONLY_STATEMENT = /^\s*(?:import|export)\s+type\b[\s\S]*?from\s*["'][^"']+["'];?/gm;

/** Static pi-ai SUBPATH specifier (bare root is fine; dynamic imports are checked below). */
const STATIC_SUBPATH_SPECIFIER = /(?:\bfrom\s*|\bimport\s*)["']@earendil-works\/pi-ai\/[^"']+["']/g;

/** Dynamic bare pi-ai subpath import — must never appear in src/. */
const DYNAMIC_SUBPATH_IMPORT = /\bimport\s*\(\s*["']@earendil-works\/pi-ai\/[^"']+["']\s*\)/g;

/** pi's jiti loader only rewrites `import.meta.<prop>`; a bare `import.meta` is a SyntaxError in its CommonJS wrapper. */
const BARE_IMPORT_META = /\bimport\.meta\b(?!\s*\.)/g;

describe("extension load contract (pi module interception)", () => {
	test("static pi-ai imports use only the bare root specifier", () => {
		const offenders: string[] = [];
		for (const file of tsFiles(SRC_DIR)) {
			const source = readFileSync(file, "utf8").replace(TYPE_ONLY_STATEMENT, "");
			for (const match of source.matchAll(STATIC_SUBPATH_SPECIFIER)) {
				offenders.push(`${file.replace(SRC_DIR, "src")}: ${match[0]}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("no dynamic bare pi-ai subpath import", () => {
		const offenders: string[] = [];
		for (const file of tsFiles(SRC_DIR)) {
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(DYNAMIC_SUBPATH_IMPORT)) {
				offenders.push(`${file.replace(SRC_DIR, "src")}: ${match[0]}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("no bare import.meta expression", () => {
		const offenders: string[] = [];
		for (const file of tsFiles(SRC_DIR)) {
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(BARE_IMPORT_META)) {
				offenders.push(`${file.replace(SRC_DIR, "src")}: ${match[0]}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

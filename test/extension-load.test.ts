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
 * Contract enforced here: src/ statically imports ONLY the bare pi-ai root.
 * The compat entrypoint re-exports every lazy API factory (verified on
 * pi-ai 0.83.0 and 0.84.4), so the root specifier works under every pi
 * loading mode. Subpath specifiers may appear only inside dynamic import()
 * — the plain-node fallback, never reached under pi.
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

/** Static pi-ai SUBPATH specifier (bare root is fine; dynamic import() is fine). */
const STATIC_SUBPATH_SPECIFIER = /(?:\bfrom\s*|\bimport\s*)["']@earendil-works\/pi-ai\/[^"']+["']/g;

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
});

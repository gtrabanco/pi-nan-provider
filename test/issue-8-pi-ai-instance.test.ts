/**
 * Regression tests for issue #8.
 *
 * On pi-web's sessiond-on-Bun loader path the bare root
 * `@earendil-works/pi-ai` is NOT aliased to pi's `/compat` entrypoint, so it
 * resolves to the host's pi-ai 0.87 **core** (no `openAICompletionsApi`),
 * while the old bare subpath fallback resolved to a stale hoisted
 * `@earendil-works/pi-ai@0.85.1` in the extension tree. That copy's
 * `estimateMessageTokens` lacks the `system` branch and crashes pi 0.87
 * transcripts with `block.name.length`.
 *
 * `src/pi-ai-loader.ts` binds the factory to the same package instance as the
 * bare-root import: derive a file URL from the host-resolved package root.
 * These tests prove that binding with real temp-package fixtures (offline),
 * plus the default-host path against the actually installed pi-ai.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	PI_AI_PACKAGE_SPECIFIER,
	PiAiStreamingApiResolutionError,
	openAICompletionsApiFrom,
	resolveOpenAICompletionsApi,
	type ModuleNamespace,
	type OpenAICompletionsApiFactory,
	type PiAiLoaderHost,
} from "../src/pi-ai-loader.ts";

/** Minimal fake api; the loader only needs the factory identity, not a real stream. */
interface FixtureApi {
	readonly tag: string;
	stream(): void;
	streamSimple(): void;
}

function fixtureFactory(tag: string): OpenAICompletionsApiFactory {
	const api: FixtureApi = { tag, stream() {}, streamSimple() {} };
	return (() => api) as unknown as OpenAICompletionsApiFactory;
}

function fixtureSource(tag: string): string {
	return [
		`export const openAICompletionsApi = () => ({`,
		`  tag: ${JSON.stringify(tag)},`,
		"  stream() {},",
		"  streamSimple() {},",
		"});",
	].join("\n");
}

const createdDirs: string[] = [];
afterAll(() => {
	for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "nan-issue8-"));
	createdDirs.push(dir);
	return dir;
}

/** A package root containing only a core `index.js` marker. */
function createCorePackage(root: string, name: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "index.js"), `export const tag = ${JSON.stringify(`${name}-core`)};\n`);
	return dir;
}

function writeLazyEntry(pkgDir: string, tag: string): void {
	mkdirSync(join(pkgDir, "api"), { recursive: true });
	writeFileSync(join(pkgDir, "api", "openai-completions.lazy.js"), fixtureSource(tag));
}

function writeCompatEntry(pkgDir: string, tag: string): void {
	writeFileSync(join(pkgDir, "compat.js"), fixtureSource(tag));
}

const realImport = (url: string): Promise<ModuleNamespace> =>
	import(url) as Promise<ModuleNamespace>;

function recordingImport(): {
	importModule: (url: string) => Promise<ModuleNamespace>;
	calls: string[];
} {
	const calls: string[] = [];
	return {
		calls,
		importModule: async (url: string) => {
			calls.push(url);
			return realImport(url);
		},
	};
}

describe("issue #8 — pi-ai instance resolution", () => {
	test("root factory wins without touching the resolver or the module loader", async () => {
		const factory = fixtureFactory("root");
		let resolved = 0;
		let imported = 0;
		const host: PiAiLoaderHost = {
			namespace: { openAICompletionsApi: factory },
			resolveSpecifier: () => {
				resolved += 1;
				return "";
			},
			importModule: async () => {
				imported += 1;
				return {};
			},
		};

		expect(await resolveOpenAICompletionsApi(host)).toBe(factory);
		expect(resolved).toBe(0);
		expect(imported).toBe(0);
	});

	test("core root derives the factory from the host-resolved instance, not the decoy tree", async () => {
		const root = tmpRoot();
		const hostPkg = createCorePackage(root, "host-pkg");
		writeLazyEntry(hostPkg, "host");
		writeCompatEntry(hostPkg, "host-compat");
		// Decoy: a second package whose copy must never be selected.
		const ownPkg = createCorePackage(root, "own-pkg");
		writeLazyEntry(ownPkg, "own");

		const recorder = recordingImport();
		const host: PiAiLoaderHost = {
			namespace: {}, // core root: no factory
			resolveSpecifier: (specifier) => {
				expect(specifier).toBe(PI_AI_PACKAGE_SPECIFIER);
				return pathToFileURL(join(hostPkg, "index.js")).href;
			},
			importModule: recorder.importModule,
		};

		const api = (await resolveOpenAICompletionsApi(host))() as unknown as FixtureApi;
		expect(api.tag).toBe("host");

		const lazyUrl = pathToFileURL(join(hostPkg, "api", "openai-completions.lazy.js")).href;
		expect(recorder.calls).toContain(lazyUrl);
		for (const url of recorder.calls) expect(url.startsWith("file://")).toBe(true);
		for (const url of recorder.calls) expect(url).not.toContain(`${PI_AI_PACKAGE_SPECIFIER}/`);
	});

	test("falls back to the sibling compat entry when the lazy entry is absent", async () => {
		const root = tmpRoot();
		const hostPkg = createCorePackage(root, "host-pkg");
		writeCompatEntry(hostPkg, "host-compat");

		const recorder = recordingImport();
		const api = (
			await resolveOpenAICompletionsApi({
				namespace: {},
				resolveSpecifier: () => pathToFileURL(join(hostPkg, "index.js")).href,
				importModule: recorder.importModule,
			})
		)() as unknown as FixtureApi;

		expect(api.tag).toBe("host-compat");
		expect(recorder.calls).toContain(pathToFileURL(join(hostPkg, "compat.js")).href);
	});

	test("fails loudly instead of loading a stale copy when no candidate resolves", async () => {
		const root = tmpRoot();
		const emptyPkg = createCorePackage(root, "empty-pkg");

		let caught: unknown;
		try {
			await resolveOpenAICompletionsApi({
				namespace: {},
				resolveSpecifier: () => pathToFileURL(join(emptyPkg, "index.js")).href,
				importModule: (url) => Promise.reject(new Error(`module not found: ${url}`)),
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(PiAiStreamingApiResolutionError);
		const err = caught as PiAiStreamingApiResolutionError;
		expect(err.message).toContain(emptyPkg);
		expect(err.message).toContain("refuses to load a stale");
		expect(err.attemptedUrls.length).toBeGreaterThanOrEqual(2);
		expect(err.resolvedRootUrl).toBe(pathToFileURL(join(emptyPkg, "index.js")).href);
	});

	test("default host resolves a usable factory against the actually installed pi-ai", async () => {
		const api = (await resolveOpenAICompletionsApi())() as unknown as {
			stream?: unknown;
			streamSimple?: unknown;
		};
		expect(typeof api.stream).toBe("function");
		expect(typeof api.streamSimple).toBe("function");
	});

	test("openAICompletionsApiFrom ignores non-namespaces and non-functions", () => {
		expect(openAICompletionsApiFrom(undefined)).toBeUndefined();
		expect(openAICompletionsApiFrom(null)).toBeUndefined();
		expect(openAICompletionsApiFrom("nope")).toBeUndefined();
		expect(openAICompletionsApiFrom({ openAICompletionsApi: 42 })).toBeUndefined();
	});
});

/**
 * Resolve the `openai-completions` streaming API factory from the **same
 * `@earendil-works/pi-ai` package instance** the host resolved for this
 * extension's bare-root import — never from a bare subpath specifier.
 *
 * ## Why this module exists (issue #8)
 *
 * `src/provider-factory.ts` used to fall back to a bare SUBPATH import of the
 * `api/openai-completions.lazy` entry. That is not the same module as the bare
 * root on every runtime. On pi-web's
 * sessiond-on-Bun loader path the bare root `@earendil-works/pi-ai` is NOT
 * aliased to pi's `/compat` entrypoint: it resolves to the host's pi-ai 0.87
 * **core** build (whose namespace has no `openAICompletionsApi`), while the
 * bare subpath resolves, from the extension's own tree, to a stale hoisted
 * `@earendil-works/pi-ai@0.85.1`. That copy's `estimateMessageTokens` has no
 * `system` branch, so pi 0.87's string-content `system` transcript message is
 * iterated character-by-character and crashes on
 * `undefined is not an object (evaluating 'block.name.length')` — before the
 * request is ever sent, so it reads like a NaN/gateway failure.
 *
 * `import.meta.resolve("@earendil-works/pi-ai")` returns the *same instance*
 * the bare-root static import used in every environment measured (both the
 * host's 0.87 core on pi-web, and the extension-tree copy under plain
 * node/jiti). It is therefore the anchor: derive a **file URL** for the
 * sibling `api/openai-completions.lazy.js` (then `compat.js`) from that
 * root and dynamic-import the URL. A file URL bypasses package resolution
 * entirely, so the loaded module is guaranteed to be the host's instance.
 *
 * Under the bundled CLI / Node-mode aliases / compiled binary, the bare root
 * is the compat entrypoint and already exposes the factory, so the first
 * branch wins and nothing is resolved.
 *
 * **Contract:** no bare `@earendil-works/pi-ai/<subpath>` specifier is ever
 * imported from `src/` (static or dynamic). When neither the root nor the
 * host-derived candidates provide the factory, resolution fails loudly with
 * `PiAiStreamingApiResolutionError` instead of silently loading a stale copy.
 *
 * Guarded by `test/issue-8-pi-ai-instance.test.ts` and
 * `test/extension-load.test.ts`.
 */

import * as piAi from "@earendil-works/pi-ai";
import type { ProviderStreams } from "@earendil-works/pi-ai";
import { createRequire } from "node:module";

/** The only pi-ai specifier this package may import. */
export const PI_AI_PACKAGE_SPECIFIER = "@earendil-works/pi-ai";

/** Export name of the openai-completions lazy factory on compat/lazy entrypoints. */
export const OPENAI_COMPLETIONS_FACTORY_EXPORT = "openAICompletionsApi";

/** Package-relative path of the lazy openai-completions entrypoint. */
export const OPENAI_COMPLETIONS_LAZY_ENTRY = "api/openai-completions.lazy.js";

/** Package-relative path of pi-ai's compat entrypoint (secondary candidate). */
export const PI_AI_COMPAT_ENTRY = "compat.js";

/** pi-ai's lazy API factory shape (same as the compat root export). */
export type OpenAICompletionsApiFactory = () => ProviderStreams;

/** A dynamically imported module namespace. */
export type ModuleNamespace = Record<string, unknown>;

/**
 * The resolution seam. Production uses {@link defaultPiAiLoaderHost}; tests
 * inject a host to prove the loader binds to the resolved instance (and never
 * to the extension's own tree).
 */
export interface PiAiLoaderHost {
	/** The bare-root namespace this extension statically imported. */
	readonly namespace: ModuleNamespace;
	/** Resolve a specifier the way the host runtime does. */
	resolveSpecifier?(specifier: string): string;
	/** Load a module by absolute URL (a `file://` URL in the derived path). */
	importModule(url: string): Promise<ModuleNamespace>;
}

/**
 * Thrown when the openai-completions factory cannot be bound to the
 * host-resolved pi-ai instance. Carries the resolved root and the URLs that
 * were attempted so the failure is a one-line diagnosis.
 */
export class PiAiStreamingApiResolutionError extends Error {
	readonly resolvedRootUrl?: string;
	readonly attemptedUrls: readonly string[];

	constructor(
		message: string,
		options: { resolvedRootUrl?: string; attemptedUrls?: readonly string[] } = {},
	) {
		super(message);
		this.name = "PiAiStreamingApiResolutionError";
		this.resolvedRootUrl = options.resolvedRootUrl;
		this.attemptedUrls = options.attemptedUrls ?? [];
	}
}

/** Extract the openai-completions factory from a module namespace, if present. */
export function openAICompletionsApiFrom(namespace: unknown): OpenAICompletionsApiFactory | undefined {
	if (namespace === null || typeof namespace !== "object") return undefined;
	const candidate = (namespace as ModuleNamespace)[OPENAI_COMPLETIONS_FACTORY_EXPORT];
	return typeof candidate === "function" ? (candidate as OpenAICompletionsApiFactory) : undefined;
}

/**
 * `import.meta.resolve` is absent from bun-types' `ImportMeta`, so read it
 * through an explicit shape. Bun/Node expose it at runtime; when it is missing
 * or throws, `createRequire` resolves the same bare root from this module.
 */
type ImportMetaWithResolve = ImportMeta & { resolve?: (specifier: string) => string };

const defaultPiAiLoaderHost: PiAiLoaderHost = {
	namespace: piAi as unknown as ModuleNamespace,
	resolveSpecifier(specifier: string): string {
		const meta = import.meta as ImportMetaWithResolve;
		if (typeof meta.resolve === "function") {
			try {
				const resolved = meta.resolve(specifier);
				if (typeof resolved === "string" && resolved.length > 0) return resolved;
			} catch {
				// Fall through to createRequire — same bare root, same instance.
			}
		}
		return createRequire(import.meta.url).resolve(specifier);
	},
	importModule: (url: string) => import(url) as Promise<ModuleNamespace>,
};

/** Cached result of the default-host resolution; injected hosts bypass it. */
let defaultHostCache: OpenAICompletionsApiFactory | undefined;

/** Build the candidate file URLs from the host-resolved package root. */
function candidateUrlsFor(rootUrl: string): { rootDir: URL; candidates: string[] } {
	const rootDir = new URL("./", new URL(rootUrl));
	return {
		rootDir,
		candidates: [
			new URL(OPENAI_COMPLETIONS_LAZY_ENTRY, rootDir).href,
			new URL(PI_AI_COMPAT_ENTRY, rootDir).href,
		],
	};
}

function loudError(
	rootUrl: string | undefined,
	attemptedUrls: readonly string[],
	lastError: Error | undefined,
): PiAiStreamingApiResolutionError {
	const lines = [
		`Could not resolve "${OPENAI_COMPLETIONS_FACTORY_EXPORT}" from the host-resolved "${PI_AI_PACKAGE_SPECIFIER}" instance.`,
		`Resolved root: ${rootUrl ?? "<unresolved>"}`,
		attemptedUrls.length > 0
			? `Attempted URLs:\n${attemptedUrls.map((url) => `  - ${url}`).join("\n")}`
			: "Attempted URLs: none (package root resolution failed)",
		lastError ? `Last error: ${lastError.message}` : undefined,
		"",
		"This provider refuses to load a stale @earendil-works/pi-ai from the extension's own npm tree (issue #8).",
		"On pi-web's sessiond-on-Bun loader the bare root is not mapped to pi's /compat entrypoint, so the",
		"factory must be imported from a file URL derived from import.meta.resolve(...) — never a bare subpath.",
	];
	return new PiAiStreamingApiResolutionError(lines.filter((line) => line !== undefined).join("\n"), {
		resolvedRootUrl: rootUrl,
		attemptedUrls,
	});
}

/**
 * @param host Resolution seam; omit in production.
 * @returns The openai-completions lazy API factory from the host's pi-ai instance.
 * @throws PiAiStreamingApiResolutionError when no candidate can be bound.
 */
export async function resolveOpenAICompletionsApi(
	host?: PiAiLoaderHost,
): Promise<OpenAICompletionsApiFactory> {
	const usesDefaultHost = host === undefined;
	if (usesDefaultHost && defaultHostCache) return defaultHostCache;
	const activeHost = host ?? defaultPiAiLoaderHost;

	// 1. Compat root (bundled CLI / Node aliases / compiled binary): the bare
	//    root itself re-exports the factory — no resolution needed.
	const fromRoot = openAICompletionsApiFrom(activeHost.namespace);
	if (fromRoot) {
		if (usesDefaultHost) defaultHostCache = fromRoot;
		return fromRoot;
	}

	// 2. Core root (pi-web on Bun): anchor to the host-resolved package root.
	if (typeof activeHost.resolveSpecifier !== "function") {
		throw loudError(undefined, [], undefined);
	}

	let rootUrl: string | undefined;
	try {
		rootUrl = activeHost.resolveSpecifier(PI_AI_PACKAGE_SPECIFIER);
	} catch (error) {
		throw loudError(undefined, [], error instanceof Error ? error : new Error(String(error)));
	}
	if (!rootUrl) throw loudError(undefined, [], undefined);

	// 3. Derive file URLs from the resolved root. The directory-prefix guard is
	//    the same-package-instance assertion: a candidate must stay inside the
	//    package the host resolved.
	const { rootDir, candidates } = candidateUrlsFor(rootUrl);
	const attemptedUrls: string[] = [];
	let lastError: Error | undefined;
	for (const candidate of candidates) {
		if (!candidate.startsWith(rootDir.href)) {
			throw loudError(
				rootUrl,
				attemptedUrls,
				new Error(`candidate "${candidate}" escapes the resolved package root "${rootDir.href}"`),
			);
		}
		attemptedUrls.push(candidate);
		try {
			const factory = openAICompletionsApiFrom(await activeHost.importModule(candidate));
			if (factory) {
				if (usesDefaultHost) defaultHostCache = factory;
				return factory;
			}
			lastError = new Error(`"${OPENAI_COMPLETIONS_FACTORY_EXPORT}" is not exported by ${candidate}`);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}

	throw loudError(rootUrl, attemptedUrls, lastError);
}

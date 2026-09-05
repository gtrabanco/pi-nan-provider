import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ApiKeyCredential, AuthContext, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import { NAN_GENERATED_MODELS } from "../scripts/models.generated.ts";
import extension from "../src/index.ts";
import { createNanCompatibleProvider } from "../src/provider-factory.ts";
import { NAN_PROVIDER, PROVIDERS } from "../src/providers.ts";

/** Stub AuthContext backed by a plain env map. */
function authContext(env: Record<string, string | undefined>): AuthContext {
	return {
		env: async (name) => env[name],
		fileExists: async () => false,
	};
}

function jsonFetch(body: unknown, status = 200): typeof fetch {
	return (async () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		})) as unknown as typeof fetch;
}

describe("createNanCompatibleProvider (registration shape)", () => {
	test("registers with the NaN provider identity and the generated catalog as baseline", async () => {
		const provider = await createNanCompatibleProvider(NAN_PROVIDER);
		expect(provider.id).toBe("nan");
		expect(provider.name).toBe("NaN");
		expect(provider.baseUrl).toBe("https://api.nan.builders/v1");
		expect(provider.getModels().length).toBe(NAN_GENERATED_MODELS.length);
		for (const model of provider.getModels()) {
			expect(model.api).toBe("openai-completions");
			expect(model.provider).toBe("nan");
		}
		// The openai-completions streaming implementation must be resolved and
		// wired (root specifier under pi's compat entry, lazy subpath fallback
		// under plain node/bun — never a static pi-ai subpath import).
		expect(typeof provider.stream).toBe("function");
		expect(typeof provider.streamSimple).toBe("function");
	});

	test("exposes api-key auth with the provider display name", async () => {
		const provider = await createNanCompatibleProvider(NAN_PROVIDER);
		expect(provider.auth.apiKey?.name).toBe("NaN API key");
	});

	test("factory is shared: a second config works through the same code path", async () => {
		// Contract test for "shared by nan + helmcode": no provider-specific file,
		// just another config. The endpoint here is a test fixture, not a claim.
		const helmcode = await createNanCompatibleProvider({
			id: "helmcode",
			name: "HelmCode",
			baseUrl: "https://helmcode.example/v1",
			envVars: ["HELLMCODE_API_KEY"],
		});
		expect(helmcode.id).toBe("helmcode");
		expect(helmcode.auth.apiKey?.name).toBe("HelmCode API key");

		const resolved = await helmcode.auth.apiKey!.resolve({
			ctx: authContext({ HELLMCODE_API_KEY: "hc-env-key" }),
			signal: new AbortController().signal,
		});
		expect(resolved?.auth.apiKey).toBe("hc-env-key");
		expect(resolved?.source).toBe("HELLMCODE_API_KEY");
	});
});

describe("auth resolution (stored credential / env var / missing)", () => {
	const resolve = async (env: Record<string, string | undefined>, credential?: ApiKeyCredential) => {
		const provider = await createNanCompatibleProvider(NAN_PROVIDER);
		return provider.auth.apiKey!.resolve({
			ctx: authContext(env),
			...(credential ? { credential } : {}),
			signal: new AbortController().signal,
		});
	};

	test("stored credential wins over the env var", async () => {
		const resolved = await resolve({ NAN_API_KEY: "env-key" }, { type: "api_key", key: "stored-key" });
		expect(resolved?.auth.apiKey).toBe("stored-key");
		expect(resolved?.source).toBe("stored credential");
	});

	test("env var is used when nothing is stored", async () => {
		const resolved = await resolve({ NAN_API_KEY: "env-key" });
		expect(resolved?.auth.apiKey).toBe("env-key");
		expect(resolved?.source).toBe("NAN_API_KEY");
	});

	test("undefined when neither a stored credential nor the env var exists", async () => {
		const resolved = await resolve({});
		expect(resolved).toBeUndefined();
	});

	test("empty env var value does not count as configured", async () => {
		const resolved = await resolve({ NAN_API_KEY: "" });
		expect(resolved).toBeUndefined();
	});

	test("login prompts for a secret and returns an api_key credential", async () => {
		const provider = await createNanCompatibleProvider(NAN_PROVIDER);
		const login = provider.auth.apiKey!.login!;
		const prompts: unknown[] = [];
		const key = "sk-new-key";
		const credential = await login({
			signal: new AbortController().signal,
			prompt: async (prompt) => {
				prompts.push(prompt);
				return key;
			},
			notify: () => {},
		} as Parameters<typeof login>[0]);
		expect(credential).toEqual({ type: "api_key", key });
		expect(prompts[0]).toMatchObject({ type: "secret" });
	});
});

describe("fetchModels wiring through createProvider", () => {
	function refreshContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
		return {
			allowNetwork: true,
			signal: new AbortController().signal,
			publish: async () => true,
			...overrides,
		} as RefreshModelsContext;
	}

	test("refresh with network merges live ids and publishes the overlay", async () => {
		const provider = await createNanCompatibleProvider(NAN_PROVIDER, {
			fetchImpl: jsonFetch({ data: [{ id: "qwen3.6" }, { id: "mystery-model" }] }),
		});
		let published = false;
		await provider.refreshModels!(
			refreshContext({
				credential: { type: "api_key", key: "sk-live" },
				publish: async (publication) => {
					publication.update?.();
					published = true;
					return true;
				},
			}),
		);
		expect(published).toBe(true);
		const models = provider.getModels() as Model<"openai-completions">[];
		expect(models.some((model) => model.id === "mystery-model")).toBe(true);
		expect(models.find((model) => model.id === "qwen3.6")!.contextWindow).toBe(262_144);
	});

	test("failed live fetch keeps the provider usable with the baseline catalog", async () => {
		const provider = await createNanCompatibleProvider(NAN_PROVIDER, { fetchImpl: jsonFetch({}, 500) });
		await provider.refreshModels!(
			refreshContext({
				credential: { type: "api_key", key: "sk-live" },
				publish: async (publication) => {
					publication.update?.();
					return true;
				},
			}),
		);
		expect(provider.getModels().length).toBe(NAN_GENERATED_MODELS.length);
	});

	test("refresh without network access does not call the endpoint", async () => {
		let fetched = false;
		const provider = await createNanCompatibleProvider(NAN_PROVIDER, {
			fetchImpl: (async () => {
				fetched = true;
				throw new Error("should not be called");
			}) as unknown as typeof fetch,
		});
		await provider.refreshModels!(refreshContext({ allowNetwork: false }));
		expect(fetched).toBe(false);
	});
});

describe("extension entrypoint", () => {
	test("registers every configured provider via pi.registerProvider", async () => {
		const registered: unknown[] = [];
		const fakePi = {
			registerProvider: (provider: unknown) => {
				registered.push(provider);
			},
		} as unknown as ExtensionAPI;

		await extension(fakePi);

		expect(registered.length).toBe(PROVIDERS.length);
		const provider = registered[0] as { id: string; name: string; baseUrl: string; auth: unknown; getModels: () => unknown[] };
		expect(provider.id).toBe("nan");
		expect(provider.baseUrl).toBe("https://api.nan.builders/v1");
		expect(provider.getModels().length).toBeGreaterThan(0);
	});
});

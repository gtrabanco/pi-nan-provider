import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	MODEL_QUOTAS,
	buildUsageMessage,
	currentMonthWindow,
	formatUsageError,
	rollingWindow,
	parseUsageArgs,
	registerNanUsageCommand,
	type UsageReport,
} from "../src/usage.ts";

// ── Harness ───────────────────────────────────────────────────────────────

function fakePi() {
	const recorded: Array<{ name: string; handler: (args: string, ctx: unknown) => Promise<void> }> = [];
	const pi = {
		registerCommand: (name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			recorded.push({ name, handler: definition.handler });
		},
	} as never;
	return { pi, recorded };
}

function fakeCtx(apiKey?: string) {
	const notifications: Array<{ message: string; level: string }> = [];
	const ctx = {
		ui: {
			notify: (message: string, level: string) => {
				notifications.push({ message, level });
			},
		},
		modelRegistry: {
			getApiKeyForProvider: async (_provider: string) => apiKey,
		},
	};
	return { ctx, notifications };
}

/** Scoped NAN_API_KEY so an ambient key can never leak into a test. */
function envScope() {
	const saved = process.env.NAN_API_KEY;
	return {
		set(value: string) {
			process.env.NAN_API_KEY = value;
		},
		restore() {
			if (saved === undefined) delete process.env.NAN_API_KEY;
			else process.env.NAN_API_KEY = saved;
		},
	};
}

afterEach(() => {
	delete process.env.NAN_API_KEY;
});

interface CapturedRequest {
	url: string;
	headers: Record<string, string>;
}

function recordingFetch(response: Response | (() => Promise<Response>), captured: CapturedRequest[]): typeof fetch {
	return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
		captured.push({
			url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
			headers: Object.fromEntries(
				Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
			),
		});
		return typeof response === "function" ? response() : response;
	}) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

/** Usage report fixture covering a capped model, an uncapped one and an unknown model. */
function usageReportFixture(): UsageReport {
	return {
		object: "usage.report",
		start_date: "2026-09-01",
		end_date: "2026-09-27",
		data: [],
		totals: {
			prompt_tokens: 2_450_000,
			completion_tokens: 890_000,
			total_tokens: 3_340_000,
			api_requests: 12_500,
			by_model: [
				{ model: "deepseek-v4-flash", prompt_tokens: 900_000_000, completion_tokens: 300_000_000, total_tokens: 1_200_000_000, api_requests: 310 },
				{ model: "qwen3.6", prompt_tokens: 700_000, completion_tokens: 190_500, total_tokens: 890_500, api_requests: 123 },
				{ model: "brand-new-model", prompt_tokens: 4_000, completion_tokens: 1_000, total_tokens: 5_000, api_requests: 3 },
			],
		},
		all_time: {
			prompt_tokens: 9_800_000,
			completion_tokens: 3_400_000,
			total_tokens: 13_200_000,
			api_requests: 41_250,
			cached_at: "2026-02-01T12:00:00Z",
		},
		has_more: false,
		next_cursor: null,
	};
}

// ── Registration + static fallback ────────────────────────────────────────

describe("/nan-usage command", () => {
	test("registers under the nan-usage name", () => {
		const { pi, recorded } = fakePi();
		registerNanUsageCommand(pi);
		expect(recorded.length).toBe(1);
		expect(recorded[0]!.name).toBe("nan-usage");
	});

	test("static mode: shows quota limits when no API key resolves", async () => {
		const { pi, recorded } = fakePi();
		const { ctx, notifications } = fakeCtx(undefined);
		registerNanUsageCommand(pi);
		await recorded[0]!.handler("", ctx);

		expect(notifications.length).toBe(1);
		expect(notifications[0]!.level).toBe("info");
		expect(notifications[0]!.message).toContain("NaN Quota Status");
		expect(notifications[0]!.message).toContain("DeepSeek V4 Flash");
		expect(notifications[0]!.message).toContain("3.0B");
		expect(notifications[0]!.message).toContain("uncapped");
		expect(notifications[0]!.message).toContain("Next billing reset");
		// The API-key path replaces the old NaN CLI login flow entirely.
		expect(notifications[0]!.message).toContain("NAN_API_KEY");
		expect(notifications[0]!.message).not.toContain("nan auth login");
	});

	test("model quotas contain all expected models", () => {
		const models = MODEL_QUOTAS.map((q) => q.model);
		expect(models).toContain("deepseek-v4-flash");
		expect(models).toContain("mimo-v2.6-flash");
		expect(models).toContain("qwen3.6");
		expect(models).toContain("gemma4");
		expect(models).toContain("qwen3.8-flash");
		expect(models).toContain("glm5.3-flash");
		expect(models).toContain("glm5.3");
		// mimo-v2.5 is no longer documented by NaN (https://nan.builders/docs/models,
		// checked 2026-09-29), so its quota row would claim a cap with no source.
		// Its historical consumption still surfaces from GET /v1/usage under the
		// "models missing from the documented table" section.
		expect(models).not.toContain("mimo-v2.5");
	});

	test("mimo-v2.6-flash has the documented 1.0B monthly quota", () => {
		// https://nan.builders/docs/models#mimo-v2-6-flash (checked 2026-09-29):
		// "1.0B token monthly quota per member."
		const quota = MODEL_QUOTAS.find((q) => q.model === "mimo-v2.6-flash");
		expect(quota).toBeDefined();
		expect(quota!.monthlyCap).toBe(1_000_000_000);
		expect(quota!.premium).toBe(false);
	});

	test("glm5.3 is marked as premium with rolling window", () => {
		const glm53 = MODEL_QUOTAS.find((q) => q.model === "glm5.3");
		expect(glm53).toBeDefined();
		expect(glm53!.premium).toBe(true);
		expect(glm53!.rollingWindowCap).toBe(400_000_000);
		expect(glm53!.rollingWindowHours).toBe(4);
	});

	test("uncapped models have monthlyCap 0", () => {
		const qwen36 = MODEL_QUOTAS.find((q) => q.model === "qwen3.6");
		const gemma4 = MODEL_QUOTAS.find((q) => q.model === "gemma4");
		expect(qwen36!.monthlyCap).toBe(0);
		expect(gemma4!.monthlyCap).toBe(0);
	});
});

// ── /v1/usage client ──────────────────────────────────────────────────────

describe("/nan-usage against GET /v1/usage", () => {
	test("calls the usage endpoint with the stored credential over the current UTC month", async () => {
		const captured: CapturedRequest[] = [];
		const { pi, recorded } = fakePi();
		const { ctx, notifications } = fakeCtx("sk-registry");
		const env = envScope();
		env.set("sk-env");
		registerNanUsageCommand(pi, { fetchImpl: recordingFetch(jsonResponse(usageReportFixture()), captured) });
		await recorded[0]!.handler("", ctx);
		env.restore();

		expect(captured.length).toBe(1);
		const [request] = captured;
		expect(request!.url.startsWith("https://api.nan.builders/v1/usage?")).toBe(true);
		expect(request!.url).toContain(`start_date=${currentMonthWindow().start}`);
		expect(request!.url).toContain(`end_date=${currentMonthWindow().end}`);
		expect(request!.headers.authorization).toBe("Bearer sk-registry");

		const result = notifications.at(-1)!;
		expect(result.level).toBe("info");
		expect(result.message).toContain("NaN Usage");
		// the header shows the window the endpoint actually served (fixture data)
		expect(result.message).toContain("2026-09-01 → 2026-09-27");
		// capped model, merged with the documented cap
		expect(result.message).toContain("DeepSeek V4 Flash");
		expect(result.message).toContain("1.2B / 3.0B");
		expect(result.message).toContain("40.0%");
		// uncapped model with usage
		expect(result.message).toContain("Qwen 3.6");
		expect(result.message).toContain("890.5K");
		// unknown model still surfaces
		expect(result.message).toContain("brand-new-model");
		// window + all-time totals
		expect(result.message).toContain("3.3M");
		expect(result.message).toContain("13.2M");
		expect(result.message).toContain("Next billing reset");
	});

	test("falls back to NAN_API_KEY when the registry has no credential", async () => {
		const captured: CapturedRequest[] = [];
		const { pi, recorded } = fakePi();
		const { ctx, notifications } = fakeCtx(undefined);
		const env = envScope();
		env.set("sk-env");
		registerNanUsageCommand(pi, { fetchImpl: recordingFetch(jsonResponse(usageReportFixture()), captured) });
		await recorded[0]!.handler("", ctx);
		env.restore();

		expect(captured[0]!.headers.authorization).toBe("Bearer sk-env");
		expect(notifications.at(-1)!.message).toContain("NaN Usage");
	});

	test("a custom rolling window is requested as given (1–90 days)", async () => {
		const captured: CapturedRequest[] = [];
		const { pi, recorded } = fakePi();
		const { ctx } = fakeCtx("sk-test");
		registerNanUsageCommand(pi, { fetchImpl: recordingFetch(jsonResponse(usageReportFixture()), captured) });
		await recorded[0]!.handler("30", ctx);

		const expected = rollingWindow(30);
		expect(captured[0]!.url).toContain(`start_date=${expected.start}`);
		expect(captured[0]!.url).toContain(`end_date=${expected.end}`);
		expect(expected.end).toBe(rollingWindow(1).end);
	});

	test("unknown arguments warn with the usage line and never fetch", async () => {
		const captured: CapturedRequest[] = [];
		const { pi, recorded } = fakePi();
		const { ctx, notifications } = fakeCtx("sk-test");
		registerNanUsageCommand(pi, { fetchImpl: recordingFetch(jsonResponse(usageReportFixture()), captured) });
		await recorded[0]!.handler("yesterday", ctx);

		expect(captured.length).toBe(0);
		expect(notifications[0]!.level).toBe("warning");
		expect(notifications[0]!.message).toContain("Usage: /nan-usage");
	});

	test("`help` prints the usage line without fetching", async () => {
		const captured: CapturedRequest[] = [];
		const { pi, recorded } = fakePi();
		const { ctx, notifications } = fakeCtx("sk-test");
		registerNanUsageCommand(pi, { fetchImpl: recordingFetch(jsonResponse(usageReportFixture()), captured) });
		await recorded[0]!.handler("--help", ctx);

		expect(captured.length).toBe(0);
		expect(notifications[0]!.level).toBe("info");
		expect(notifications[0]!.message).toContain("Usage: /nan-usage");
	});
});

// ── Error mapping ─────────────────────────────────────────────────────────

describe("/nan-usage error reporting", () => {
	const run = async (response: Response | (() => Promise<Response>)) => {
		const { pi, recorded } = fakePi();
		const { ctx, notifications } = fakeCtx("sk-test");
		registerNanUsageCommand(pi, { fetchImpl: recordingFetch(response, []) });
		await recorded[0]!.handler("", ctx);
		return notifications.at(-1)!;
	};

	test("401 points at the pi login flow", async () => {
		const result = await run(jsonResponse({ error: { message: "Invalid API key" } }, 401));
		expect(result.level).toBe("warning");
		expect(result.message).toContain("401");
		expect(result.message).toContain("/login nan");
	});

	test("404 explains the missing usage identity", async () => {
		const result = await run(jsonResponse({ error: { message: "No usage identity" } }, 404));
		expect(result.level).toBe("warning");
		expect(result.message).toContain("404");
		expect(result.message).toContain("identity");
	});

	test("429 surfaces Retry-After", async () => {
		const result = await run(
			jsonResponse({ error: { message: "Rate limit exceeded" } }, 429, { "retry-after": "7" }),
		);
		expect(result.level).toBe("warning");
		expect(result.message).toContain("429");
		expect(result.message).toContain("7");
	});

	test("5xx reports a server-side failure", async () => {
		const result = await run(jsonResponse({ error: { message: "boom" } }, 503));
		expect(result.level).toBe("warning");
		expect(result.message).toContain("503");
	});

	test("transport failures never throw", async () => {
		const result = await run(() => Promise.reject(new Error("connection reset")));
		expect(result.level).toBe("warning");
		expect(result.message).toContain("connection reset");
	});
});

// ── Window + rendering units ──────────────────────────────────────────────

describe("usage window helpers", () => {
	test("the default window is the current UTC month", () => {
		const window = currentMonthWindow(new Date("2026-03-15T10:00:00Z"));
		expect(window.start).toBe("2026-03-01");
		expect(window.end).toBe("2026-03-15");
		expect(window.days).toBe(15);
	});

	test("rolling windows end today and span exactly N days", () => {
		const window = rollingWindow(7, new Date("2026-03-15T10:00:00Z"));
		expect(window.start).toBe("2026-03-09");
		expect(window.end).toBe("2026-03-15");
		expect(window.days).toBe(7);
	});

	test("the API's 90-day maximum is enforced client-side", () => {
		expect(rollingWindow(90).days).toBe(90);
		const now = new Date("2026-03-15T10:00:00Z");
		expect(parseUsageArgs(["91"], now)).toMatchObject({ kind: "invalid" });
		expect(parseUsageArgs(["0"], now)).toMatchObject({ kind: "invalid" });
		expect(parseUsageArgs(["abc"], now)).toMatchObject({ kind: "invalid" });
		expect(parseUsageArgs(["1", "2"], now)).toMatchObject({ kind: "invalid" });
		expect(parseUsageArgs([], now)).toMatchObject({ kind: "window" });
		expect(parseUsageArgs(["30"], now)).toMatchObject({ kind: "window" });
		expect(parseUsageArgs(["help"], now)).toMatchObject({ kind: "help" });
	});
});

describe("usage rendering", () => {
	test("a window with no usage says so instead of inventing numbers", () => {
		const message = buildUsageMessage({
			object: "usage.report",
			start_date: "2026-09-01",
			end_date: "2026-09-27",
			data: [],
			totals: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, api_requests: 0, by_model: [] },
			all_time: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, api_requests: 0, cached_at: null },
			has_more: false,
			next_cursor: null,
		} as UsageReport);
		expect(message).toContain("No usage");
		expect(message).toContain("0 requests");
	});

	test("percentages never exceed the bar width even when usage exceeds the cap", () => {
		const message = buildUsageMessage({
			object: "usage.report",
			start_date: "2026-09-01",
			end_date: "2026-09-27",
			data: [],
			totals: {
				prompt_tokens: 0,
				completion_tokens: 0,
				total_tokens: 4_000_000_000,
				api_requests: 10,
				by_model: [
					{ model: "deepseek-v4-flash", prompt_tokens: 0, completion_tokens: 0, total_tokens: 4_000_000_000, api_requests: 10 },
				],
			},
			all_time: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, api_requests: 0, cached_at: null },
			has_more: false,
			next_cursor: null,
		} as UsageReport);
		expect(message).toContain("133.3%");
		const bar = message.match(/\[(█*░*)\]/)!;
		expect(bar[1]!.length).toBe(20);
		expect(bar[1]!.replace(/█/g, "").length).toBe(0);
	});

	test("models whose request count NaN does not report say so instead of 0 requests", () => {
		const message = buildUsageMessage({
			object: "usage.report",
			start_date: "2026-09-01",
			end_date: "2026-09-27",
			data: [],
			totals: {
				prompt_tokens: 796_041_831,
				completion_tokens: 0,
				total_tokens: 796_041_831,
				api_requests: 0,
				by_model: [
					// live probe 2026-09-27: usage without a request count
					{ model: "qwen3.8-flash", prompt_tokens: 796_041_831, completion_tokens: 0, total_tokens: 796_041_831, api_requests: 0 },
				],
			},
			all_time: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, api_requests: 0, cached_at: null },
			has_more: false,
			next_cursor: null,
		} as UsageReport);
		expect(message).toContain("requests not reported");
		const line = message.split("\n").find((l) => l.includes("796.0M / 500.0M"))!;
		expect(line).toContain("requests not reported");
		expect(line).not.toContain("0 requests");
	});

	test("formatUsageError keeps every documented status actionable", () => {
		expect(formatUsageError({ status: 401 })).toContain("/login nan");
		expect(formatUsageError({ status: 404 })).toContain("identity");
		expect(formatUsageError({ status: 429, retryAfterSeconds: 12 })).toContain("12");
		expect(formatUsageError({ status: 400, detail: "window spans 120 days" })).toContain("120 days");
		expect(formatUsageError({ status: 409 })).toContain("service key");
		expect(formatUsageError({ detail: "getaddrinfo ENOTFOUND" })).toContain("ENOTFOUND");
	});
});

// ── Regression guard: no CLI session dependency ───────────────────────────

describe("nan-usage auth source", () => {
	test("the command has no runtime reference to the NaN CLI session file", () => {
		// Comments may mention the old flow for history; executable code may not.
		const source = readFileSync(new URL("../src/usage.ts", import.meta.url), "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		expect(source).not.toContain("session.json");
		expect(source).not.toContain("nan auth login");
		expect(source).not.toContain("cloud-api.nan.builders");
		expect(source).toContain("api.nan.builders/v1/usage");
	});
});

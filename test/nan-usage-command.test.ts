import { describe, expect, test } from "bun:test";
import { registerNanUsageCommand, MODEL_QUOTAS } from "../src/usage.ts";

function fakePi() {
	const recorded: Array<{ name: string; handler: (args: string, ctx: unknown) => Promise<void> }> = [];
	const pi = {
		registerCommand: (name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			recorded.push({ name, handler: definition.handler });
		},
	} as never;
	return { pi, recorded };
}

function fakeCtx() {
	const notifications: Array<{ message: string; level: string }> = [];
	const ctx = {
		ui: {
			notify: (message: string, level: string) => {
				notifications.push({ message, level });
			},
		},
	};
	return { ctx, notifications };
}

describe("/nan-usage command", () => {
	test("registers under the nan-usage name", () => {
		const { pi, recorded } = fakePi();
		registerNanUsageCommand(pi);
		expect(recorded.length).toBe(1);
		expect(recorded[0]!.name).toBe("nan-usage");
	});

	test("static mode: shows quota limits when no session file exists", async () => {
		const { pi, recorded } = fakePi();
		const { ctx, notifications } = fakeCtx();
		registerNanUsageCommand(pi);
		await recorded[0]!.handler("", ctx);

		expect(notifications.length).toBe(1);
		expect(notifications[0]!.level).toBe("info");
		expect(notifications[0]!.message).toContain("NaN Quota Status");
		expect(notifications[0]!.message).toContain("DeepSeek V4 Flash");
		expect(notifications[0]!.message).toContain("3.0B");
		expect(notifications[0]!.message).toContain("uncapped");
		expect(notifications[0]!.message).toContain("Next billing reset");
		expect(notifications[0]!.message).toContain("nan auth login");
	});

	test("model quotas contain all expected models", () => {
		const models = MODEL_QUOTAS.map((q) => q.model);
		expect(models).toContain("deepseek-v4-flash");
		expect(models).toContain("mimo-v2.5");
		expect(models).toContain("mimo-v2.6-flash");
		expect(models).toContain("qwen3.6");
		expect(models).toContain("gemma4");
		expect(models).toContain("qwen3.8-flash");
		expect(models).toContain("glm5.3-flash");
		expect(models).toContain("glm5.3");
	});

	test("mimo-v2.6-flash has the documented 1.0B monthly quota", () => {
		// https://nan.builders/docs/models#mimo-v2-6-flash (checked 2026-09-25):
		// "Same limits as mimo-v2.5: 1.0B token monthly quota per member."
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

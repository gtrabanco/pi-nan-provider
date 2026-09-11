import { describe, expect, test } from "bun:test";

/**
 * Contract: the suite must never reach the network (see test/network-guard.ts,
 * preloaded via bunfig.toml). If the preload is ever removed or overridden,
 * this fails — which is the point.
 */
describe("test network guard", () => {
	test("global fetch refuses live calls", async () => {
		await expect(fetch("https://api.nan.builders/v1/chat/completions")).rejects.toThrow("test-network-guard");
	});
});

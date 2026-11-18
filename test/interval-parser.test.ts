/**
 * Flexible interval parser tests for /nan-debug --interval flag.
 */

import { describe, expect, test } from "bun:test";
import { parseFlexibleTime } from "../src/debug-report.ts";

const FIXED_NOW = new Date("2026-11-11T12:00:00.000Z");

function isOk(r: unknown): r is { ok: false; error: string } {
	return typeof r === "object" && r !== null && "ok" in r && (r as { ok: boolean }).ok === false;
}

function asWindow(r: unknown): { start: string; end: string; days: number } | null {
	if (typeof r === "object" && r !== null && "start" in r && "end" in r && "days" in r) {
		return r as { start: string; end: string; days: number };
	}
	return null;
}

describe("parseFlexibleTime — relative spans", () => {
	test("5min", () => {
		const w = asWindow(parseFlexibleTime("5min", FIXED_NOW));
		expect(w).not.toBeNull();
		expect(w?.start).toBe("2026-11-11T11:55:00.000Z");
		expect(w?.end).toBe("2026-11-11T12:00:00.000Z");
	});

	test("2h", () => {
		const w = asWindow(parseFlexibleTime("2h", FIXED_NOW));
		expect(w).not.toBeNull();
		expect(w?.start).toBe("2026-11-11T10:00:00.000Z");
	});

	test("3d", () => {
		const w = asWindow(parseFlexibleTime("3d", FIXED_NOW));
		expect(w).not.toBeNull();
		expect(w?.start).toBe("2026-11-08T12:00:00.000Z");
	});

	test("90d max", () => {
		const w = asWindow(parseFlexibleTime("90d", FIXED_NOW));
		expect(w).not.toBeNull();
		expect(w?.start).toBe("2026-08-13T12:00:00.000Z");
	});

	test("rejects 0", () => {
		const r = parseFlexibleTime("0min", FIXED_NOW);
		expect(isOk(r)).toBe(true);
	});

	test("rejects >90d", () => {
		const r = parseFlexibleTime("91d", FIXED_NOW);
		expect(isOk(r)).toBe(true);
	});
});

describe("parseFlexibleTime — ranges", () => {
	test("date range", () => {
		const w = asWindow(parseFlexibleTime("2026-11-10 - 2026-11-11", FIXED_NOW));
		expect(w).not.toBeNull();
		expect(w?.start).toBe("2026-11-10T00:00:00.000Z");
		expect(w?.end).toBe("2026-11-11T00:00:00.000Z");
	});

	test("time range", () => {
		const w = asWindow(parseFlexibleTime("10:30 - 11:00", FIXED_NOW));
		expect(w).not.toBeNull();
		expect(w?.start).toBe("2026-11-11T10:30:00.000Z");
		expect(w?.end).toBe("2026-11-11T11:00:00.000Z");
	});

	test("cross-midnight 23:00 - 01:00", () => {
		const w = asWindow(parseFlexibleTime("23:00 - 01:00", FIXED_NOW));
		expect(w).not.toBeNull();
		expect(w?.start).toBe("2026-11-11T23:00:00.000Z");
		expect(w?.end).toBe("2026-11-12T01:00:00.000Z");
	});

	test("full range", () => {
		const w = asWindow(parseFlexibleTime("2026-11-10 17:12 - 2026-11-10 17:17", FIXED_NOW));
		expect(w).not.toBeNull();
		expect(w?.start).toBe("2026-11-10T17:12:00.000Z");
		expect(w?.end).toBe("2026-11-10T17:17:00.000Z");
	});

	test("rejects end before start", () => {
		const r = parseFlexibleTime("2026-11-11 - 2026-11-10", FIXED_NOW);
		expect(isOk(r)).toBe(true);
	});
});

describe("parseFlexibleTime — single point", () => {
	test("date", () => {
		const w = asWindow(parseFlexibleTime("2026-11-10", FIXED_NOW));
		expect(w).not.toBeNull();
		expect(w?.start).toBe("2026-11-10T00:00:00.000Z");
	});

	test("ISO with T", () => {
		const w = asWindow(parseFlexibleTime("2026-11-10T10:00:00Z", FIXED_NOW));
		expect(w).not.toBeNull();
		expect(w?.start).toBe("2026-11-10T10:00:00.000Z");
	});
});

describe("parseFlexibleTime — errors", () => {
	test("empty", () => {
		expect(isOk(parseFlexibleTime("", FIXED_NOW))).toBe(true);
	});

	test("garbage", () => {
		expect(isOk(parseFlexibleTime("foo bar", FIXED_NOW))).toBe(true);
	});
});

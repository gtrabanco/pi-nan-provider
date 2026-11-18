/**
 * ACCEPTANCE TESTS — issue #35 S11 (owner order 2026-11-18)
 * cf-ray of EVERY response: persistent sidecar + `turns.jsonl` join.
 *
 * Frozen-failure corpus for criteria C16/C17 of
 * docs/fix/issue-35-cf-ray-cache-evidence/SPEC.md — every test below
 * reproduced RED before the implementation landed. The anomaly pair capture
 * (S8–S10) is pinned unchanged by test/issue-35-cache-anomaly-capture.test.ts.
 *
 * https://github.com/gtrabanco/pi-nan-provider/issues/35
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	ProviderStreams,
} from "@earendil-works/pi-ai";

import {
	createCacheAnomalyFileSink,
	withCacheAnomalyCapture,
	type CacheAnomalyRecord,
	type CacheAnomalySink,
} from "../src/cache-anomaly.ts";
import {
	RESPONSE_RAYS_FILE,
	RESPONSE_RAYS_MAX_LINES,
	createResponseRayFileSink,
	readResponseRays,
	type ResponseRayRecord,
	type ResponseRaySink,
} from "../src/response-rays.ts";
import { buildDebugReport, renderDebugReport } from "../src/debug-report.ts";

const NOW = new Date("2026-11-11T10:00:00.000Z");

let scratchDirs: string[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "nan-rays-"));
	scratchDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
	scratchDirs = [];
});

function makeMessage(model = "qwen3.6", responseId = "chatcmpl-a"): AssistantMessage {
	return {
		role: "assistant",
		provider: "nan",
		api: "openai-completions",
		model,
		responseId,
		content: [{ type: "text", text: "answer" }],
		usage: {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: NOW.getTime(),
	} as AssistantMessage;
}

interface ScriptedResponse {
	id?: string;
	created?: number;
	cfRay?: string;
	model?: string;
	/** Reject `result()` after the hooks fired (stream failure mid-response). */
	fail?: boolean;
}

/** Replays one scripted response per stream call, firing the same hooks pi-ai fires. */
function scriptedApi(script: ScriptedResponse[]): ProviderStreams {
	let index = 0;
	const next = () => script[index++] ?? {};
	const run = (options: Record<string, unknown> | undefined) => {
		const entry = next();
		const model = entry.model ?? "qwen3.6";
		const onResponse = options?.onResponse as ((r: unknown, m: unknown) => unknown) | undefined;
		const onEvent = options?.onProviderStreamEvent as ((c: unknown, m: unknown) => unknown) | undefined;
		if (onResponse) {
			onResponse(
				{ status: 200, headers: entry.cfRay ? { "cf-ray": entry.cfRay } : {} },
				{ id: model },
			);
		}
		if (onEvent && entry.id) {
			onEvent({ id: entry.id, created: entry.created ?? 1, choices: [{ delta: {} }] }, { id: model });
		}
		const message = makeMessage(model, entry.id ?? "");
		const stream = {
			[Symbol.asyncIterator]: async function* () {
				yield { type: "done" as const, reason: message.stopReason, message };
			},
			result: () =>
				entry.fail
					? Promise.reject(new Error("stream failed after headers"))
					: Promise.resolve(message),
		} as unknown as AssistantMessageEventStream;
		return stream;
	};
	return {
		stream: (_model, _context, options) => run(options as Record<string, unknown> | undefined),
		streamSimple: (_model, _context, options) => run(options as Record<string, unknown> | undefined),
	} as ProviderStreams;
}

function memorySinks(): {
	records: ResponseRayRecord[];
	raySink: ResponseRaySink;
	anomalies: CacheAnomalyRecord[];
	anomalySink: CacheAnomalySink;
} {
	const records: ResponseRayRecord[] = [];
	const anomalies: CacheAnomalyRecord[] = [];
	return {
		records,
		raySink: { record: (record) => records.push(record) },
		anomalies,
		anomalySink: { record: (record) => anomalies.push(record) },
	};
}

async function runStreams(api: ProviderStreams, count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		const stream = api.stream({ id: "qwen3.6" } as never, { messages: [] } as never, {});
		await stream.result().catch(() => undefined);
	}
}

// ── C16: capture ──────────────────────────────────────────────────────────

describe("issue #35 S11 — frozen failures: response-ray capture (C16)", () => {
	test("every completed response persists its ray without becoming an anomaly record", async () => {
		const { records, raySink, anomalies, anomalySink } = memorySinks();
		const api = withCacheAnomalyCapture(
			scriptedApi([
				{ id: "chatcmpl-1", created: 1, cfRay: "ray-1" },
				{ id: "chatcmpl-2", created: 2, cfRay: "ray-2" },
			]),
			{ sink: anomalySink, raySink, now: () => NOW },
		);
		await runStreams(api, 2);

		expect(records).toEqual([
			{ response_id: "chatcmpl-1", cf_ray: "ray-1", model: "qwen3.6", observed_at: NOW.toISOString() },
			{ response_id: "chatcmpl-2", cf_ray: "ray-2", model: "qwen3.6", observed_at: NOW.toISOString() },
		]);
		// Distinct ids are ordinary traffic: the anomaly file must stay untouched.
		expect(anomalies).toHaveLength(0);
	});

	test("records carry exactly the four declared fields (redaction shape)", async () => {
		const { records, raySink, anomalySink } = memorySinks();
		const api = withCacheAnomalyCapture(scriptedApi([{ id: "chatcmpl-1", created: 1, cfRay: "ray-1" }]), {
			sink: anomalySink,
			raySink,
			now: () => NOW,
		});
		await runStreams(api, 1);

		expect(records).toHaveLength(1);
		expect(Object.keys(records[0]!).sort()).toEqual(["cf_ray", "model", "observed_at", "response_id"]);
	});

	test("a stream that fails after its id still persists the ray, and nothing throws", async () => {
		const { records, raySink, anomalies, anomalySink } = memorySinks();
		const api = withCacheAnomalyCapture(
			scriptedApi([{ id: "chatcmpl-err", created: 9, cfRay: "ray-err", fail: true }]),
			{ sink: anomalySink, raySink, now: () => NOW },
		);
		await expect(runStreams(api, 1)).resolves.toBeUndefined();

		expect(records).toEqual([
			{ response_id: "chatcmpl-err", cf_ray: "ray-err", model: "qwen3.6", observed_at: NOW.toISOString() },
		]);
		expect(anomalies).toHaveLength(0);
	});

	test("no cf-ray header or no id means no record (nothing useless is persisted)", async () => {
		const { records, raySink, anomalySink } = memorySinks();
		const api = withCacheAnomalyCapture(
			scriptedApi([
				{ id: "chatcmpl-noheader", created: 1 },
				{ created: 2, cfRay: "ray-without-id" },
			]),
			{ sink: anomalySink, raySink, now: () => NOW },
		);
		await runStreams(api, 2);
		expect(records).toHaveLength(0);
	});

	test("the file sink appends JSONL and keeps only the newest maxLines", () => {
		expect(RESPONSE_RAYS_MAX_LINES).toBe(50_000);
		const path = join(scratch(), RESPONSE_RAYS_FILE);
		const sink = createResponseRayFileSink(path, { maxLines: 3 });
		for (let i = 1; i <= 5; i++) {
			sink.record({ response_id: `r${i}`, cf_ray: `ray-${i}`, model: "qwen3.6", observed_at: NOW.toISOString() });
		}
		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(3);
		expect(lines.map((line) => (JSON.parse(line) as ResponseRayRecord).response_id)).toEqual(["r3", "r4", "r5"]);
	});

	test("an unwritable sink path never throws (streams continue)", () => {
		const blocker = scratch();
		const notADir = join(blocker, "regular-file");
		writeFileSync(notADir, "x");
		const sink = createResponseRayFileSink(join(notADir, "nested", RESPONSE_RAYS_FILE));
		expect(() =>
			sink.record({ response_id: "r1", cf_ray: "ray-1", model: "qwen3.6", observed_at: NOW.toISOString() }),
		).not.toThrow();
	});
});

// ── C17: report join ──────────────────────────────────────────────────────

function writeTurnSession(agentDir: string, responseIds: Array<string | null>): void {
	const dir = join(agentDir, "sessions", "--home-agent-project--");
	mkdirSync(dir, { recursive: true });
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: "s", cwd: "/home/agent/project", timestamp: "2026-11-10T09:00:00.000Z" }),
	];
	responseIds.forEach((responseId, index) => {
		const timestamp = `2026-11-10T10:0${index}:00.000Z`;
		const message: Record<string, unknown> = {
			role: "assistant",
			provider: "nan",
			api: "openai-completions",
			model: "qwen3.6",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 2 },
			stopReason: "stop",
			timestamp: Date.parse(timestamp),
			content: [{ type: "text", text: "answer" }],
		};
		if (responseId !== null) message.responseId = responseId;
		lines.push(JSON.stringify({ type: "message", timestamp, message }));
	});
	writeFileSync(join(dir, "2026-11-10T10-00-00-000Z_s.jsonl"), `${lines.join("\n")}\n`);
}

describe("issue #35 S11 — frozen failures: report join (C17)", () => {
	test("turn rows and rendered turns.jsonl carry cf_ray from the sidecar", async () => {
		const agentDir = scratch();
		writeTurnSession(agentDir, ["chatcmpl-1", null]);
		writeFileSync(
			join(agentDir, RESPONSE_RAYS_FILE),
			[
				JSON.stringify({ response_id: "chatcmpl-1", cf_ray: "ray-abc", model: "qwen3.6", observed_at: NOW.toISOString() }),
				"not-json-line",
				JSON.stringify({ response_id: "chatcmpl-1", cf_ray: "ray-newer", model: "qwen3.6", observed_at: NOW.toISOString() }),
				"",
			].join("\n"),
		);

		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 7 });
		expect(report.turns).toHaveLength(2);
		const withRay = report.turns.find((turn) => turn.response_id === "chatcmpl-1")!;
		const withoutId = report.turns.find((turn) => turn.response_id === null)!;
		// Last sidecar line for the id wins; the corrupted line is skipped.
		expect(withRay.cf_ray).toBe("ray-newer");
		expect(withoutId.cf_ray).toBeNull();

		const rendered = renderDebugReport(report);
		expect(rendered.files["turns.jsonl"]).toContain('"cf_ray":"ray-newer"');
		expect(rendered.files["turns.jsonl"]).toContain('"cf_ray":null');
	});

	test("a missing sidecar leaves every row null and the report otherwise intact", async () => {
		const agentDir = scratch();
		writeTurnSession(agentDir, ["chatcmpl-1"]);
		const report = await buildDebugReport({ agentDir, now: NOW, windowDays: 7 });
		expect(report.turns).toHaveLength(1);
		expect(report.turns[0]!.cf_ray).toBeNull();
		const rendered = renderDebugReport(report);
		expect(rendered.files["turns.jsonl"]).toContain('"cf_ray":null');
		expect(Object.keys(rendered.files)).toContain("anomalies.jsonl");
	});

	test("the reader maps by response id and tolerates a missing file", () => {
		expect(readResponseRays(join(scratch(), "absent.jsonl")).size).toBe(0);
		const path = join(scratch(), RESPONSE_RAYS_FILE);
		writeFileSync(path, "");
		expect(readResponseRays(path).size).toBe(0);
	});
});

import { describe, expect, test } from "bun:test";
import {
	assessUpdate,
	buildReport,
	compareVersions,
	extractServerTools,
	fetchChangelog,
	fetchLatestVersion,
	fetchServerTools,
	parseVersion,
	renderIssueBody,
	type FetchLike,
	type NanMcpServerCheckReport,
} from "../scripts/check-nan-mcp-server.ts";
import {
	DEFAULT_NAN_MEDIA_MCP_VERSION,
	NAN_MEDIA_MCP_SERVER_TOOLS,
	NAN_MEDIA_TOOLS,
} from "../src/mcp/nan-media.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function textResponse(text: string, status = 200): Response {
	return new Response(text, { status, headers: { "Content-Type": "text/plain" } });
}

describe("parseVersion / compareVersions", () => {
	test("parses x.y.z and normalizes a leading v", () => {
		expect(parseVersion("1.0.8")).toEqual([1, 0, 8]);
		expect(parseVersion("v1.0.7")).toEqual([1, 0, 7]);
	});

	test("clamps non-numeric and junk segments to 0 without throwing", () => {
		expect(parseVersion("1.0.8-rc.1")).toEqual([1, 0, 8]);
		expect(parseVersion("nonsense")).toEqual([0, 0, 0]);
		expect(parseVersion("")).toEqual([0, 0, 0]);
	});

	test("compares semver numerically (1 > 0, patch first, then minor, then major)", () => {
		expect(compareVersions("1.0.8", "1.0.7")).toBe(1);
		expect(compareVersions("1.0.7", "1.0.8")).toBe(-1);
		expect(compareVersions("1.0.8", "1.0.8")).toBe(0);
		expect(compareVersions("1.1.0", "1.0.9")).toBe(1);
		expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
	});
});

describe("extractServerTools", () => {
	test("extracts every registerTool name, sorted and deduped", () => {
		const src = `registerTool("edit_image", {})\nregisterTool("list_voices",{})\nregisterTool("edit_image", { toy: 1 })\nregisterTool("speech_to_text", {})`;
		expect(extractServerTools(src)).toEqual(["edit_image", "list_voices", "speech_to_text"]);
	});

	test("tolerates single quotes and whitespace", () => {
		const src = `registerTool('generate_image', {})\nregisterTool('text_to_speech',{})`;
		expect(extractServerTools(src)).toEqual(["generate_image", "text_to_speech"]);
	});
});

describe("NAN_MEDIA_MCP_SERVER_TOOLS contract", () => {
	test("is exactly the audio/image/transcription scope, one per bridged pi tool", () => {
		expect(NAN_MEDIA_MCP_SERVER_TOOLS).toEqual([
			"generate_image",
			"edit_image",
			"text_to_speech",
			"list_voices",
			"speech_to_text",
		]);
		expect(NAN_MEDIA_MCP_SERVER_TOOLS.length).toBe(NAN_MEDIA_TOOLS.length);
	});
});

describe("assessUpdate", () => {
	test("safe (non-breaking) when every bridged tool is still present", () => {
		const verdict = assessUpdate([...NAN_MEDIA_MCP_SERVER_TOOLS]);
		expect(verdict.breaking).toBe(false);
		expect(verdict.removedTools).toEqual([]);
		expect(verdict.reason).toContain("non-breaking");
	});

	test("breaking when a bridged tool is dropped", () => {
		const latest = [...NAN_MEDIA_MCP_SERVER_TOOLS].filter((t) => t !== "speech_to_text");
		const verdict = assessUpdate(latest);
		expect(verdict.breaking).toBe(true);
		expect(verdict.removedTools).toEqual(["speech_to_text"]);
		expect(verdict.reason).toContain("BREAKING");
	});

	test("informational when the latest adds new tools we do not bridge", () => {
		const latest = [...NAN_MEDIA_MCP_SERVER_TOOLS, "embed", "rerank"];
		const verdict = assessUpdate(latest);
		expect(verdict.breaking).toBe(false);
		expect(verdict.addedTools).toEqual(["embed", "rerank"]);
		expect(verdict.reason).toContain("NOT bridged");
	});
});

describe("buildReport", () => {
	const pinned = DEFAULT_NAN_MEDIA_MCP_VERSION;

	test("up-to-date when pinned is not older than latest", () => {
		const report = buildReport({ pinnedVersion: pinned, latestVersion: pinned, latestTools: [], changelog: [] });
		expect(report.status).toBe("up-to-date");
		expect(report.updateAvailable).toBe(false);
	});

	test("update-available when latest is strictly newer", () => {
		const report = buildReport({ pinnedVersion: "1.0.7", latestVersion: "1.0.8", latestTools: [...NAN_MEDIA_MCP_SERVER_TOOLS], changelog: ["chore: bump to 1.0.8"] });
		expect(report.status).toBe("update-available");
		expect(report.updateAvailable).toBe(true);
		expect(report.breaking).toBe(false);
		expect(report.changelog).toContain("chore: bump to 1.0.8");
	});

	test("check-failed and safe verdict when the registry could not be read", () => {
		const report = buildReport({ pinnedVersion: pinned, latestVersion: null, latestTools: [], changelog: [] });
		expect(report.status).toBe("check-failed");
		expect(report.updateAvailable).toBe(false);
		expect(report.error).toBe("registry-unreachable");
	});

	test("check-failed propagates an explicit error and never claims an update", () => {
		const report = buildReport({ pinnedVersion: pinned, latestVersion: null, latestTools: [], changelog: [], error: "network down" });
		expect(report.status).toBe("check-failed");
		expect(report.error).toBe("network down");
		expect(report.updateAvailable).toBe(false);
	});
});

describe("renderIssueBody", () => {
	test("mentions the version pair and a manual-review flag for a breaking update", () => {
		const report: NanMcpServerCheckReport = {
			package: "nan-mcp-server",
			pinnedVersion: "1.0.7",
			latestVersion: "1.0.8",
			updateAvailable: true,
			status: "update-available",
			breaking: true,
			addedTools: [],
			removedTools: ["speech_to_text"],
			changelog: ["fix: drop speech_to_text"],
			reason: "BREAKING: the latest nan-mcp-server no longer exposes speech_to_text.",
		};
		const body = renderIssueBody(report);
		expect(body).toContain("1.0.7");
		expect(body).toContain("1.0.8");
		expect(body).toContain("BREAKING");
		expect(body).toContain("speech_to_text");
	});
});

describe("network fetchers (injected fetch)", () => {
	test("fetchLatestVersion reads dist-tags.latest", async () => {
		const stub: FetchLike = async () => jsonResponse({ "dist-tags": { latest: "1.0.8" } });
		expect(await fetchLatestVersion(stub)).toBe("1.0.8");
	});

	test("fetchLatestVersion throws when the registry has no version", async () => {
		const stub: FetchLike = async () => jsonResponse({});
		await expect(fetchLatestVersion(stub)).rejects.toThrow();
	});

	test("fetchServerTools extracts the tool surface from the published source", async () => {
		const source = `registerTool("generate_image", {})`;
		const stub: FetchLike = async () => textResponse(source);
		expect(await fetchServerTools("1.0.8", stub)).toEqual(["generate_image"]);
	});

	test("fetchServerTools surfaces a non-OK HTTP response as an error", async () => {
		const stub: FetchLike = async () => textResponse("", 404);
		await expect(fetchServerTools("1.0.8", stub)).rejects.toThrow(/404/);
	});

	test("fetchChangelog collapses commit messages to their first line", async () => {
		const stub: FetchLike = async () =>
			jsonResponse({ commits: [{ commit: { message: "chore: bump to 1.0.8\n\nbody" } }, { commit: { message: "fix: reject >4 images" } }] });
		expect(await fetchChangelog("1.0.7", "1.0.8", stub)).toEqual(["chore: bump to 1.0.8", "fix: reject >4 images"]);
	});

	test("fetchChangelog degrades to an empty list when the compare endpoint fails", async () => {
		const stub: FetchLike = async () => textResponse("", 403);
		expect(await fetchChangelog("1.0.7", "1.0.8", stub)).toEqual([]);
	});
});

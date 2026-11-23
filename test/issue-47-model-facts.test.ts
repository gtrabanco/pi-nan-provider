/**
 * Issue #47 — the exported, typed, provenance-carrying model-facts catalog.
 *
 * These tests are the acceptance corpus for the public export: they assert the
 * shipped surface (export path, key set, immutability), that the carried cells
 * are the generated catalog's own values, the documented matrix for the eight
 * new facts (each traced to `https://nan.builders/docs/models`,
 * `https://nan.builders/model-guide`, or a dated measurement already recorded
 * in the repo), and that no cell can be added without a provenance id.
 */

import { describe, expect, test } from "bun:test";
import { NAN_GENERATED_MODELS } from "../scripts/models.generated.ts";
import { MANUAL_OVERRIDES } from "../scripts/manual-overrides.ts";
import { MODEL_FACTS } from "../scripts/model-facts.ts";
import {
	NAN_ENDPOINT_FACTS,
	NAN_FACT_SOURCES,
	NAN_MODEL_FACTS,
	NAN_MODEL_FACTS_META,
} from "../src/model-facts.ts";
import {
	buildModelFacts,
	FACT_CELLS,
	overrideFieldKeys,
	type NanModelFacts,
} from "../src/model-facts-core.ts";
import { NON_CHAT_MODEL_IDS } from "../src/fetch-models.ts";
import * as packageEntry from "../src/index.ts";

/** The exact key set of one entry. Anything added here is new public surface. */
const ENTRY_KEYS = [
	"billingClass",
	"cacheMode",
	"coldCeilingTokens",
	"compat",
	"contextWindow",
	"cost",
	"id",
	"input",
	"maxTokens",
	"maxTokensSemantics",
	"name",
	"notes",
	"parallelToolCalls",
	"provenance",
	"reasoning",
	"reasoningEffortValues",
	"structuredOutput",
	"thinkingBudget",
	"thinkingLevelMap",
	"toolCalling",
].sort();

/** Model ids the catalog ships, and only those, are facts. */
const CATALOG_IDS = NAN_GENERATED_MODELS.map((entry) => entry.id).sort();

interface ExpectedFacts {
	toolCalling: NanModelFacts["toolCalling"];
	maxTokensSemantics: NanModelFacts["maxTokensSemantics"];
	thinkingBudget: NanModelFacts["thinkingBudget"];
	cacheMode: NanModelFacts["cacheMode"];
	billingClass: NanModelFacts["billingClass"];
	structuredOutput: NanModelFacts["structuredOutput"];
}

/**
 * The documented matrix. Provenance lives in the module source table; each row
 * here is the value a consumer reads.
 *
 * - toolCalling: docs capabilities wording — "Tool calling (XML format)" on
 *   qwen3.8-flash, qwen3.6 and gemma4, "Tool calling (function calling)" on the
 *   other ten (`https://nan.builders/docs/models`, checked 2026-11-23).
 * - maxTokensSemantics: docs say the output budget "is used exactly as you send
 *   it on every model … Reasoning tokens are spent from that same budget";
 *   qwen3.8-max is the documented "max_tokens only bounds the visible answer"
 *   model. qwen3.8-flash is rows-bounded too, measured 2026-11-18 (issue #36:
 *   max_tokens=64 → completion_tokens=64), which beats the stale docs sentence.
 * - thinkingBudget: honoured (hard 1–32768 cap) on qwen3.6/gemma4/qwen3.8-flash,
 *   explicitly not honoured on qwen3.8-max, outside the contract elsewhere.
 * - cacheMode: a per-model cache rate is published in the NaN model guide for
 *   every model except qwen3.6 and gemma4, and no opt-in parameter exists.
 * - billingClass: the docs' "credits · larger model" row.
 * - structuredOutput: documented json_object/json_schema per model; silence is
 *   `unmeasured`.
 */
const EXPECTED: Readonly<Record<string, ExpectedFacts>> = {
	"deepseek-v4-flash": {
		toolCalling: "openai-tools",
		maxTokensSemantics: "bounds-total",
		thinkingBudget: "unmeasured",
		cacheMode: "automatic",
		billingClass: "credit-standard",
		structuredOutput: true,
	},
	"deepseek-v4-pro": {
		toolCalling: "openai-tools",
		maxTokensSemantics: "bounds-total",
		thinkingBudget: "unmeasured",
		cacheMode: "automatic",
		billingClass: "credit-larger",
		structuredOutput: "unmeasured",
	},
	gemma4: {
		toolCalling: "xml",
		maxTokensSemantics: "bounds-total",
		thinkingBudget: "honoured",
		cacheMode: "unmeasured",
		billingClass: "credit-standard",
		structuredOutput: true,
	},
	"glm5.3": {
		toolCalling: "openai-tools",
		maxTokensSemantics: "bounds-total",
		thinkingBudget: "unmeasured",
		cacheMode: "automatic",
		billingClass: "credit-larger",
		structuredOutput: true,
	},
	"glm5.3-flash": {
		toolCalling: "openai-tools",
		maxTokensSemantics: "bounds-total",
		thinkingBudget: "unmeasured",
		cacheMode: "automatic",
		billingClass: "credit-standard",
		structuredOutput: true,
	},
	hy4: {
		toolCalling: "openai-tools",
		maxTokensSemantics: "bounds-total",
		thinkingBudget: "unmeasured",
		cacheMode: "automatic",
		billingClass: "credit-larger",
		structuredOutput: "unmeasured",
	},
	"hy4-flash": {
		toolCalling: "openai-tools",
		maxTokensSemantics: "bounds-total",
		thinkingBudget: "unmeasured",
		cacheMode: "automatic",
		billingClass: "credit-standard",
		structuredOutput: true,
	},
	"kimi-k3.1-pro": {
		toolCalling: "openai-tools",
		maxTokensSemantics: "bounds-total",
		thinkingBudget: "unmeasured",
		cacheMode: "automatic",
		billingClass: "credit-larger",
		structuredOutput: "unmeasured",
	},
	"mimo-v2.6-flash": {
		toolCalling: "openai-tools",
		maxTokensSemantics: "bounds-total",
		thinkingBudget: "unmeasured",
		cacheMode: "automatic",
		billingClass: "credit-standard",
		structuredOutput: "unmeasured",
	},
	"qwen3.6": {
		toolCalling: "xml",
		maxTokensSemantics: "bounds-total",
		thinkingBudget: "honoured",
		cacheMode: "unmeasured",
		billingClass: "credit-standard",
		structuredOutput: true,
	},
	"qwen3.8-flash": {
		toolCalling: "xml",
		maxTokensSemantics: "bounds-total",
		thinkingBudget: "honoured",
		cacheMode: "automatic",
		billingClass: "credit-standard",
		structuredOutput: "unmeasured",
	},
	"qwen3.8-max": {
		toolCalling: "openai-tools",
		maxTokensSemantics: "bounds-visible-answer",
		thinkingBudget: "ignored",
		cacheMode: "automatic",
		billingClass: "credit-larger",
		structuredOutput: "unmeasured",
	},
	"qwen4-max": {
		toolCalling: "openai-tools",
		maxTokensSemantics: "bounds-total",
		thinkingBudget: "unmeasured",
		cacheMode: "automatic",
		billingClass: "credit-larger",
		structuredOutput: true,
	},
};

const factsById = NAN_MODEL_FACTS as Readonly<Record<string, NanModelFacts>>;
const catalogById = new Map(NAN_GENERATED_MODELS.map((entry) => [entry.id, entry]));

/** Run a mutation attempt, tolerating both strict-mode throws and silent no-ops. */
function attempt(mutation: () => void): void {
	try {
		mutation();
	} catch {
		// Strict mode throws TypeError on a frozen target; that is the expected path.
	}
}

describe("public export (S19, S20)", () => {
	test("the package entry point exposes the catalog, its meta and the endpoint facts", () => {
		const entry = packageEntry as unknown as Record<string, unknown>;
		expect(entry.NAN_MODEL_FACTS).toBe(NAN_MODEL_FACTS);
		expect(entry.NAN_MODEL_FACTS_META).toBe(NAN_MODEL_FACTS_META);
		expect(entry.NAN_ENDPOINT_FACTS).toBe(NAN_ENDPOINT_FACTS);
	});

	test("one entry per billed chat model, keyed by id, no non-chat id", () => {
		expect(Object.keys(NAN_MODEL_FACTS).sort()).toEqual(CATALOG_IDS);
		expect(CATALOG_IDS).toHaveLength(13);
		for (const id of CATALOG_IDS) {
			expect(NON_CHAT_MODEL_IDS[id], `${id} must stay out of the chat facts`).toBeUndefined();
			expect(factsById[id]!.id).toBe(id);
		}
		for (const id of Object.keys(NON_CHAT_MODEL_IDS)) {
			expect(factsById[id], `${id} is a non-chat endpoint`).toBeUndefined();
		}
	});

	test("the entry key set is pinned: facts only, no policy and no pi Model plumbing", () => {
		for (const id of CATALOG_IDS) {
			expect(Object.keys(factsById[id]!).sort(), `${id} key set`).toEqual(ENTRY_KEYS);
			for (const forbidden of ["api", "baseUrl", "provider", "type", "rateLimit", "concurrency", "price"]) {
				expect(Object.hasOwn(factsById[id]!, forbidden), `${id} must not carry ${forbidden}`).toBe(false);
			}
		}
	});

	test("the catalog is serializable exactly as read (no undefined cells)", () => {
		for (const id of CATALOG_IDS) {
			expect(JSON.parse(JSON.stringify(factsById[id]!))).toEqual(factsById[id]);
		}
	});
});

describe("carried cells mirror the generated catalog (S7, S8, S9)", () => {
	for (const id of CATALOG_IDS) {
		test(`${id} carries the catalog's own capability values`, () => {
			const entry = catalogById.get(id)!;
			const facts = factsById[id]!;
			expect(facts.contextWindow).toBe(entry.contextWindow);
			expect(facts.maxTokens).toBe(entry.maxTokens);
			expect(facts.cost).toEqual(entry.cost);
			expect(facts.input).toEqual(entry.input);
			expect(facts.reasoning).toBe(entry.reasoning);
			expect(facts.reasoningEffortValues).toEqual(entry.reasoningEffortValues ?? []);
			expect(facts.thinkingLevelMap).toEqual(entry.thinkingLevelMap ?? {});
			expect(facts.compat).toEqual(entry.compat!);
			expect(facts.name).toBe(entry.name);
		});
	}
});

describe("documented capability matrix (S10-S17, S21)", () => {
	for (const [id, expected] of Object.entries(EXPECTED)) {
		test(`${id} matches the documented facts`, () => {
			const facts = factsById[id]!;
			expect(facts.toolCalling, `${id} toolCalling`).toBe(expected.toolCalling);
			expect(facts.maxTokensSemantics, `${id} maxTokensSemantics`).toBe(expected.maxTokensSemantics);
			expect(facts.thinkingBudget, `${id} thinkingBudget`).toBe(expected.thinkingBudget);
			expect(facts.cacheMode, `${id} cacheMode`).toBe(expected.cacheMode);
			expect(facts.billingClass, `${id} billingClass`).toBe(expected.billingClass);
			expect(facts.structuredOutput, `${id} structuredOutput`).toBe(expected.structuredOutput);
		});
	}

	test("every model ships a documented tool protocol (no unmeasured cell)", () => {
		for (const id of CATALOG_IDS) {
			expect(["openai-tools", "xml"]).toContain(factsById[id]!.toolCalling);
		}
	});

	test("parallelToolCalls stays unmeasured everywhere: nothing was measured", () => {
		for (const id of CATALOG_IDS) {
			expect(factsById[id]!.parallelToolCalls, `${id} parallelToolCalls`).toBe("unmeasured");
		}
	});

	test("billingClass covers exactly the six larger models the docs label", () => {
		const larger = CATALOG_IDS.filter((id) => factsById[id]!.billingClass === "credit-larger");
		expect(larger).toEqual(
			["deepseek-v4-pro", "glm5.3", "hy4", "kimi-k3.1-pro", "qwen3.8-max", "qwen4-max"].sort(),
		);
		expect(CATALOG_IDS.filter((id) => factsById[id]!.billingClass === "quota-only")).toEqual([]);
	});
});

describe("cold-prompt ceiling (S13, S22, owner option A)", () => {
	test("no model claims a per-model cold ceiling", () => {
		for (const id of CATALOG_IDS) {
			expect(factsById[id]!.coldCeilingTokens, `${id} coldCeilingTokens`).toBe("unmeasured");
		}
	});

	test("the measured endpoint-wide ceiling ships separately with its date and scope", () => {
		expect(NAN_ENDPOINT_FACTS.coldCacheCeilingTokens).toBe(200_000);
		expect(NAN_ENDPOINT_FACTS.coldCeilingMeasuredAt).toBe("2026-10-01");
		expect(NAN_ENDPOINT_FACTS.coldCeilingScope).toMatch(/not a model capability/i);
		expect(NAN_ENDPOINT_FACTS.coldCeilingSources).toContain("200,000");
		expect(Object.isFrozen(NAN_ENDPOINT_FACTS)).toBe(true);
	});
});

describe("provenance per cell (S5)", () => {
	test("every cell carries a source id from the closed set, and only cells do", () => {
		for (const id of CATALOG_IDS) {
			const provenance = factsById[id]!.provenance;
			expect(Object.keys(provenance).sort(), `${id} provenance keys`).toEqual([...FACT_CELLS].sort());
			for (const cell of FACT_CELLS) {
				expect(Object.hasOwn(NAN_FACT_SOURCES, provenance[cell]), `${id}.${cell} source id`).toBe(true);
			}
		}
	});

	test("every source id resolves to a citation a consumer can check", () => {
		// Direct sources name their URL or a dated measurement; the three
		// note-pointing ids (override, compat, catalog-cost) resolve through the
		// entry's own notes, which is where the generated catalog keeps those
		// provenance strings; "none" must say it is no source at all.
		const notePointers = new Set(["override", "compat", "catalog-cost"]);
		for (const [id, citation] of Object.entries(NAN_FACT_SOURCES)) {
			if (notePointers.has(id)) {
				expect(citation, `${id} citation points into the entry notes`).toContain("notes");
			} else if (id === "none") {
				expect(citation, "none citation").toMatch(/^no source:/);
			} else {
				expect(citation, `${id} citation`).toMatch(/https?:\/\/|\d{4}-\d{2}-\d{2}/);
			}
		}
	});

	test("an unmeasured new-fact cell is sourced as \"none\", never as a document", () => {
		for (const id of CATALOG_IDS) {
			const facts = factsById[id]!;
			for (const cell of FACT_CELLS) {
				const value = facts[cell];
				if (value !== "unmeasured" || cell === "coldCeilingTokens") continue;
				expect(facts.provenance[cell], `${id}.${cell}`).toBe("none");
			}
		}
	});

	test("the documented matrix cites the docs and the measurement, not a guess", () => {
		expect(factsById["qwen3.8-flash"]!.provenance.toolCalling).toBe("docs");
		expect(factsById["qwen3.8-flash"]!.provenance.maxTokensSemantics).toBe("measured-36");
		expect(factsById["qwen3.8-max"]!.provenance.maxTokensSemantics).toBe("docs-reasoning");
		expect(factsById["qwen3.8-max"]!.provenance.thinkingBudget).toBe("docs-reasoning");
		expect(factsById["mimo-v2.6-flash"]!.provenance.cacheMode).toBe("model-guide");
		expect(factsById["gemma4"]!.provenance.cacheMode).toBe("none");
		expect(factsById["qwen4-max"]!.provenance.structuredOutput).toBe("docs");
		expect(factsById["glm5.3"]!.provenance.structuredOutput).toBe("docs-cross-model");
		expect(factsById["qwen3.6"]!.provenance.structuredOutput).toBe("docs-cross-model");
		for (const id of CATALOG_IDS) {
			expect(factsById[id]!.provenance.coldCeilingTokens, `${id} cold ceiling source`).toBe("none");
		}
	});

	test("carried cells point at their real origin (override, models.dev or a shared constant)", () => {
		// glm5.3 pins its context window and modalities in MANUAL_OVERRIDES.
		expect(factsById["glm5.3"]!.provenance.contextWindow).toBe("override");
		expect(factsById["glm5.3"]!.provenance.input).toBe("override");
		// gemma4 takes its window straight from models.dev.
		expect(factsById["gemma4"]!.provenance.contextWindow).toBe("models.dev");
		// compat is the shared NAN_COMPAT constant unless the model overrides the field.
		expect(factsById["gemma4"]!.provenance.compat).toBe("compat");
		expect(factsById["qwen3.8-max"]!.provenance.compat).toBe("override");
		// cost is the pinned-zero shared decision unless the model overrides it.
		expect(factsById["gemma4"]!.provenance.cost).toBe("catalog-cost");
	});

	test("the meta exposes the citation table a consumer needs to resolve a cell", () => {
		expect(NAN_MODEL_FACTS_META.sources).toBe(NAN_FACT_SOURCES);
		expect(NAN_MODEL_FACTS_META.modelsDevProvider).toBe("nan");
		expect(NAN_MODEL_FACTS_META.modelCount).toBe(CATALOG_IDS.length);
		expect(NAN_MODEL_FACTS_META.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});
});

describe("one frozen record (S20)", () => {
	test("the record, every entry and every nested cell are frozen", () => {
		expect(Object.isFrozen(NAN_MODEL_FACTS)).toBe(true);
		expect(Object.isFrozen(NAN_MODEL_FACTS_META)).toBe(true);
		for (const id of CATALOG_IDS) {
			const facts = factsById[id]!;
			expect(Object.isFrozen(facts), `${id} entry`).toBe(true);
			for (const nested of [
				facts.cost,
				facts.compat,
				facts.input,
				facts.reasoningEffortValues,
				facts.thinkingLevelMap,
				facts.provenance,
				facts.notes,
			]) {
				expect(Object.isFrozen(nested), `${id} nested cell`).toBe(true);
			}
		}
	});

	test("a consumer mutation cannot change what the next consumer reads", () => {
		const target = factsById["qwen3.8-flash"]!;
		const before = JSON.stringify(target);
		attempt(() => {
			(target as { maxTokens: number }).maxTokens = 1;
		});
		attempt(() => {
			(target.cost as { input: number }).input = 999;
		});
		attempt(() => {
			(target.provenance as Record<string, string>).toolCalling = "openai-tools";
		});
		attempt(() => {
			(NAN_MODEL_FACTS as Record<string, unknown>).ghost = {};
		});
		expect(JSON.stringify(factsById["qwen3.8-flash"])).toBe(before);
		expect(Object.hasOwn(NAN_MODEL_FACTS, "ghost")).toBe(false);
	});
});

describe("build-time guards: no cell without provenance (S5)", () => {
	const fixtureEntry = {
		id: "fixture-model",
		name: "Fixture Model",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000,
		maxTokens: 100,
		reasoningEffortValues: ["none"],
		thinkingLevelMap: { off: "none" },
		compat: { supportsDeveloperRole: false },
		notes: ["fixture note"],
	} as const;
	const validDeclaration = {
		toolCalling: "xml",
		maxTokensSemantics: "bounds-total",
		thinkingBudget: "honoured",
		coldCeilingTokens: "unmeasured",
		cacheMode: "automatic",
		billingClass: "credit-standard",
		parallelToolCalls: "unmeasured",
		structuredOutput: "unmeasured",
		sources: {
			toolCalling: "docs",
			maxTokensSemantics: "docs",
			thinkingBudget: "docs-reasoning",
			coldCeilingTokens: "none",
			cacheMode: "model-guide",
			billingClass: "docs",
			parallelToolCalls: "none",
			structuredOutput: "none",
		},
	} as const;
	const meta = {
		source: NAN_MODEL_FACTS_META.source,
		modelsDevProvider: "nan",
		fetchedAt: NAN_MODEL_FACTS_META.fetchedAt,
		modelCount: 1,
	};

	test("a fully declared model builds and derives its carried sources", () => {
		const built = buildModelFacts(
			[fixtureEntry as never],
			{ "fixture-model": validDeclaration as never },
			{},
			meta,
		);
		expect(Object.keys(built)).toEqual(["fixture-model"]);
		expect(built["fixture-model"]!.contextWindow).toBe(1_000);
		expect(built["fixture-model"]!.notes).toEqual(["fixture note"]);
	});

	test("a catalog id without a declaration fails the build", () => {
		expect(() => buildModelFacts([fixtureEntry as never], {}, {}, meta)).toThrow(/fixture-model/);
	});

	test("a declaration without a catalog id fails the build", () => {
		expect(() =>
			buildModelFacts(
				[fixtureEntry as never],
				{
					"fixture-model": validDeclaration as never,
					ghost: validDeclaration as never,
				},
				{},
				meta,
			),
		).toThrow(/ghost/);
	});

	test("a value outside its documented union fails the build", () => {
		expect(() =>
			buildModelFacts(
				[fixtureEntry as never],
				{ "fixture-model": { ...validDeclaration, toolCalling: "grpc" } as never },
				{},
				meta,
			),
		).toThrow(/toolCalling/);
	});

	test("a declared fact without a source fails the build", () => {
		const sources = { ...validDeclaration.sources } as Record<string, string>;
		delete sources.thinkingBudget;
		expect(() =>
			buildModelFacts(
				[fixtureEntry as never],
				{ "fixture-model": { ...validDeclaration, sources } as never },
				{},
				meta,
			),
		).toThrow(/thinkingBudget/);
	});

	test("a source id outside the closed set fails the build", () => {
		expect(() =>
			buildModelFacts(
				[fixtureEntry as never],
				{
					"fixture-model": {
						...validDeclaration,
						sources: { ...validDeclaration.sources, cacheMode: "vibes" },
					} as never,
				},
				{},
				meta,
			),
		).toThrow(/cacheMode/);
	});
});

describe("the manual facts layer and the shipped catalog agree (S6)", () => {
	test("every catalog id is declared, and nothing else is", () => {
		expect(Object.keys(MODEL_FACTS).sort()).toEqual(CATALOG_IDS);
	});

	test("rebuilding from the shipped catalog is deterministic and needs no fetch", () => {
		const rebuilt = buildModelFacts(
			NAN_GENERATED_MODELS,
			MODEL_FACTS,
			overrideFieldKeys(MANUAL_OVERRIDES),
			NAN_MODEL_FACTS_META,
		);
		expect(rebuilt).toEqual(NAN_MODEL_FACTS);
	});

	test("the catalog does not change what the provider registers", () => {
		// Facts are a read-only projection; the registration path still derives
		// its models from the generated catalog alone (issue #19 overlay intact).
		const { baselineModels } = packageEntry as unknown as {
			baselineModels?: unknown;
		};
		expect(baselineModels).toBeUndefined();
		for (const id of CATALOG_IDS) {
			expect(factsById[id]!.id).toBe(catalogById.get(id)!.id);
		}
	});
});

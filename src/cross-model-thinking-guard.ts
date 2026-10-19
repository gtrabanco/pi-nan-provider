/**
 * Cross-model thinking guard.
 *
 * Root cause this guards against (pi-ai, verified on 0.87.1): when
 * history is replayed into a DIFFERENT model, `transformMessages` downgrades
 * every non-redacted `thinking` block to a plain `text` block verbatim
 * (`packages/ai/src/api/transform-messages.ts`), and `openai-completions`
 * serializes that into the assistant `content` string. Nothing bounds
 * `block.thinking`, and nothing bounds the SUM across messages.
 *
 * Measured on real sessions: replayed reasoning is 30–60% of the whole context
 * (e.g. 356,723 of 903,464 chars in one session; 349,882 of 749,525 in another).
 * Switching from a 1M-context model (glm5.3-flash, deepseek-v4-flash) to a
 * 262K-context one (`qwen3.6`) then overflows the window, and NaN's gateway
 * answers a generic `400 Invalid request. Check your request parameters.`
 *
 * A per-block cap was tried first and is NOT enough: many medium blocks sum to
 * hundreds of thousands of tokens. This guard therefore DROPS every replayed
 * cross-model `thinking` block outright — it is the reasoning trace that
 * pi-ai would have replayed as plain text, not the model's answers or tool
 * results, so qwen can still answer questions about what glm/deepseek did.
 * Same-model reasoning is never touched (signatures and continuity depend on
 * it), and the guard only acts on requests targeting this package's providers.
 *
 * The extension runs in pi's `context` hook, which fires BEFORE pi-ai's
 * `transformMessages` (pi-agent-core `transformContext` → `convertToLlm` →
 * provider stream). It therefore sees the original `thinking` blocks and can
 * remove them before they become text.
 *
 * UPSTREAM UPDATE (pi-ai 1.3.0, verified 2026-10-15): `transformMessages` now
 * drops cross-model `thinking` blocks itself (`if (!isSameModel) return []`),
 * which is the upstream fix this guard was mitigating. The guard is therefore
 * GATED BY VERSION: it only registers when the host's pi-ai is older than
 * {@link CROSS_MODEL_GUARD_PI_AI_CEILING} (1.3.0). An unknown host version
 * keeps the guard on — the conservative default, since the guard is harmless
 * where pi-ai already drops the blocks and essential where it still replays
 * them.
 *
 * DEPRECATED — REMOVE THIS MODULE when the peer range floor rises to
 * `>=1.3.0`: at that point every supported pi ships the upstream drop and this
 * file (plus the `NAN_THINKING_GUARD` opt-out) is dead code. Users on
 * pi < 1.3.0 should update pi to keep getting the mitigation for free.
 */

import { parsePiAiVersion } from "./pi-ai-version.ts";

/** Env var that opts out of the guard (`0`, `false`, `no` or `off`). Default: enabled. */
export const NAN_THINKING_GUARD_ENV = "NAN_THINKING_GUARD";

/**
 * Exclusive pi-ai version ceiling for this guard: it registers only while the
 * host's pi-ai is OLDER than this version. pi-ai 1.3.0 drops cross-model
 * thinking in `transformMessages` (upstream fix for issue #3), so from 1.3.0
 * on the guard is redundant. Remove this constant together with the module
 * once the peer range floor reaches this version.
 */
export const CROSS_MODEL_GUARD_PI_AI_CEILING = "1.3.0";

/**
 * Whether the guard still applies to a host running the given pi-ai version.
 * `undefined`/`null` (unknown host version) and unparseable versions return
 * `true` — the conservative older-pi default. `false` means the host's pi-ai
 * already drops cross-model thinking itself and the guard must not register.
 */
export function crossModelThinkingGuardCovers(piAiVersion: string | null | undefined): boolean {
	if (piAiVersion === null || piAiVersion === undefined) return true;
	const parsed = parsePiAiVersion(piAiVersion);
	if (!parsed) return true;
	const ceiling = parsePiAiVersion(CROSS_MODEL_GUARD_PI_AI_CEILING);
	if (!ceiling) return true;
	return (
		parsed.major < ceiling.major ||
		(parsed.major === ceiling.major && parsed.minor < ceiling.minor)
	);
}

export interface CrossModelThinkingGuardOptions {
	/** Provider ids this guard applies to (the caller's registered providers). */
	providerIds: ReadonlySet<string>;
}

interface GuardTarget {
	provider?: string;
	api?: string;
	id?: string;
}

interface ThinkingBlock {
	type?: string;
	[k: string]: unknown;
}

interface GuardMessage {
	role?: string;
	provider?: string;
	api?: string;
	model?: string;
	content?: unknown;
}

/** Explicit opt-out only: anything other than a known falsy value keeps the guard on. */
export function crossModelThinkingGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[NAN_THINKING_GUARD_ENV]?.trim().toLowerCase();
	return value !== "0" && value !== "false" && value !== "no" && value !== "off";
}

/**
 * API id pi 0.99 assigns to virtual catalog entries (`core/virtual-models.js`,
 * `VIRTUAL_MODEL_API`). A virtual selection routes each request to a physical
 * model; the physical target is not exposed to the `context` hook, so the guard
 * cannot tell which physical model will answer.
 */
const VIRTUAL_MODEL_API = "pi-virtual";

function isGuardMessage(value: unknown): value is GuardMessage {
	return typeof value === "object" && value !== null;
}

function isThinkingBlock(value: unknown): value is ThinkingBlock {
	return typeof value === "object" && value !== null && (value as ThinkingBlock).type === "thinking";
}

/**
 * Remove every `thinking` block from assistant messages produced by a model
 * other than the target. Returns the SAME array reference when nothing changed,
 * so callers can skip cloning on the common path. Never mutates the input.
 */
export function stripCrossModelThinking<T>(
	messages: readonly T[],
	target: GuardTarget | undefined,
	options: CrossModelThinkingGuardOptions,
): readonly T[] {
	if (!target?.provider || !options.providerIds.has(target.provider)) return messages;

	// Virtual selection (pi 0.99): `ctx.model` is the selectable virtual entry
	// (api "pi-virtual"), not the physical model the router picks for this
	// request. Its api/id never match a physical assistant message, so the
	// same-model check below would strip reasoning on EVERY continuation —
	// including when the router keeps the same physical model — losing the
	// prompt cache and thinking continuity the guard promises to preserve.
	// The routed physical model is not available here, so skip virtual
	// selections entirely; cross-model trimming is the router's concern there.
	if (target.api === VIRTUAL_MODEL_API) return messages;

	let changed = false;

	const next = messages.map((raw) => {
		if (!isGuardMessage(raw) || raw.role !== "assistant" || !Array.isArray(raw.content)) return raw;

		// Same-model replay keeps reasoning intact: signatures and continuity depend on it.
		const isSameModel = raw.provider === target.provider && raw.api === target.api && raw.model === target.id;
		if (isSameModel) return raw;

		const content = (raw.content as unknown[]).filter((block) => !isThinkingBlock(block));
		if (content.length === (raw.content as unknown[]).length) return raw;
		changed = true;
		return { ...raw, content };
	});

	return changed ? next : messages;
}

/**
 * Cross-model thinking guard.
 *
 * Root cause this guards against (pi-ai, still present on 0.85.1 / main): when
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
 * This is a bounded mitigation, not the fix: the unbounded conversion (and pi
 * not re-checking the context size on a model switch) belongs upstream. See
 * https://github.com/gtrabanco/pi-nan-provider/issues/3.
 */

/** Env var that opts out of the guard (`0`, `false`, `no` or `off`). Default: enabled. */
export const NAN_THINKING_GUARD_ENV = "NAN_THINKING_GUARD";

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

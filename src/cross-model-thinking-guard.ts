/**
 * Cross-model thinking guard.
 *
 * Root cause this guards against (pi-ai, still present on 0.85.1 / main): when
 * history is replayed into a DIFFERENT model, `transformMessages` downgrades
 * every non-redacted `thinking` block to a plain `text` block verbatim
 * (`packages/ai/src/api/transform-messages.ts`), and `openai-completions`
 * serializes that into the assistant `content` string. Nothing bounds
 * `block.thinking`, so a long/degenerate reasoning trace from the previous
 * model (seen in the wild: a 445,888-char / 131,072-token thinking block after
 * `glm5.3-flash` ended with `stopReason: "length"`) is replayed as a 445 KB
 * assistant text message. The request then exceeds the destination model's
 * context window and NaN's gateway answers with a generic
 * `400 Invalid request. Check your request parameters.` (verified live
 * 2026-09-10: the same payload returns 200 for deepseek-v4-flash /
 * glm5.3-flash and 200 for qwen3.6 once that message is removed).
 *
 * The extension runs in pi's `context` hook, which fires BEFORE pi-ai's
 * `transformMessages` (pi-agent-core `transformContext` → `convertToLlm` →
 * provider stream). It therefore sees the original `thinking` blocks and can
 * bound what they will become. Only messages whose (provider, api, model)
 * differ from the target are touched; same-model replay keeps its reasoning
 * byte-for-byte because signatures/continuity depend on it.
 *
 * This is a bounded mitigation, not a fix: it caps each replayed cross-model
 * reasoning block, which is sufficient for the observed single-degenerate-trace
 * failure. The real fix belongs upstream (see
 * https://github.com/earendil-works/pi/issues/9433).
 */

/** Env var that opts out of the guard (`0`, `false`, `no` or `off`). Default: enabled. */
export const NAN_THINKING_GUARD_ENV = "NAN_THINKING_GUARD";

/**
 * Maximum characters of a single cross-model reasoning block replayed as text.
 * 16,000 chars is ~4K tokens — far above any real reasoning trace, far below
 * the 445,888-char degenerate trace that caused the 400.
 */
export const MAX_CROSS_MODEL_THINKING_CHARS = 16_000;

/** Appended after the kept prefix so the substitution is visible, never silent. */
export const CROSS_MODEL_THINKING_TRUNCATION_MARKER =
	"\n\n[…previous-model reasoning truncated by pi-nan-provider to keep the request within NaN's context]";

export interface CrossModelThinkingGuardOptions {
	/** Max chars kept per replayed cross-model reasoning block. */
	maxCharsPerBlock?: number;
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
	thinking?: unknown;
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
 * Bound every cross-model `thinking` block to `maxCharsPerBlock` characters.
 *
 * Returns the SAME array reference when nothing changed, so callers can skip
 * cloning the whole context on the common path. Never mutates the input.
 */
export function boundCrossModelThinking<T>(
	messages: readonly T[],
	target: GuardTarget | undefined,
	options: CrossModelThinkingGuardOptions,
): readonly T[] {
	if (!target?.provider || !options.providerIds.has(target.provider)) return messages;

	const maxChars = options.maxCharsPerBlock ?? MAX_CROSS_MODEL_THINKING_CHARS;
	let changed = false;

	const next = messages.map((raw) => {
		if (!isGuardMessage(raw) || raw.role !== "assistant" || !Array.isArray(raw.content)) return raw;

		// Same-model replay keeps reasoning intact: signatures and continuity depend on it.
		const isSameModel = raw.provider === target.provider && raw.api === target.api && raw.model === target.id;
		if (isSameModel) return raw;

		let messageChanged = false;
		const content = (raw.content as unknown[]).map((block) => {
			if (!isThinkingBlock(block)) return block;
			const text = block.thinking;
			if (typeof text !== "string" || text.length <= maxChars) return block;
			messageChanged = true;
			return { ...block, thinking: text.slice(0, maxChars) + CROSS_MODEL_THINKING_TRUNCATION_MARKER };
		});

		if (!messageChanged) return raw;
		changed = true;
		return { ...raw, content };
	});

	return changed ? next : messages;
}

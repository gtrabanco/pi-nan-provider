/**
 * Optional bridge to the community stdio MCP server
 * `nan-mcp-server` (https://github.com/luciferfran/nan-mcp-server), which
 * exposes NaN's media tools: image generation/editing (flux-2-klein), TTS
 * (kokoro), STT (whisper), plus voice listing.
 *
 * Opt-in and fully lazy:
 * - OFF by default. Enable with NAN_MEDIA_MCP=1.
 * - The server process is spawned per tool call and terminated right after —
 *   zero startup cost, nothing runs unless audio/image/transcription is
 *   actually invoked.
 * - NAN_API_KEY is forwarded to the child; NAN_OUTPUT_DIR and the server's
 *   other env vars inherit from your environment (generated files land in
 *   ~/nan-mcp-output/ by default).
 * - Version pinning follows the upstream server's own supply-chain guidance:
 *   NAN_MEDIA_MCP_VERSION (default "1.0.7"), or pass a custom command with
 *   NAN_MEDIA_MCP_COMMAND (space-separated, e.g. "bunx nan-mcp-server@1.0.7").
 */

import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callStdioMcpTool } from "./stdio-client.ts";
import { bridgeSource, resolveBridgeEnabled, type BridgeSource } from "./state.ts";
import { NAN_API_KEY_ENV, resolveNanApiKey, type NapiKeyContext } from "./nan-search.ts";

export const NAN_MEDIA_MCP_ENV = "NAN_MEDIA_MCP";
export const NAN_MEDIA_MCP_VERSION_ENV = "NAN_MEDIA_MCP_VERSION";
export const NAN_MEDIA_MCP_COMMAND_ENV = "NAN_MEDIA_MCP_COMMAND";
export const NAN_MEDIA_MCP_TIMEOUT_ENV = "NAN_MEDIA_MCP_TIMEOUT_MS";
export const DEFAULT_NAN_MEDIA_MCP_VERSION = "1.0.7";
export const DEFAULT_MEDIA_MCP_TIMEOUT_MS = 120_000;

/** Media tools bridged from the stdio MCP server (audio/image/transcription scope). */
export const NAN_MEDIA_TOOLS = [
	"nan_generate_image",
	"nan_edit_image",
	"nan_text_to_speech",
	"nan_list_voices",
	"nan_speech_to_text",
] as const;

/** Truthy env parse for the media bridge env var: 1/true/on (case-insensitive). */
function envTruthy(): boolean {
	return envValueIsTruthy(process.env[NAN_MEDIA_MCP_ENV]);
}

/** Whether the env var is explicitly set (any value) — it overrides the persisted toggle. */
function envExplicit(): boolean {
	const value = process.env[NAN_MEDIA_MCP_ENV];
	return value !== undefined && value.trim() !== "";
}

function envValueIsTruthy(value: string | undefined): boolean {
	return value?.trim().toLowerCase() === "1" || value?.trim().toLowerCase() === "true" || value?.trim().toLowerCase() === "on";
}

/**
 * Effective enablement of the community media MCP bridge: an explicit
 * `NAN_MEDIA_MCP` env var (any value, e.g. `0` to force one session off)
 * wins; then the toggle persisted by `/nan-mcp`; default: **enabled** (both
 * bridges are on and lazy by default — the server spawns per tool call).
 */
export function mediaMcpEnabled(): boolean {
	return resolveBridgeEnabled("mediaMcp", envExplicit(), envTruthy(), true);
}

/** Source of the effective media enablement (env / persisted / default). */
export function mediaMcpSource(): BridgeSource {
	return bridgeSource("mediaMcp", envExplicit());
}

/** Default spawn: `npx -y nan-mcp-server@<pinned version>` (npx caches after first use). */
export function mediaMcpCommand(version = process.env[NAN_MEDIA_MCP_VERSION_ENV] || DEFAULT_NAN_MEDIA_MCP_VERSION): string[] {
	const custom = process.env[NAN_MEDIA_MCP_COMMAND_ENV]?.trim();
	if (custom) return custom.split(/\s+/);
	return ["npx", "-y", `nan-mcp-server@${version}`];
}

function mediaMcpTimeoutMs(): number {
	const parsed = Number.parseInt(process.env[NAN_MEDIA_MCP_TIMEOUT_ENV] ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MEDIA_MCP_TIMEOUT_MS;
}

interface MediaToolSpec<TParams extends TSchema = TSchema> {
	name: (typeof NAN_MEDIA_TOOLS)[number];
	mcpTool: string;
	label: string;
	description: string;
	promptSnippet: string;
	parameters: TParams;
}

const sizeProperty = () =>
	Type.Optional(
		Type.String({
			description: 'Image size "WxH" divisible by 16, e.g. 1024x1024, 1536x1024, 1024x1536. Default 1024x1024',
		}),
	);

function defineMediaTool<TParams extends TSchema>(spec: MediaToolSpec<TParams>): ToolDefinition<TParams> {
	return {
		name: spec.name,
		label: spec.label,
		description: spec.description,
		promptSnippet: spec.promptSnippet,
		parameters: spec.parameters,
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const apiKey = await resolveNanApiKey(ctx as unknown as NapiKeyContext);
			if (!apiKey) {
				throw new Error(`${NAN_API_KEY_ENV} is not set. Export it or run /login nan to use NaN media tools.`);
			}
			const result = await callStdioMcpTool(spec.mcpTool, params as Record<string, unknown>, {
				command: mediaMcpCommand(),
				env: { [NAN_API_KEY_ENV]: apiKey },
				timeoutMs: mediaMcpTimeoutMs(),
				...(signal ? { signal } : {}),
			});
			if (!result.ok) {
				throw new Error(
					`${result.error ?? "nan-mcp-server call failed"}${result.stderrTail ? ` (server stderr: ${result.stderrTail})` : ""}`,
				);
			}
			return { content: [{ type: "text", text: result.text }], details: undefined } as const;
		},
	};
}

/**
 * Build the media tool set. Registered only when NAN_MEDIA_MCP=1 and the
 * runtime supports registerTool; execution spawns the MCP server per call.
 * Schemas mirror nan-mcp-server's zod input schemas (v1.0.7).
 */
export function createNanMediaTools(): ToolDefinition[] {
	return [
		defineMediaTool({
			name: "nan_generate_image",
			mcpTool: "generate_image",
			label: "NaN Generate Image",
			description:
				"Generate an image with flux-2-klein (NaN API). Returns the saved image file path (under ~/nan-mcp-output/ by default) and its URL.",
			promptSnippet: "nan_generate_image(prompt, size?, n?, seed?, guidance?, outputName?): generate an image via NaN (flux-2-klein)",
			parameters: Type.Object({
				prompt: Type.String({ description: "Textual description of the image to generate" }),
				size: sizeProperty(),
				n: Type.Optional(Type.Integer({ description: "Number of images to generate (1-4). Default 1", minimum: 1, maximum: 4 })),
				seed: Type.Optional(Type.Number({ description: "Base seed for reproducibility" })),
				guidance: Type.Optional(Type.Number({ description: "FLUX guidance scale" })),
				outputName: Type.Optional(Type.String({ description: "Optional base name for the output file(s)" })),
			}),
		}),
		defineMediaTool({
			name: "nan_edit_image",
			mcpTool: "edit_image",
			label: "NaN Edit Image",
			description:
				"Edit an image with flux-2-klein image-to-image (NaN API). Takes reference image files and applies a transformation. Returns the saved output image path.",
			promptSnippet: "nan_edit_image(prompt, images, size?, n?, seed?, guidance?, outputName?): edit images via NaN (flux-2-klein)",
			parameters: Type.Object({
				prompt: Type.String({ description: "Description of the edit or transformation to apply" }),
				images: Type.Array(Type.String(), {
					description: "Absolute paths to reference image files (PNG, JPEG, WebP; up to 4, each < 25MB)",
				}),
				size: sizeProperty(),
				n: Type.Optional(Type.Integer({ description: "Number of images to generate (1-4). Default 1", minimum: 1, maximum: 4 })),
				seed: Type.Optional(Type.Number({ description: "Base seed for reproducibility" })),
				guidance: Type.Optional(Type.Number({ description: "FLUX guidance scale" })),
				outputName: Type.Optional(Type.String({ description: "Optional base name for the output file(s)" })),
			}),
		}),
		defineMediaTool({
			name: "nan_text_to_speech",
			mcpTool: "text_to_speech",
			label: "NaN Text To Speech",
			description:
				"Synthesize audio from text with kokoro (NaN API TTS). Returns the saved audio file path. Use nan_list_voices to see all available voices per language.",
			promptSnippet: "nan_text_to_speech(text, voice?, format?, speed?, outputName?): synthesize speech via NaN (kokoro)",
			parameters: Type.Object({
				text: Type.String({ description: "Text to synthesize" }),
				voice: Type.Optional(
					Type.String({
						description:
							'Voice to use, e.g. "af_heart" (American English female), "ef_dora" (Spanish female), "em_alex" (Spanish male). Use nan_list_voices for the full catalog',
					}),
				),
				format: Type.Optional(
					Type.Unsafe<"mp3" | "wav" | "flac" | "aac" | "pcm" | "opus">({
						type: "string",
						enum: ["mp3", "wav", "flac", "aac", "pcm", "opus"],
						description: "Audio format. Default mp3",
					}),
				),
				speed: Type.Optional(Type.Number({ description: "Speech speed. Default 1.0" })),
				outputName: Type.Optional(Type.String({ description: "Optional base name for the output file" })),
			}),
		}),
		defineMediaTool({
			name: "nan_list_voices",
			mcpTool: "list_voices",
			label: "NaN List Voices",
			description: "List all available kokoro TTS voices grouped by language.",
			promptSnippet: "nan_list_voices(): list available kokoro TTS voices",
			parameters: Type.Object({}),
		}),
		defineMediaTool({
			name: "nan_speech_to_text",
			mcpTool: "speech_to_text",
			label: "NaN Speech To Text",
			description: "Transcribe an audio file with whisper (NaN API STT). Returns the transcript.",
			promptSnippet: "nan_speech_to_text(file, language?, verbose?): transcribe an audio file via NaN (whisper)",
			parameters: Type.Object({
				file: Type.String({ description: "Absolute path to the audio file to transcribe" }),
				language: Type.Optional(
					Type.String({ description: 'ISO-639-1 language code, e.g. "es", "en". Auto-detected if omitted' }),
				),
				verbose: Type.Optional(Type.Boolean({ description: "Return verbose JSON with segments instead of plain text" })),
			}),
		}),
	];
}

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";

import {
	type GenerateObjectRequest,
	LlmNotBilledError,
	type LlmProvider,
	LlmRefusalError,
	NOT_BILLED_STATUSES,
	redactRequest,
} from "./llm";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
/**
 * Tailoring's default (the user's choice, 2026-10-31): about half Opus's price per draft. Same
 * request surface as Opus 5.5: adaptive thinking, `output_config.effort` low to max, structured
 * output through `output_config.format`, and `fallbacks: "default"` on the Claude API.
 */
export const DEFAULT_TAILOR_MODEL = "claude-sonnet-5-5";

export interface AnthropicProviderOptions {
	apiKey?: string;
	/** Defaults to `claude-opus-5-5`; set `ANTHROPIC_MODEL` to change it. */
	model?: string;
	effort?: "low" | "medium" | "high" | "xhigh" | "max";
	/** Server-side refusal fallback (beta). On by default; set false to disable. */
	fallbacks?: boolean;
	client?: Anthropic;
}

/**
 * Structured output with a Zod schema, streamed because the SDK refuses long non-streaming requests.
 * SDK retries are off: one call is one request under one spending reservation, so a possibly
 * billed 5xx is never hidden behind a retried 400 or a later success. The workflow step retries
 * instead, and each retry reserves again.
 */
export class AnthropicProvider implements LlmProvider {
	readonly name: string;
	private readonly client: Anthropic;
	private readonly model: string;
	private readonly effort: NonNullable<AnthropicProviderOptions["effort"]>;
	private readonly fallbacks: boolean;

	constructor(options: AnthropicProviderOptions = {}) {
		this.client =
			options.client ??
			new Anthropic({
				...(options.apiKey ? { apiKey: options.apiKey } : {}),
				maxRetries: 0,
			});
		this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
		this.effort = options.effort ?? "medium";
		this.fallbacks = options.fallbacks ?? true;
		this.name = `anthropic:${this.model}`;
	}

	async generateObject<T>(raw: GenerateObjectRequest<T>): Promise<T> {
		const request = redactRequest(raw);
		const stream = this.client.beta.messages.stream(
			{
				model: this.model,
				max_tokens: request.maxTokens ?? 16000,
				thinking: { type: "adaptive" },
				system: request.system,
				messages: [
					{
						role: "user",
						// One cache breakpoint after the stable prefix: the system prompt and the profile
						// are read from the cache by the next call of the task within 5 minutes.
						content: request.promptPrefix
							? [
									{
										type: "text",
										text: request.promptPrefix,
										cache_control: { type: "ephemeral" },
									},
									{ type: "text", text: request.prompt },
								]
							: request.prompt,
					},
				],
				output_config: {
					effort: this.effort,
					format: betaZodOutputFormat(request.schema as never),
				},
				...(this.fallbacks
					? {
							betas: ["server-side-fallback-2026-07-01"],
							fallbacks: "default" as const,
						}
					: {}),
			},
			// Also for an injected client, whatever its own default.
			{ maxRetries: 0 },
		);
		let response: Awaited<ReturnType<typeof stream.finalMessage>>;
		try {
			response = await stream.finalMessage();
		} catch (error) {
			// Refused before processing: not billed. Anything else (5xx, a dropped stream) may be.
			const status = (error as { status?: unknown }).status;
			if (
				error instanceof Anthropic.APIError &&
				typeof status === "number" &&
				NOT_BILLED_STATUSES.has(status)
			)
				throw new LlmNotBilledError(request.task, status, error.message);
			throw error;
		}
		const usage = response.usage as {
			input_tokens?: number;
			output_tokens?: number;
			cache_read_input_tokens?: number | null;
			cache_creation_input_tokens?: number | null;
			cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null;
		};
		request.onUsage?.({
			model: response.model ?? this.model,
			inputTokens: usage?.input_tokens ?? 0,
			outputTokens: usage?.output_tokens ?? 0,
			cachedInputTokens: usage?.cache_read_input_tokens ?? 0,
			cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
			cacheWrite1hTokens: usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0,
		});
		if (response.stop_reason === "refusal") {
			throw new LlmRefusalError(
				request.task,
				response.stop_details?.explanation ?? "refusal",
			);
		}
		if (response.parsed_output == null) {
			throw new Error(
				`${this.name} returned no parseable output for ${request.task} (stop_reason=${response.stop_reason})`,
			);
		}
		return request.schema.parse(response.parsed_output);
	}
}

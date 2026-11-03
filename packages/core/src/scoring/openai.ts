import { z } from "zod";

import type { FetchLike } from "../sources/types";
import {
	fullPrompt,
	type GenerateObjectRequest,
	LlmNotBilledError,
	type LlmProvider,
	LlmRefusalError,
	NOT_BILLED_STATUSES,
	redactRequest,
} from "./llm";

export interface OpenAiProviderOptions {
	apiKey: string;
	/** Required: set `OPENAI_MODEL`. No default, so a deployment never runs on a guessed model. */
	model: string;
	/** Reasoning effort for reasoning models; omitted when unset. */
	reasoningEffort?: "minimal" | "low" | "medium" | "high";
	baseUrl?: string;
	fetch?: FetchLike;
}

type JsonSchema = Record<string, unknown>;

/**
 * Strict structured outputs need every property listed in `required` and no additional
 * properties, on every object in the schema.
 */
export function toStrictJsonSchema(schema: z.ZodType): JsonSchema {
	const json = z.toJSONSchema(schema, { target: "draft-7" }) as JsonSchema;
	const visit = (node: unknown): void => {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		const obj = node as JsonSchema;
		delete obj.$schema;
		if (obj.type === "object" && obj.properties) {
			obj.required = Object.keys(obj.properties as JsonSchema);
			obj.additionalProperties = false;
		}
		for (const value of Object.values(obj)) visit(value);
	};
	visit(json);
	return json;
}

interface ResponsesOutput {
	model?: string;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		input_tokens_details?: { cached_tokens?: number };
	};
	status?: string;
	incomplete_details?: { reason?: string } | null;
	error?: { message?: string } | null;
	output?: {
		type: string;
		content?: { type: string; text?: string; refusal?: string }[];
	}[];
}

/** OpenAI Responses API with strict JSON-schema output, over plain fetch (works on Workers). */
export class OpenAiProvider implements LlmProvider {
	readonly name: string;
	private readonly fetchImpl: FetchLike;

	constructor(private readonly options: OpenAiProviderOptions) {
		if (!options.apiKey) throw new Error("OpenAiProvider needs an API key");
		if (!options.model) throw new Error("OpenAiProvider needs a model");
		this.fetchImpl = options.fetch ?? fetch;
		this.name = `openai:${options.model}`;
	}

	async generateObject<T>(raw: GenerateObjectRequest<T>): Promise<T> {
		const request = redactRequest(raw);
		const response = await this.fetchImpl(
			`${this.options.baseUrl ?? "https://api.openai.com/v1"}/responses`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${this.options.apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: this.options.model,
					instructions: request.system,
					input: fullPrompt(request),
					max_output_tokens: request.maxTokens ?? 16000,
					...(this.options.reasoningEffort
						? { reasoning: { effort: this.options.reasoningEffort } }
						: {}),
					text: {
						format: {
							type: "json_schema",
							name: request.task.replace(/[^a-zA-Z0-9_-]/g, "_"),
							strict: true,
							schema: toStrictJsonSchema(request.schema),
						},
					},
				}),
			},
		);
		const body = (await response.json().catch(() => ({}))) as ResponsesOutput;
		if (body.usage) {
			const cached = body.usage.input_tokens_details?.cached_tokens ?? 0;
			request.onUsage?.({
				model: body.model ?? this.options.model,
				// OpenAI's input_tokens include the cached ones.
				inputTokens: Math.max(0, (body.usage.input_tokens ?? 0) - cached),
				outputTokens: body.usage.output_tokens ?? 0,
				cachedInputTokens: cached,
				cacheWriteTokens: 0,
			});
		}
		if (!response.ok && !body.usage && NOT_BILLED_STATUSES.has(response.status))
			throw new LlmNotBilledError(
				request.task,
				response.status,
				body.error?.message ?? "",
			);
		if (!response.ok)
			throw new Error(
				`${this.name} ${request.task}: HTTP ${response.status} ${body.error?.message ?? ""}`.trim(),
			);
		const content = (body.output ?? [])
			.filter((item) => item.type === "message")
			.flatMap((item) => item.content ?? []);
		const refusal = content.find((part) => part.type === "refusal");
		if (refusal) throw new LlmRefusalError(request.task, refusal.refusal ?? "");
		if (body.status === "incomplete")
			throw new Error(
				`${this.name} ${request.task}: incomplete (${body.incomplete_details?.reason ?? "unknown"})`,
			);
		const text = content
			.filter((part) => part.type === "output_text")
			.map((part) => part.text ?? "")
			.join("");
		if (!text)
			throw new Error(`${this.name} returned no output for ${request.task}`);
		return request.schema.parse(JSON.parse(text));
	}
}

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { LlmNotBilledError, LlmRefusalError } from "../src/scoring/llm";
import { OpenAiProvider, toStrictJsonSchema } from "../src/scoring/openai";

const schema = z.object({
	claims: z.array(
		z.object({ text: z.string(), supported: z.boolean(), note: z.string() }),
	),
});

function fakeOpenAi(reply: unknown, status = 200) {
	const requests: { url: string; body: Record<string, unknown> }[] = [];
	const fetchImpl = async (url: string, init?: RequestInit) => {
		requests.push({ url, body: JSON.parse(String(init?.body)) });
		return new Response(JSON.stringify(reply), { status });
	};
	return { requests, fetchImpl };
}

const request = {
	task: "claims-check",
	system: "Check claims.",
	prompt: "CV text",
	schema,
};

describe("OpenAiProvider", () => {
	it("sends a strict JSON schema to the Responses API and parses the output", async () => {
		const { requests, fetchImpl } = fakeOpenAi({
			status: "completed",
			output: [
				{ type: "reasoning" },
				{
					type: "message",
					content: [
						{
							type: "output_text",
							text: '{"claims":[{"text":"x","supported":true,"note":""}]}',
						},
					],
				},
			],
		});
		const llm = new OpenAiProvider({
			apiKey: "sk-test",
			model: "model-x",
			fetch: fetchImpl,
		});
		expect(await llm.generateObject(request)).toEqual({
			claims: [{ text: "x", supported: true, note: "" }],
		});
		expect(requests[0]?.url).toBe("https://api.openai.com/v1/responses");
		expect(requests[0]?.body).toMatchObject({
			model: "model-x",
			instructions: "Check claims.",
			input: "CV text",
			text: {
				format: { type: "json_schema", name: "claims-check", strict: true },
			},
		});
	});

	it("marks every object property required with no extras", () => {
		const json = toStrictJsonSchema(schema) as {
			required: string[];
			additionalProperties: boolean;
			properties: {
				claims: {
					items: { required: string[]; additionalProperties: boolean };
				};
			};
		};
		expect(json.required).toEqual(["claims"]);
		expect(json.additionalProperties).toBe(false);
		expect(json.properties.claims.items.required).toEqual([
			"text",
			"supported",
			"note",
		]);
		expect(json.properties.claims.items.additionalProperties).toBe(false);
	});

	it("raises refusals, HTTP errors and incomplete output", async () => {
		const refusal = fakeOpenAi({
			output: [
				{ type: "message", content: [{ type: "refusal", refusal: "no" }] },
			],
		});
		await expect(
			new OpenAiProvider({
				apiKey: "k",
				model: "m",
				fetch: refusal.fetchImpl,
			}).generateObject(request),
		).rejects.toBeInstanceOf(LlmRefusalError);
		const failed = fakeOpenAi({ error: { message: "bad key" } }, 401);
		await expect(
			new OpenAiProvider({
				apiKey: "k",
				model: "m",
				fetch: failed.fetchImpl,
			}).generateObject(request),
		).rejects.toThrow(/HTTP 401 bad key/);
		const cut = fakeOpenAi({
			status: "incomplete",
			incomplete_details: { reason: "max_output_tokens" },
			output: [],
		});
		await expect(
			new OpenAiProvider({
				apiKey: "k",
				model: "m",
				fetch: cut.fetchImpl,
			}).generateObject(request),
		).rejects.toThrow(/max_output_tokens/);
	});
});

describe("OpenAiProvider billing on errors", () => {
	const provider = (status: number) =>
		new OpenAiProvider({
			apiKey: "k",
			model: "gpt-6.1-terra",
			fetch: fakeOpenAi({ error: { message: "nope" } }, status).fetchImpl,
		});

	it("marks a refusal before processing (429) as not billed", async () => {
		await expect(provider(429).generateObject(request)).rejects.toBeInstanceOf(
			LlmNotBilledError,
		);
	});

	it("leaves a server error unclassified, since it may have been billed", async () => {
		const error = await provider(500)
			.generateObject(request)
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(LlmNotBilledError);
	});
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	query,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { claudeQueryOptions, jsonSchemaOf } from "../src/claude";
import { subscriptionEnv } from "../src/env";
import { type Answer, captureServer, structuredOutputStream } from "./capture";

/**
 * The real CLI with the production options against a local capture server: a refused request
 * or an answer that fails the schema is one request, not a retry storm, and ends in the
 * messages the provider maps (see "what the real CLI emits" in claude-provider.test.ts).
 */

let root: string;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "offerfinch-errors-"));
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

async function runAgainst(answer: Answer) {
	const server = await captureServer((req) =>
		req.method === "POST" ? answer : { status: 404 },
	);
	const cwd = await mkdtemp(join(root, "cwd-"));
	const home = await mkdtemp(join(root, "home-"));
	const { env } = subscriptionEnv({ PATH: process.env.PATH, HOME: home });
	const options = claudeQueryOptions({
		model: "claude-sonnet-5-5",
		system: "You extract a greeting.",
		schema: jsonSchemaOf(z.object({ greeting: z.string() })),
		cwd,
		env: {
			...env,
			ANTHROPIC_BASE_URL: server.url,
			ANTHROPIC_API_KEY: "sk-ant-capture-dummy",
		},
	});
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	async function* input(): AsyncGenerator<SDKUserMessage> {
		await gate;
		yield {
			type: "user",
			message: { role: "user", content: "Say hi" },
			parent_tool_use_id: null,
		} as SDKUserMessage;
	}
	const session = query({ prompt: input(), options });
	void session.initializationResult().then(() => release());
	const messages: SDKMessage[] = [];
	try {
		for await (const message of session) messages.push(message);
	} catch {
		// The CLI exits non-zero after an error result.
	}
	await server.close();
	return {
		messages,
		posts: server.requests.filter((r) => r.method === "POST").length,
	};
}

describe("the real CLI on errors", () => {
	it("makes one request for an answer that fails the schema, and reports it", async () => {
		const { messages, posts } = await runAgainst(
			structuredOutputStream("claude-sonnet-5-5", { wrong: 1 }),
		);
		expect(posts).toBe(1);
		expect(messages.find((m) => m.type === "result")).toMatchObject({
			subtype: "error_max_structured_output_retries",
		});
	}, 120_000);

	it("makes one request for a 429 and marks it a rate limit", async () => {
		const { messages, posts } = await runAgainst({
			status: 429,
			body: {
				type: "error",
				error: { type: "rate_limit_error", message: "rate limited" },
			},
		});
		expect(posts).toBe(1);
		expect(
			messages.find((m) => m.type === "assistant" && m.error === "rate_limit"),
		).toBeDefined();
	}, 120_000);

	it("makes one request for a 401 and marks it a failed login", async () => {
		const { messages, posts } = await runAgainst({
			status: 401,
			body: {
				type: "error",
				error: { type: "authentication_error", message: "invalid key" },
			},
		});
		expect(posts).toBe(1);
		expect(
			messages.find(
				(m) => m.type === "assistant" && m.error === "authentication_failed",
			),
		).toBeDefined();
	}, 120_000);
});

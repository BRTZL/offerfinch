import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	query,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
	ALLOWED_TOOLS,
	BUILTIN_SKILLS,
	boundaryViolations,
	claudeQueryOptions,
	jsonSchemaOf,
	sessionReport,
} from "../src/claude";
import { subscriptionEnv } from "../src/env";
import {
	type Captured,
	captureServer,
	structuredOutputStream,
} from "./capture";

/**
 * What the model would see on a subscription call, read off the wire. The production options
 * run the real Claude Code CLI against a local capture server (a dummy API key and base URL are
 * the only additions), with the user's kinds of configuration planted around it: a user
 * CLAUDE.md, settings with a hook and an MCP server, a skill, a `.mcp.json`, and CLAUDE.md and
 * AGENTS.md above the working directory. None of it may reach the request, and the only tool
 * may be the structured-output carrier. Nothing leaves 127.0.0.1.
 */

const CANARY = "CANARY_7f3a91";
const PLACEHOLDER = "DeferredToolPlaceholder";

let root: string;
let home: string;
let cwd: string;
let server: Awaited<ReturnType<typeof captureServer>>;
const messages: SDKMessage[] = [];
let posts: Captured[] = [];

async function plant(path: string, content: string) {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, content);
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "offerfinch-boundary-"));
	home = join(root, "home");
	const parent = join(root, "work");
	cwd = join(parent, "empty");
	await mkdir(cwd, { recursive: true });
	const hook = `touch ${join(root, "hook-ran")}`;
	await plant(join(home, ".claude", "CLAUDE.md"), `${CANARY} user memory`);
	await plant(
		join(home, ".claude", "settings.json"),
		JSON.stringify({
			hooks: {
				SessionStart: [{ hooks: [{ type: "command", command: hook }] }],
				UserPromptSubmit: [{ hooks: [{ type: "command", command: hook }] }],
			},
			permissions: { allow: ["Bash", "Read"] },
			env: { ANTHROPIC_API_KEY: "sk-ant-from-settings" },
		}),
	);
	await plant(
		join(home, ".claude", "skills", "canary", "SKILL.md"),
		`---\nname: canary\ndescription: ${CANARY} skill\n---\n${CANARY}`,
	);
	await plant(
		join(home, ".claude.json"),
		JSON.stringify({
			mcpServers: { canary: { command: "sh", args: ["-c", hook] } },
		}),
	);
	await plant(join(parent, "CLAUDE.md"), `${CANARY} project memory`);
	await plant(join(parent, "AGENTS.md"), `${CANARY} agents file`);
	await plant(
		join(parent, ".mcp.json"),
		JSON.stringify({
			mcpServers: { canary: { command: "sh", args: ["-c", hook] } },
		}),
	);

	server = await captureServer((req) =>
		req.method === "POST" && req.url.startsWith("/v1/messages")
			? structuredOutputStream("claude-sonnet-5-5", { greeting: "hi" })
			: { status: 404 },
	);
	const { env } = subscriptionEnv({
		PATH: process.env.PATH,
		HOME: home,
		TMPDIR: process.env.TMPDIR,
		// Removed by the allowlist: the capture base URL and key are added below on purpose.
		ANTHROPIC_API_KEY: "sk-ant-parent",
	});
	const options = claudeQueryOptions({
		model: "claude-sonnet-5-5",
		effort: "low",
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
	// As the provider does: the prompt exists for the CLI only after its initialize answer.
	void session.initializationResult().then(() => release());
	for await (const message of session) messages.push(message);
	posts = server.requests.filter(
		(r) => r.method === "POST" && r.url.startsWith("/v1/messages"),
	);
}, 120_000);

afterAll(async () => {
	await server?.close();
	await rm(root, { recursive: true, force: true });
});

function init() {
	const found = messages.find(
		(m): m is Extract<SDKMessage, { type: "system"; subtype: "init" }> =>
			m.type === "system" && m.subtype === "init",
	);
	if (!found) throw new Error("no init message");
	return found;
}

describe("a Claude subscription call is a pure model call", () => {
	it("answers with the structured output, parsed, from one request", () => {
		const result = messages.find((m) => m.type === "result");
		expect(result).toMatchObject({
			subtype: "success",
			is_error: false,
			structured_output: { greeting: "hi" },
		});
		expect(posts.length).toBe(1);
	});

	it("starts with no tools but the structured-output carrier, no MCP, skills or memory", () => {
		const report = sessionReport(init());
		expect(report.tools).toEqual([...ALLOWED_TOOLS]);
		expect(report.mcpServers).toEqual([]);
		// Only the CLI's own built-in skills stay listed (not callable: no Skill tool).
		expect(report.skills.filter((s) => !BUILTIN_SKILLS.includes(s))).toEqual(
			[],
		);
		expect(report.skills).not.toContain("canary");
		expect(boundaryViolations(report, cwd)).toEqual([]);
	});

	it("sends no tool the model could act with, on any request", () => {
		for (const post of posts) {
			const body = post.body as { tools?: { name: string }[] };
			const names = (body.tools ?? []).map((t) => t.name);
			expect(
				names.filter((n) => ![...ALLOWED_TOOLS, PLACEHOLDER].includes(n)),
			).toEqual([]);
		}
	});

	it("sends none of the user's or the project's configuration", () => {
		for (const post of posts) {
			const text = JSON.stringify(post.body);
			expect(text).not.toContain(CANARY);
			expect(text).toContain("You extract a greeting.");
		}
	});

	it("runs no hook and starts no MCP server", async () => {
		const { existsSync } = await import("node:fs");
		expect(existsSync(join(root, "hook-ran"))).toBe(false);
		expect(
			messages.filter((m) => m.type === "system" && /hook/.test(m.subtype)),
		).toEqual([]);
	});

	it("sends the model no description of skills, agents or plugins", () => {
		const text = JSON.stringify(posts.map((p) => p.body));
		for (const word of [
			...BUILTIN_SKILLS,
			"agents-md",
			"Explore",
			"general-purpose",
			"Skill",
		])
			expect(text).not.toContain(word);
	});
});

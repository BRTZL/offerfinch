import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	query as inProcessQuery,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { claudeQueryOptions, jsonSchemaOf } from "../src/claude";
import { subscriptionEnv } from "../src/env";
import { type ClaudeQuery, isolatedQuery } from "../src/isolated";
import { captureServer, structuredOutputStream } from "./capture";

/**
 * A real prompt holds profile data, so no prompt text may land on disk: not in the user's
 * `~/.claude`, not in CLAUDE_CONFIG_DIR, not in a temp directory, not in a debug log. The real
 * CLI runs against a local capture server (dummy key and base URL, as in the boundary test)
 * with a synthetic home, config directory and TMPDIR, while this process carries the SDK's
 * debug switches (DEBUG_CLAUDE_AGENT_SDK=1, DEBUG=1, DEBUG_SDK=1) and points CLAUDE_CONFIG_DIR
 * at the synthetic config. The capture server must see the canary (the prompt was sent), and
 * no file may hold it afterwards. Nothing leaves 127.0.0.1.
 *
 * The control runs the same call with the SDK loaded in this process, as the provider did
 * before `isolated.ts`: the pinned SDK then writes the prompt into a debug log under
 * CLAUDE_CONFIG_DIR, which shows the scan finds what it looks for.
 */

const CANARY = "PROFILE_CANARY_d41c7e02";
const PARENT_SWITCHES = {
	DEBUG_CLAUDE_AGENT_SDK: "1",
	DEBUG: "1",
	DEBUG_SDK: "1",
};

let root: string;
let home: string;
let config: string;
let tmp: string;
let cwd: string;
let started: number;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
	started = Date.now() - 1_000;
	root = await mkdtemp(join(tmpdir(), "offerfinch-canary-"));
	home = join(root, "home");
	config = join(root, "claude-config");
	tmp = join(root, "tmp");
	cwd = join(root, "cwd");
	for (const dir of [home, config, tmp, cwd])
		await mkdir(dir, { recursive: true });
	// This process: the SDK's debug switches, and its config dir and home on the synthetic ones,
	// so even the in-process control never writes into the real ~/.claude.
	const parent = { ...PARENT_SWITCHES, CLAUDE_CONFIG_DIR: config, HOME: home };
	for (const [key, value] of Object.entries(parent)) {
		saved[key] = process.env[key];
		process.env[key] = value;
	}
});

afterEach(async () => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(root, { recursive: true, force: true });
});

async function call(query: ClaudeQuery): Promise<{
	messages: SDKMessage[];
	sent: boolean;
}> {
	const server = await captureServer((req) =>
		req.method === "POST" && req.url.startsWith("/v1/messages")
			? structuredOutputStream("claude-sonnet-5-5", { greeting: "hi" })
			: { status: 404 },
	);
	try {
		const { env } = subscriptionEnv({
			PATH: process.env.PATH,
			HOME: home,
			TMPDIR: tmp,
			CLAUDE_CONFIG_DIR: config,
			...PARENT_SWITCHES,
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
				message: {
					role: "user",
					content: `Profile: ${CANARY}, Berlin. Say hi.`,
				},
				parent_tool_use_id: null,
			} as SDKUserMessage;
		}
		const session = query({ prompt: input(), options });
		void session.initializationResult().then(() => release());
		const messages: SDKMessage[] = [];
		for await (const message of session) {
			messages.push(message);
			if (message.type === "result") break;
		}
		session.close();
		// Give a closing CLI the time to flush anything it would write.
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		const sent = server.requests.some((r) =>
			JSON.stringify(r.body).includes(CANARY),
		);
		return { messages, sent };
	} finally {
		await server.close();
	}
}

/** Every file under `dir` (recursively) that holds the canary; `since` limits to recent files. */
async function filesWithCanary(dir: string, since?: number): Promise<string[]> {
	const found: string[] = [];
	async function walk(path: string, depth: number): Promise<void> {
		if (depth > 12) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(path, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(path, entry.name);
			if (entry.isSymbolicLink() || entry.name === "node_modules") continue;
			if (entry.isDirectory()) {
				await walk(full, depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;
			try {
				const info = await stat(full);
				if (since !== undefined && info.mtimeMs < since) continue;
				if (info.size > 20_000_000) continue;
				if ((await readFile(full)).includes(CANARY)) found.push(full);
			} catch {
				// Unreadable (another user's, or gone): not ours.
			}
		}
	}
	await walk(dir, 0);
	return found;
}

async function canaryOnDisk(): Promise<string[]> {
	const synthetic = await filesWithCanary(root);
	// The machine's temp directories, read only, files changed during this test.
	const shared = new Set<string>();
	for (const dir of [tmpdir(), "/tmp", "/private/tmp"])
		for (const file of await filesWithCanary(dir, started))
			if (
				!file.startsWith(root) &&
				!file.includes(root.replace(/^\/private/, ""))
			)
				shared.add(file);
	return [...synthetic, ...shared];
}

describe("no prompt text on disk", () => {
	it("the provider's query sends the prompt and writes it nowhere, with the SDK's debug switches set in this process", async () => {
		const { messages, sent } = await call(isolatedQuery);
		expect(messages.find((m) => m.type === "result")).toMatchObject({
			subtype: "success",
			structured_output: { greeting: "hi" },
		});
		expect(sent).toBe(true);
		expect(await canaryOnDisk()).toEqual([]);
	}, 120_000);

	it("control: the SDK loaded in this process writes the prompt into a debug log under CLAUDE_CONFIG_DIR", async () => {
		const { sent } = await call(inProcessQuery as unknown as ClaudeQuery);
		expect(sent).toBe(true);
		const files = await filesWithCanary(config);
		expect(files.length).toBeGreaterThan(0);
	}, 120_000);
});

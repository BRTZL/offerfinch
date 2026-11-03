import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { beforeAll, describe, expect, it } from "vitest";

import {
	ALL_LAYERS,
	CODEX_EXPECTED_TOOLS,
	type CodexLayers,
	findCodexBinary,
	runCodexTurn,
} from "../src/codex";
import {
	assistantMessage,
	attacks,
	fakeResponses,
	filesContaining,
	makeCanary,
	type WireJson,
} from "./codex-capture";

/**
 * The tests that fail if a tool ever runs. The installed `codex app-server` runs against a
 * local capture server that answers the first request with a forged tool call reading a canary
 * file in its own temp directory (a stand-in for ~/.ssh/config). A leak is the canary's bytes
 * in any later request: what the model would see. Each defence is proven alone (the others off,
 * Codex's own approval and sandbox at their weakest: `never`, danger-full-access), and the
 * control shows the attack works with none. Nothing reaches OpenAI.
 */
const NONE: CodexLayers = {
	lockdown: false,
	noEnvironments: false,
	sandboxExec: false,
	approvalAndAbort: false,
	ephemeral: true,
};

let binary: string;
beforeAll(async () => {
	const found = await findCodexBinary(process.env.PATH);
	if (!found)
		throw new Error(
			"codex is not on PATH: these boundary tests need the installed CLI",
		);
	binary = found;
});

async function attack(name: string, layers: CodexLayers) {
	const canary = await makeCanary();
	const model = await fakeResponses((_body, index) =>
		index === 0
			? (attacks(canary.path)[name] ?? [])
			: [assistantMessage('{"ok":true}')],
	);
	try {
		const result = await runCodexTurn({
			binary,
			auth: { type: "capture", baseUrl: model.baseUrl },
			system: "Answer with JSON.",
			prompt: "Score this posting.",
			layers,
			approvalPolicy: "never",
			codexSandbox: "danger-full-access",
			timeoutMs: 60_000,
		});
		return {
			result,
			leaked: model.wire().includes(canary.secret),
			posts: model.posts(),
		};
	} finally {
		await model.close();
		await canary.remove();
	}
}

describe("codex-subscription boundary, each layer alone", () => {
	it("control: with no layer the forged command reads the canary (the attack is real)", async () => {
		const { leaked, result } = await attack("exec_command", NONE);
		expect(leaked).toBe(true);
		expect(result.toolAttempt).toMatch(/exec_command|commandExecution/);
	}, 90_000);

	const single: [string, Partial<CodexLayers>][] = [
		["lockdown (feature flags off)", { lockdown: true }],
		["environments: [] (no execution environment)", { noEnvironments: true }],
		["sandbox-exec (home and shared temp unreadable)", { sandboxExec: true }],
		[
			"untrusted approval, client declines and aborts",
			{ approvalAndAbort: true },
		],
	];
	for (const [label, layer] of single)
		for (const name of ["exec_command", "code_mode"])
			it(`${label} alone stops ${name}`, async () => {
				const { leaked, result } = await attack(name, { ...NONE, ...layer });
				expect(leaked).toBe(false);
				expect(result.toolAttempt).not.toBeNull();
			}, 90_000);
});

describe("codex-subscription boundary, production layers", () => {
	for (const name of ["exec_command", "shell", "code_mode", "spawn_agent"])
		it(`declines, aborts and fails the call on a forged ${name}`, async () => {
			const { leaked, result, posts } = await attack(name, ALL_LAYERS);
			expect(leaked).toBe(false);
			expect(result.toolAttempt).toMatch(
				/^raw (function_call|custom_tool_call)/,
			);
			expect(result.status).not.toBe("completed");
			expect(result.boundary).toBeNull();
			// Aborted before Codex could send the tool's output back to the model.
			expect(posts).toHaveLength(1);
		}, 90_000);

	it("offers only the tested, inert tools and loads no instructions or tools of the user's", async () => {
		const model = await fakeResponses(() => [assistantMessage('{"ok":true}')]);
		try {
			const result = await runCodexTurn({
				binary,
				auth: { type: "capture", baseUrl: model.baseUrl },
				system: "SYSTEM-MARK",
				prompt: "PROMPT-MARK",
				outputSchema: {
					type: "object",
					properties: { ok: { type: "boolean" } },
					required: ["ok"],
					additionalProperties: false,
				},
				timeoutMs: 60_000,
			});
			expect(result.status).toBe("completed");
			expect(result.toolAttempt).toBeNull();
			expect(result.boundary).toBeNull();
			expect(result.text).toBe('{"ok":true}');
			const [post] = model.posts();
			const body = post?.body ?? {};
			const input: WireJson[] = body.input ?? [];
			const tools = input
				.filter((i) => i.type === "additional_tools")
				.flatMap((i): WireJson[] => i.tools)
				.flatMap((ns) =>
					(ns.tools as WireJson[]).map((t) => `${ns.name}.${t.name}`),
				);
			expect(tools.every((t: string) => CODEX_EXPECTED_TOOLS.includes(t))).toBe(
				true,
			);
			expect(body.tools ?? []).toEqual([]);
			expect(body.text?.format).toMatchObject({
				type: "json_schema",
				strict: true,
			});
			const developer = JSON.stringify(
				input.filter((i) => i.role === "developer"),
			);
			expect(developer).toContain("SYSTEM-MARK");
			// No AGENTS.md or other instruction file of the user's.
			expect(developer).not.toMatch(
				/AGENTS\.md instructions|<user_instructions>/,
			);
		} finally {
			await model.close();
		}
	}, 90_000);
});

describe("codex-subscription keeps nothing on disk", () => {
	async function run(ephemeral: boolean) {
		const since = Date.now() - 1000;
		const prompt = `PROMPT-${Math.random().toString(36).slice(2)}`;
		const answer = `ANSWER-${Math.random().toString(36).slice(2)}`;
		const model = await fakeResponses(() => [
			assistantMessage(JSON.stringify({ ok: answer })),
		]);
		let inRoot: string[] = [];
		try {
			const result = await runCodexTurn({
				binary,
				auth: { type: "capture", baseUrl: model.baseUrl },
				system: "Answer with JSON.",
				prompt,
				layers: { ...ALL_LAYERS, ephemeral },
				timeoutMs: 60_000,
				beforeCleanup: async (root) => {
					inRoot = (await filesContaining([root], [prompt, answer])).hits;
				},
			});
			expect(result.status).toBe("completed");
			expect(model.wire()).toContain(prompt);
			const elsewhere = await filesContaining(
				[await realpath(tmpdir()), "/private/tmp"],
				[prompt, answer],
				since,
			);
			return { inRoot, elsewhere: elsewhere.hits };
		} finally {
			await model.close();
		}
	}

	it("control: a non-ephemeral thread writes the prompt and answer (the scan finds them)", async () => {
		const { inRoot } = await run(false);
		expect(inRoot.some((f) => f.includes("/sessions/"))).toBe(true);
	}, 90_000);

	it("production: neither the prompt nor the answer reaches any file, in its root or elsewhere", async () => {
		const { inRoot, elsewhere } = await run(true);
		expect(inRoot).toEqual([]);
		expect(elsewhere).toEqual([]);
	}, 90_000);
});

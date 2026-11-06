import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	checkOpenCodeBinary,
	findOpenCodeBinary,
	type OpenCodeCallInput,
	type OpenCodeCallResult,
	OpenCodeProvider,
	runOpenCodeCall,
} from "../src/opencode";
import { CLEANUP_REFUSAL } from "../src/opencode-cleanup";

/**
 * What the model would see on an OpenCode call, read off the wire: the real `opencode` 2.2.5
 * (skipped when the tested build is not installed) runs the production recipe against a fake
 * data home, with the relay forwarding to a local capture server instead of OpenCode's API.
 * Planted around it: plugins, skills, agents, commands, instruction files and config files in
 * the data home and the parent's home. None of it may reach the request, no tool may be offered,
 * one request goes out even when the upstream fails, nothing of the prompt stays in the
 * database, and a stored well-known integration stops the call before anything is sent. Nothing
 * leaves 127.0.0.1, and the user's own data home is never used.
 */

const CANARY = "CANARY_OC_5d1e";
const PROMPT_CANARY = "PROMPT_CANARY_OC_93b0";
const MODEL = "deepseek-v4.1-flash-free";

const binary = findOpenCodeBinary(process.env.PATH);
const root = await mkdtemp(join(tmpdir(), "offerfinch-opencode-boundary-"));
/** Only the tested 2.2.5 build runs these; any other (or none) skips them. */
const tested = binary
	? (await checkOpenCodeBinary({ binary, root: join(root, "private") })).ok
	: false;
let server: Server;
let wellKnown: Server;
let wellKnownHits = 0;
let captureUrl = "";
let answer: "ok" | "fail" = "ok";
const posts: { url: string; body: Record<string, unknown> }[] = [];

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
	return `data: ${JSON.stringify({
		id: "chatcmpl-cap",
		object: "chat.completion.chunk",
		created: 1,
		model: MODEL,
		choices: [{ index: 0, delta, finish_reason: finish }],
	})}\n\n`;
}

async function listen(handler: Server): Promise<string> {
	await new Promise<void>((resolve) =>
		handler.listen(0, "127.0.0.1", () => resolve()),
	);
	const address = handler.address();
	return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

async function plant(path: string, content: string) {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, content);
}

/** A fake data home with canaries wherever a data home could hold config. */
async function plantDataHome(dataHome: string, markers: string) {
	const d = join(dataHome, "opencode");
	const plugin = (tag: string) =>
		`import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(join(markers, `plugin-${tag}`))}, "x");\nexport default { id: "canary-${tag}", server: async () => ({}) };\n`;
	for (const dir of ["plugin", "plugins"])
		await plant(join(d, dir, "canary.js"), plugin(dir));
	for (const dir of ["skill", "skills"])
		await plant(
			join(d, dir, "canary", "SKILL.md"),
			`---\nname: canary\ndescription: ${CANARY} skill\n---\n${CANARY}`,
		);
	for (const dir of ["agent", "agents"])
		await plant(
			join(d, dir, "offerfinch.md"),
			`---\ndescription: ${CANARY}\nmode: primary\n---\n${CANARY} agent`,
		);
	await plant(
		join(d, "command", "canary.md"),
		`---\ndescription: x\n---\n${CANARY}`,
	);
	await plant(join(d, "AGENTS.md"), `${CANARY} data AGENTS.md`);
	for (const name of ["opencode.json", "opencode.jsonc", "config.json"])
		await plant(
			join(d, name),
			JSON.stringify({
				instructions: [join(d, "AGENTS.md")],
				agents: { offerfinch: { system: `${CANARY} config` } },
			}),
		);
}

/** The parent's home: the user's own config, which must stay out (HOME is private). */
async function plantHome(home: string) {
	await plant(join(home, ".config", "opencode", "AGENTS.md"), `${CANARY} cfg`);
	await plant(
		join(home, ".config", "opencode", "opencode.json"),
		JSON.stringify({ instructions: [join(home, "x.md")] }),
	);
	await plant(join(home, "x.md"), `${CANARY} instructions`);
	await plant(join(home, ".claude", "CLAUDE.md"), `${CANARY} claude`);
	await plant(join(home, ".agents", "AGENTS.md"), `${CANARY} agents`);
}

function parentEnv(home: string) {
	return {
		PATH: "/usr/bin:/bin",
		HOME: home,
		USER: process.env.USER,
		XDG_CONFIG_HOME: join(home, ".config"),
		OPENCODE_API_KEY: "sk-parent-must-not-pass",
		OPENCODE_CONFIG: join(home, ".config", "opencode", "opencode.json"),
	};
}

/** Every byte of the data home's files (the database, its WAL, logs), as text. */
function dataHomeText(dataHome: string): string {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else out.push(readFileSync(path).toString("latin1"));
		}
	};
	walk(dataHome);
	return out.join("\n");
}

const schema = z.object({ greeting: z.string() });

async function call(
	dataHome: string,
	home: string,
	text = `${PROMPT_CANARY} Say hi.`,
	extra: Pick<OpenCodeCallInput, "beforeScrub" | "cleanupGraceMs"> = {},
): Promise<OpenCodeCallResult> {
	return runOpenCodeCall({
		...extra,
		binary: binary as string,
		root: join(root, "private"),
		// The marker and intents in a folder of their own, as the desktop keeps them (userData).
		stateDir: join(root, "state"),
		dataHome,
		source: "opencode",
		model: MODEL,
		variant: "low",
		upstream: `${captureUrl}/v1`,
		system: "You extract a greeting.",
		prompt: text,
		schema: z.toJSONSchema(schema) as Record<string, unknown>,
		maxTokens: 1234,
		parentEnv: parentEnv(home),
		timeoutMs: 60_000,
	});
}

let ok: OpenCodeCallResult;
let okPosts: typeof posts;
let fakeData: string;
let fakeHome: string;

beforeAll(async () => {
	if (!tested) return;
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			let body: Record<string, unknown> = {};
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {}
			posts.push({ url: req.url ?? "", body });
			if (answer === "fail") {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "capture 500" } }));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(chunk({ role: "assistant", content: '{"greeting":"hi"}' }));
			res.write(chunk({}, "stop"));
			res.write(
				`data: ${JSON.stringify({ id: "chatcmpl-cap", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [], usage: { prompt_tokens: 120, completion_tokens: 6, total_tokens: 126 } })}\n\n`,
			);
			res.end("data: [DONE]\n\n");
		});
	});
	captureUrl = await listen(server);
	fakeHome = join(root, "home");
	fakeData = join(root, "data");
	await plantHome(fakeHome);
	await plantDataHome(fakeData, join(root, "markers"));
	ok = await call(fakeData, fakeHome);
	okPosts = [...posts];
}, 180_000);

afterAll(async () => {
	await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
	await new Promise<void>((r) =>
		wellKnown ? wellKnown.close(() => r()) : r(),
	);
	await rm(root, { recursive: true, force: true });
});

describe.skipIf(!tested)("an OpenCode call is a pure model call", () => {
	it("answers from exactly one request, through the relay", () => {
		expect(ok.boundary).toBeNull();
		expect(ok.failure).toBeNull();
		expect(ok.sent).toBe(true);
		expect(JSON.parse(ok.text ?? "null")).toEqual({ greeting: "hi" });
		expect(okPosts.length).toBe(1);
		expect(okPosts[0]?.url).toBe("/v1/chat/completions");
		expect(ok.relay?.forwarded).toBe(1);
		expect(ok.tokens?.output).toBeGreaterThan(0);
	});

	it("offers no tool and asks for the JSON schema", () => {
		const body = okPosts[0]?.body ?? {};
		expect((body.tools as unknown[] | undefined)?.length ?? 0).toBe(0);
		expect(JSON.stringify(body.response_format)).toContain("greeting");
		expect(body.reasoning_effort).toBe("low");
	});

	it("asks for no more output than the call reserved", () => {
		const body = okPosts[0]?.body ?? {};
		// OpenCode's own limit for the model is 32,000; ours, from the config, reached the wire.
		expect(body.max_completion_tokens).toBe(1234);
		expect(body.max_tokens).toBeUndefined();
		expect(ok.relay?.limitClamped).toBe(false);
	});

	it("sends none of the user's configuration, only ours", () => {
		const text = JSON.stringify(okPosts[0]?.body);
		expect(text).not.toContain(CANARY);
		expect(text).toContain("You extract a greeting.");
		expect(text).toContain(PROMPT_CANARY);
		expect(existsSync(join(root, "markers"))).toBe(false);
		// The parent's API key never reaches OpenCode.
		expect(JSON.stringify(okPosts[0])).not.toContain("sk-parent-must-not-pass");
	});

	it("leaves nothing of the prompt in the data home", () => {
		expect(ok.scrubError).toBeNull();
		expect(ok.scrub?.rows).toBeGreaterThan(0);
		const db = new Database(join(fakeData, "opencode", "opencode.db"), {
			readonly: true,
		});
		const sessions = db
			.prepare("SELECT count(*) AS n FROM session_v2")
			.get() as {
			n: number;
		};
		db.close();
		expect(sessions.n).toBe(0);
		expect(dataHomeText(fakeData)).not.toContain(PROMPT_CANARY);
	});

	it("sends one request when the upstream fails, and does not retry", async () => {
		posts.length = 0;
		answer = "fail";
		const failed = await call(fakeData, fakeHome);
		answer = "ok";
		expect(posts.length).toBe(1);
		expect(failed.relay?.upstreamStatus).toBe(500);
		expect(failed.relay?.refused).toBe(0);
		expect(failed.failure).not.toBeNull();
		expect(failed.text).toBeNull();
	}, 120_000);

	it("refuses before sending when a stored integration adds configuration", async () => {
		// A stored well-known integration (a `wellknown:sources` entry and its credential, as
		// OpenCode stores one) brings instructions that the lockdown cannot remove.
		wellKnown = createServer((req, res) => {
			wellKnownHits++;
			res.setHeader("content-type", "application/json");
			res.end(
				req.url?.startsWith("/.well-known/opencode")
					? JSON.stringify({
							auth: { command: ["/bin/sh", "-c", "exit 1"], env: "WK_TOKEN" },
							config: { instructions: [join(root, "wk.md")] },
						})
					: "{}",
			);
		});
		const origin = await listen(wellKnown);
		await plant(join(root, "wk.md"), `${CANARY} well-known`);
		const db = new Database(join(fakeData, "opencode", "opencode.db"));
		db.prepare("INSERT INTO kv VALUES (?, ?, 1, 1)").run(
			"wellknown:sources",
			JSON.stringify([origin]),
		);
		db.prepare(
			"INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES ('cred_wk', ?, 'API key', ?, 1, 1, 1)",
		).run(origin, JSON.stringify({ type: "key", key: "t" }));
		db.close();
		posts.length = 0;
		const refused = await call(fakeData, fakeHome);
		expect(wellKnownHits).toBeGreaterThan(0);
		expect(refused.boundary).toMatch(/configuration/);
		expect(refused.sent).toBe(false);
		expect(posts.length).toBe(0);
		const undo = new Database(join(fakeData, "opencode", "opencode.db"));
		undo.prepare("DELETE FROM kv WHERE key LIKE 'wellknown:%'").run();
		undo.prepare("DELETE FROM credential WHERE id = 'cred_wk'").run();
		undo.close();
	}, 120_000);

	it("answers through the provider, parsed against the schema", async () => {
		const provider = new OpenCodeProvider({
			source: "opencode",
			model: MODEL,
			effort: "high",
			ownerUserId: "u1",
			root: join(root, "private"),
			dataHome: fakeData,
			binary: binary as string,
			parentEnv: parentEnv(fakeHome),
			upstream: `${captureUrl}/v1`,
			credentials: () => [],
			entry: () => ({
				source: "opencode",
				model: MODEL,
				name: "DeepSeek",
				billing: "subscription",
				variants: ["low", "high", "max"],
				price: null,
				baseURL: "https://opencode.ai/inference/openai/v1",
				unavailable: null,
			}),
		});
		let sent = 0;
		let usage = 0;
		posts.length = 0;
		const out = await provider.generateObject({
			task: "boundary",
			system: "You extract a greeting.",
			prompt: "Say hi.",
			maxTokens: 777,
			schema,
			onModelCall: () => sent++,
			onUsage: (u) => {
				usage = u.inputTokens + u.outputTokens;
			},
		});
		expect(out).toEqual({ greeting: "hi" });
		expect(posts.map((p) => p.body.max_completion_tokens)).toEqual([777]);
		expect(sent).toBe(1);
		expect(usage).toBeGreaterThan(0);
		expect(provider.billing).toBe("subscription");
		expect(provider.vendor).toBe("opencode:opencode");
	}, 120_000);

	it("keeps the cleanup pending while another connection reads OpenCode's database, refuses calls past the grace period, and finishes once it closes", async () => {
		const dbFile = join(fakeData, "opencode", "opencode.db");
		let reader: Database.Database | null = null;
		let intentsDuringCall: string[] = [];
		const state = () => readdirSync(join(root, "state"));
		const held = await call(fakeData, fakeHome, undefined, {
			// Like the user's own OpenCode holding a read transaction during the scrub.
			beforeScrub: async () => {
				intentsDuringCall = state().filter((f) =>
					f.startsWith("cleanup-intent-"),
				);
				reader = new Database(dbFile, { readonly: true });
				reader.prepare("BEGIN").run();
				reader.prepare("SELECT count(*) FROM session_v2").get();
			},
		});
		expect(held.failure).toBeNull();
		expect(held.scrub?.rows).toBeGreaterThan(0);
		expect(held.scrub?.clean).toBe(false);
		expect(held.cleanupPending).toBe(true);
		// The call's intent was on disk while it ran; after it, the marker holds the debt.
		expect(intentsDuringCall).toHaveLength(1);
		expect(state().filter((f) => f.startsWith("cleanup-intent-"))).toEqual([]);
		expect(state().some((f) => f.startsWith("cleanup-pending-"))).toBe(true);
		expect(
			readdirSync(join(root, "private")).some((f) => f.startsWith("cleanup-")),
		).toBe(false);
		// The rows are gone, the prompt is not: this is what the marker is for.
		expect(dataHomeText(fakeData)).toContain(PROMPT_CANARY);

		posts.length = 0;
		const refused = await call(fakeData, fakeHome, undefined, {
			cleanupGraceMs: 0,
		});
		expect(refused.cleanupRefused).toBe(true);
		expect(refused.boundary).toBe(CLEANUP_REFUSAL);
		expect(refused.sent).toBe(false);
		expect(posts.length).toBe(0);

		(reader as Database.Database | null)?.close();
		const resumed = await call(fakeData, fakeHome, undefined, {
			cleanupGraceMs: 0,
		});
		expect(resumed.cleanupRefused).toBe(false);
		expect(resumed.failure).toBeNull();
		expect(resumed.scrub?.clean).toBe(true);
		expect(resumed.cleanupPending).toBe(false);
		expect(state().filter((f) => f.startsWith("cleanup-"))).toEqual([]);
		expect(posts.length).toBe(1);
		expect(dataHomeText(fakeData)).not.toContain(PROMPT_CANARY);
	}, 180_000);

	it("never uses the user's real data home", () => {
		const real = join(homedir(), ".local", "share");
		expect(fakeData ?? "").not.toBe(real);
	});
});

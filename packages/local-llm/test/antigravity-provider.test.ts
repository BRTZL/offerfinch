import { existsSync, readdirSync, statSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SubscriptionUnavailableError } from "@offerfinch/core/scoring/llm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	AntigravityProvider,
	AntigravityToolAttemptError,
	antigravityTokenFile,
	probeAntigravity,
	signInAntigravity,
} from "../src/antigravity";
import type { AntigravityInstall } from "../src/antigravity-release";
import { Breaker } from "../src/breaker";

/**
 * The provider against a stand-in ACP server (test/fixtures/fake-agy.mjs) and a stand-in for
 * Google's endpoint behind the gate: the session's rules (no tools, cancelled permissions,
 * refused client requests, one model request), effort mapping, error mapping and parsing.
 */

const FIXTURE = resolve(__dirname, "fixtures", "fake-agy.mjs");
const posix = process.platform !== "win32";

let dir: string;
let tokenFile: string;
let upstream: Server;
let upstreamUrl: string;
let requests: { method: string; body: Record<string, unknown> }[] = [];
let reply: (method: string, n: number) => { status: number; body: string };

const sse = (parts: unknown[], usage = true) =>
	`data: ${JSON.stringify({
		response: {
			candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
			...(usage
				? {
						usageMetadata: {
							promptTokenCount: 3873,
							candidatesTokenCount: 53,
							thoughtsTokenCount: 659,
							cachedContentTokenCount: 100,
						},
					}
				: {}),
			modelVersion: "gemini-3.8-flash-n",
		},
	})}\r\n\r\n`;
const answer = (text: string) => ({ status: 200, body: sse([{ text }]) });

async function runtime(scenario: string): Promise<AntigravityInstall> {
	const server = join(dir, `agy-${scenario}.sh`);
	await writeFile(
		server,
		`#!/bin/sh\nexec '${process.execPath}' '${FIXTURE}' ${scenario}\n`,
	);
	await chmod(server, 0o755);
	return { server, harness: "/nonexistent/harness", version: "1.4.1" };
}

function provider(
	scenario: string,
	options: Partial<ConstructorParameters<typeof AntigravityProvider>[0]> = {},
) {
	return new AntigravityProvider({
		model: "gemini-3.8-flash",
		effort: "low",
		ownerUserId: "u1",
		runtime: () => runtime(scenario),
		tokenFile,
		upstream: upstreamUrl,
		breaker: new Breaker(),
		timeoutMs: 20_000,
		parentEnv: {
			PATH: "/usr/bin:/bin",
			HOME: "/Users/someone",
			USER: "someone",
			LANG: "en_US.UTF-8",
			GOOGLE_API_KEY: "should-not-pass",
			GEMINI_API_KEY: "should-not-pass",
			NODE_OPTIONS: "--inspect",
		},
		...options,
	});
}

const schema = z.object({ ok: z.boolean() });
const request = (extra: Record<string, unknown> = {}) => ({
	system: "You check things.",
	prompt: "Is it fine?",
	schema,
	task: "test",
	...extra,
});

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "offerfinch-agy-provider-test-"));
	tokenFile = antigravityTokenFile(join(dir, "gemini-home"));
	await mkdir(join(dir, "gemini-home", "antigravity-acp"), { recursive: true });
	await writeFile(tokenFile, '{"refresh_token":"test-token"}');
	upstream = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			const method = /:(\w+)/.exec(req.url ?? "")?.[1] ?? "";
			requests.push({ method, body: JSON.parse(body || "{}") });
			const n = requests.filter((r) => r.method === method).length;
			const out =
				method === "fetchAvailableModels"
					? { status: 200, body: '{"models":{}}' }
					: reply(method, n);
			res.writeHead(out.status, {
				"content-type":
					out.status === 200 ? "text/event-stream" : "application/json",
			});
			res.end(out.body);
		});
	});
	await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
	upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(async () => {
	upstream.closeAllConnections();
	await new Promise((r) => upstream.close(r));
	await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
	requests = [];
	reply = () => answer('{"ok":true}');
});

const generates = () =>
	requests.filter((r) => r.method === "streamGenerateContent");

describe.skipIf(!posix)("AntigravityProvider", () => {
	it("makes one locked-down model request and returns the parsed answer", async () => {
		const calls: string[] = [];
		const usage: unknown[] = [];
		let seen: { root: string; info: Record<string, unknown> } | null = null;
		const result = await provider("ok", {
			inspectRoot: async (callRoot) => {
				const info = JSON.parse(
					await readFile(join(callRoot, "tmp", "fake-agy.json"), "utf8"),
				);
				const token = join(callRoot, "gh", "antigravity-acp", "acp_token.json");
				expect(statSync(token).mode & 0o777).toBe(0o600);
				expect(statSync(callRoot).mode & 0o777).toBe(0o700);
				expect(readdirSync(join(callRoot, "cwd"))).toEqual([]);
				seen = { root: callRoot, info };
			},
		}).generateObject({
			...request(),
			onModelCall: () => calls.push("sent"),
			onUsage: (u) => usage.push(u),
		});
		expect(result).toEqual({ ok: true });
		expect(calls).toEqual(["sent"]);
		expect(usage).toEqual([
			{
				model: "gemini-3.8-flash-n",
				inputTokens: 3773,
				outputTokens: 712,
				cachedInputTokens: 100,
				cacheWriteTokens: 0,
			},
		]);
		expect(generates()).toHaveLength(1);
		expect(generates()[0]?.body.model).toBe("gemini-3.8-flash-low");
		const { root, info } = seen as unknown as {
			root: string;
			info: { env: Record<string, string>; cwd: string };
		};
		expect(existsSync(root)).toBe(false);
		expect(info.env.HOME).toBe(join(root, "home"));
		expect(info.env.GEMINI_HOME).toBe(join(root, "gh"));
		expect(info.env.AGY_ACP_FORCE_FILE_STORAGE).toBe("1");
		expect(info.env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
		expect(info.env.AGY_ACP_CCPA_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);
		for (const key of ["GOOGLE_API_KEY", "GEMINI_API_KEY", "NODE_OPTIONS"])
			expect(info.env[key]).toBeUndefined();
		expect(info.cwd).toMatch(/cwd$/);
	});

	it("maps effort to thinking_level: xhigh and max are high, unset is high", async () => {
		for (const [effort, slug] of [
			["medium", "gemini-3.8-flash-medium"],
			["xhigh", "gemini-3.8-flash-high"],
			["max", "gemini-3.8-flash-high"],
			[undefined, "gemini-3.8-flash-high"],
		] as const) {
			requests = [];
			await provider("ok", { effort }).generateObject(request());
			expect(generates()[0]?.body.model).toBe(slug);
		}
		requests = [];
		await provider("ok", { model: "gpt-oss-120b-medium" }).generateObject(
			request(),
		);
		expect(generates()[0]?.body.model).toBe("gpt-oss-120b-medium");
	});

	it("strips code fences from the answer", async () => {
		reply = () => answer('```json\n{"ok":false}\n```');
		expect(await provider("ok").generateObject(request())).toEqual({
			ok: false,
		});
	});

	it("treats an unparseable or off-schema answer as a failed call, not a pause", async () => {
		reply = () => answer("I cannot help with that.");
		const usage: unknown[] = [];
		const error = await provider("ok")
			.generateObject({ ...request(), onUsage: (u) => usage.push(u) })
			.catch((e) => e);
		expect(error).not.toBeInstanceOf(SubscriptionUnavailableError);
		expect(String(error)).toMatch(/no valid structured output/);
		expect(usage).toHaveLength(1);
		reply = () => answer('{"ok":"yes"}');
		const off = await provider("ok")
			.generateObject(request())
			.catch((e) => e);
		expect(off).toBeInstanceOf(z.ZodError);
	});

	for (const [scenario, why] of [
		["tool-call", /tool call/],
		["permission", /permission/],
		["fs", /fs\/read_text_file/],
		["old-version", /version 1\.3\.0/],
		["tools", /tools offered/],
	] as const)
		it(`pauses as a boundary failure on ${scenario}`, async () => {
			const error = await provider(scenario)
				.generateObject(request())
				.catch((e) => e);
			expect(error).toBeInstanceOf(SubscriptionUnavailableError);
			expect(error.kind).toBe("boundary");
			expect(String(error)).toMatch(why);
			if (scenario === "tools") expect(generates()).toHaveLength(0);
		});

	it("lets one model request through: an injected tool call fails the call without a second request", async () => {
		reply = (_m, n) =>
			n === 1
				? {
						status: 200,
						body: sse([
							{
								functionCall: {
									name: "run_command",
									args: { CommandLine: "touch /tmp/x" },
								},
							},
						]),
					}
				: answer('{"ok":true}');
		const calls: string[] = [];
		const error = await provider("ok")
			.generateObject({ ...request(), onModelCall: () => calls.push("sent") })
			.catch((e) => e);
		expect(error).toBeInstanceOf(AntigravityToolAttemptError);
		expect(String(error)).toMatch(/run_command/);
		expect(generates()).toHaveLength(1);
		expect(calls).toEqual(["sent"]);
	});

	it("maps Google's quota answer to a usage-limit pause with its reset time, and holds the next call", async () => {
		reply = () => ({
			status: 429,
			body: JSON.stringify({
				error: {
					code: 429,
					message:
						"You have exhausted your capacity on this model. Your quota will reset after 4h12m.",
					status: "RESOURCE_EXHAUSTED",
					details: [
						{
							"@type": "type.googleapis.com/google.rpc.ErrorInfo",
							reason: "QUOTA_EXHAUSTED",
							metadata: { quotaResetTimeStamp: "2099-11-05T19:30:15Z" },
						},
					],
				},
			}),
		});
		const breaker = new Breaker();
		const p = provider("quota", { breaker });
		const error = await p.generateObject(request()).catch((e) => e);
		expect(error).toBeInstanceOf(SubscriptionUnavailableError);
		expect(error.kind).toBe("usage_limit");
		expect(error.resetsAt?.toISOString()).toBe("2099-11-05T19:30:15.000Z");
		requests = [];
		const again = await p.generateObject(request()).catch((e) => e);
		expect(again).toBe(error);
		expect(requests).toHaveLength(0);
	});

	it("maps a refused login to logged_out and a capacity 429 or a 500 to a plain error", async () => {
		reply = () => ({
			status: 401,
			body: '{"error":{"code":401,"message":"Request had invalid authentication credentials.","status":"UNAUTHENTICATED"}}',
		});
		const out = await provider("ok")
			.generateObject(request())
			.catch((e) => e);
		expect(out.kind).toBe("logged_out");
		for (const body of [
			'{"error":{"code":429,"message":"No capacity available for model gemini-3.8-flash-low on the server","status":"RESOURCE_EXHAUSTED","details":[{"reason":"MODEL_CAPACITY_EXHAUSTED"}]}}',
			'{"error":{"code":500,"message":"Internal error encountered.","status":"INTERNAL"}}',
		]) {
			reply = () => ({ status: JSON.parse(body).error.code, body });
			const e = await provider("ok")
				.generateObject(request())
				.catch((x) => x);
			expect(e).not.toBeInstanceOf(SubscriptionUnavailableError);
			expect(String(e)).toMatch(/Google answered (429|500)/);
		}
	});

	it("pauses as logged out when the server wants a browser sign-in, without waiting", async () => {
		const started = Date.now();
		const error = await provider("logged-out")
			.generateObject(request())
			.catch((e) => e);
		expect(error.kind).toBe("logged_out");
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(generates()).toHaveLength(0);
	});

	it("pauses before starting anything when not installed, not signed in, or on Windows", async () => {
		const missing = await provider("ok", { runtime: async () => null })
			.generateObject(request())
			.catch((e) => e);
		expect(missing.kind).toBe("logged_out");
		const noToken = await provider("ok", { tokenFile: join(dir, "nope.json") })
			.generateObject(request())
			.catch((e) => e);
		expect(noToken.kind).toBe("logged_out");
		const windows = await provider("ok", { platform: "win32" })
			.generateObject(request())
			.catch((e) => e);
		expect(windows.kind).toBe("boundary");
		expect(requests).toHaveLength(0);
	});
});

describe.skipIf(!posix)("Antigravity sign-in and model list", () => {
	it("lists the families with their thinking levels", async () => {
		const probe = await probeAntigravity({
			runtime: await runtime("list"),
			tokenFile,
			upstream: upstreamUrl,
		});
		expect(probe.login).toBe("logged_in");
		expect(probe.detail).toMatch(/Google AI Pro/);
		expect(probe.families).toEqual([
			{
				id: "gemini-4-argon",
				name: "Gemini 4 Argon",
				levels: ["low", "medium", "high"],
			},
			{
				id: "gemini-3.8-flash",
				name: "Gemini 3.8 Flash",
				levels: ["low", "medium", "high"],
			},
			{ id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", levels: [] },
		]);
		expect(requests.map((r) => r.method)).toEqual(["fetchAvailableModels"]);
		const out = await probeAntigravity({
			runtime: await runtime("logged-out"),
			tokenFile,
			upstream: upstreamUrl,
		});
		expect(out.login).toBe("logged_out");
	});

	it("signs in: hands Google's page over and keeps only the token and the auth settings", async () => {
		const home = join(dir, "signin-home");
		const urls: string[] = [];
		await signInAntigravity({
			runtime: await runtime("sign-in"),
			geminiHome: home,
			onUrl: (url) => urls.push(url),
			timeoutMs: 20_000,
		});
		expect(urls).toHaveLength(1);
		expect(urls[0]).toMatch(/^https:\/\/accounts\.google\.com\//);
		expect(readdirSync(join(home, "antigravity-acp")).sort()).toEqual([
			"acp_token.json",
			"settings.json",
		]);
		expect(statSync(antigravityTokenFile(home)).mode & 0o777).toBe(0o600);
	});

	it("refuses a sign-in page that is not Google's", async () => {
		const urls: string[] = [];
		await expect(
			signInAntigravity({
				runtime: await runtime("sign-in-bad-url"),
				geminiHome: join(dir, "bad-home"),
				onUrl: (url) => urls.push(url),
				timeoutMs: 20_000,
			}),
		).rejects.toThrow(/unexpected sign-in page/);
		expect(urls).toEqual([]);
		expect(existsSync(join(dir, "bad-home"))).toBe(false);
	});
});

import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubscriptionUnavailableError } from "@offerfinch/core/scoring/llm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	AntigravityProvider,
	antigravityPrompt,
	errorPause,
	familiesOf,
	isSignInUrl,
	parseJsonAnswer,
	resumeAntigravityCalls,
	sweepAntigravityRoots,
	thinkingLevel,
	wireModel,
} from "../src/antigravity";
import {
	generateViolation,
	readAnswer,
	readError,
	startGate,
} from "../src/antigravity-gate";
import {
	ANTIGRAVITY_RELEASE,
	type AntigravityAsset,
	antigravityAsset,
	findAntigravity,
	installAntigravity,
} from "../src/antigravity-release";

describe("the pinned release", () => {
	it("has all six platforms with full hashes and Google's URLs", () => {
		expect(ANTIGRAVITY_RELEASE.map((a) => a.key).sort()).toEqual([
			"darwin-arm64",
			"darwin-x64",
			"linux-arm64",
			"linux-x64",
			"win32-arm64",
			"win32-x64",
		]);
		for (const a of ANTIGRAVITY_RELEASE) {
			expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(a.url).toMatch(
				/^https:\/\/dl\.google\.com\/agy-extensions\/releases\/(macos|linux|windows)\/agy-acp-server-1\.4\.1-/,
			);
		}
		expect(antigravityAsset("darwin", "arm64")?.archiveBytes).toBe(112737434);
		expect(antigravityAsset("win32", "x64")?.executable.name).toBe(
			"agy_acp_server.exe",
		);
		expect(antigravityAsset("freebsd", "x64")).toBeNull();
	});
});

describe("installAntigravity", () => {
	/** Windows reports no exec bit, so the found-again check follows the host. */
	const host = process.platform === "win32" ? "win32" : "darwin";
	let root: string;
	const server = Buffer.from("server-bytes");
	const harness = Buffer.from("harness-bytes!");
	const archive = Buffer.from("pretend this is the zip");
	const asset = (over: Partial<AntigravityAsset> = {}): AntigravityAsset => ({
		key: "darwin-arm64",
		url: "https://dl.google.com/agy-extensions/releases/macos/test.zip",
		sha256: createHash("sha256").update(archive).digest("hex"),
		archiveBytes: archive.length,
		executable: { name: "agy_acp_server.par", bytes: server.length },
		harness: { name: "localharness_external", bytes: harness.length },
		...over,
	});
	const fetchOf = (bytes: Buffer) =>
		(async () => new Response(bytes)) as unknown as typeof fetch;
	const extract =
		(
			files: Record<string, Buffer> = {
				"agy_acp_server.par": server,
				localharness_external: harness,
			},
		) =>
		async (_zip: string, dir: string) => {
			for (const [name, bytes] of Object.entries(files))
				await writeFile(join(dir, name), bytes, { mode: 0o644 });
		};

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "offerfinch-test-agy-install-"));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("installs a matching archive, marks both files executable and finds it again", async () => {
		const got = await installAntigravity({
			root,
			platform: host,
			arch: "arm64",
			asset: asset(),
			fetch: fetchOf(archive),
			extract: extract(),
		});
		expect(got.version).toBe("1.4.1");
		if (process.platform !== "win32") {
			expect(statSync(got.server).mode & 0o777).toBe(0o755);
			expect(statSync(got.harness).mode & 0o777).toBe(0o755);
		}
		expect(await findAntigravity(root, host, "arm64", asset())).toEqual(got);
		// Only the install folder is left: no download, no staging.
		expect(readdirSync(root)).toEqual(["1.4.1-darwin-arm64"]);
		// Not the pinned release's hash: never taken for the real one.
		expect(await findAntigravity(root, host, "arm64")).toBeNull();
	});

	for (const [label, bytes, over] of [
		["a different hash", Buffer.from("pretend this is the zap"), {}],
		["a short archive", archive.subarray(1), {}],
		["a longer archive", Buffer.concat([archive, Buffer.from("x")]), {}],
	] as const)
		it(`refuses ${label} before unpacking, leaving nothing`, async () => {
			let unpacked = false;
			await expect(
				installAntigravity({
					root,
					platform: "darwin",
					arch: "arm64",
					asset: asset(over),
					fetch: fetchOf(bytes as Buffer),
					extract: async () => {
						unpacked = true;
					},
				}),
			).rejects.toThrow(/pinned/);
			expect(unpacked).toBe(false);
			expect(readdirSync(root)).toEqual([]);
		});

	it("refuses an archive with other files or other sizes", async () => {
		await expect(
			installAntigravity({
				root,
				platform: "darwin",
				arch: "arm64",
				asset: asset(),
				fetch: fetchOf(archive),
				extract: extract({
					"agy_acp_server.par": server,
					localharness_external: harness,
					"extra.sh": Buffer.from("x"),
				}),
			}),
		).rejects.toThrow(/expected files/);
		await expect(
			installAntigravity({
				root,
				platform: "darwin",
				arch: "arm64",
				asset: asset(),
				fetch: fetchOf(archive),
				extract: extract({
					"agy_acp_server.par": Buffer.from("other"),
					localharness_external: harness,
				}),
			}),
		).rejects.toThrow(/not the pinned file/);
		expect(readdirSync(root)).toEqual([]);
	});

	it("refuses a failed download and a platform Google does not publish", async () => {
		await expect(
			installAntigravity({
				root,
				asset: asset(),
				fetch: (async () =>
					new Response("no", { status: 404 })) as unknown as typeof fetch,
				extract: extract(),
			}),
		).rejects.toThrow(/HTTP 404/);
		await expect(
			installAntigravity({
				root,
				platform: "freebsd",
				arch: "x64",
				extract: extract(),
			}),
		).rejects.toThrow(/publishes no Antigravity/);
		expect(existsSync(join(root, "1.4.1-darwin-arm64"))).toBe(false);
	});
});

describe("the gate", () => {
	const ok = { model: "gemini-3.8-flash-low" };
	const body = (over: Record<string, unknown> = {}) => ({
		model: "gemini-3.8-flash-low",
		request: {
			contents: [{ role: "user", parts: [{ text: "hi" }] }],
			toolConfig: { functionCallingConfig: { mode: "AUTO" } },
			...over,
		},
	});

	it("checks the one model request", () => {
		expect(generateViolation(body(), ok.model)).toBeNull();
		expect(generateViolation(body({ tools: [] }), ok.model)).toMatch(/tools/);
		expect(generateViolation(body(), "gemini-4-argon-low")).toMatch(
			/not gemini-4-argon-low/,
		);
		expect(
			generateViolation(
				body({ contents: [{ parts: [] }, { parts: [] }, { parts: [] }] }),
				ok.model,
			),
		).toMatch(/more than the one prompt/);
		expect(generateViolation(body(), null)).toMatch(/none may be sent/);
		expect(generateViolation("x", ok.model)).toMatch(/unreadable/);
	});

	it("reads tokens, the model and function calls from a streamed answer", () => {
		const line = (o: unknown) => `data: ${JSON.stringify(o)}`;
		const text = [
			line({
				response: { candidates: [{ content: { parts: [{ text: "{" }] } }] },
			}),
			line({
				response: {
					candidates: [
						{ content: { parts: [{ functionCall: { name: "view_file" } }] } },
					],
					usageMetadata: {
						promptTokenCount: 10,
						candidatesTokenCount: 2,
						thoughtsTokenCount: 3,
					},
					modelVersion: "gemini-3.8-flash-n",
				},
			}),
		].join("\n\n");
		expect(readAnswer(text)).toEqual({
			usage: {
				promptTokens: 10,
				outputTokens: 2,
				thoughtTokens: 3,
				cachedTokens: 0,
			},
			modelVersion: "gemini-3.8-flash-n",
			functionCalls: ["view_file"],
		});
	});

	it("reads Google's error body", () => {
		expect(
			readError(
				429,
				JSON.stringify({
					error: {
						message: "quota",
						details: [
							{
								reason: "QUOTA_EXHAUSTED",
								metadata: { quotaResetTimeStamp: "2026-11-05T19:30:15Z" },
							},
						],
					},
				}),
			),
		).toEqual({
			status: 429,
			message: "quota",
			reason: "QUOTA_EXHAUSTED",
			resetsAt: new Date("2026-11-05T19:30:15Z"),
		});
		expect(readError(502, "<html>")).toMatchObject({
			status: 502,
			reason: null,
		});
	});

	it("forwards the model list and one model request, and refuses the rest", async () => {
		const seen: {
			url: string;
			headers: Record<string, string>;
			body: string;
		}[] = [];
		const fakeFetch = (async (url: string, init: RequestInit) => {
			seen.push({
				url,
				headers: init.headers as Record<string, string>,
				body: String(init.body),
			});
			return new Response(
				url.includes("fetchAvailableModels")
					? "{}"
					: `data: ${JSON.stringify({ response: { usageMetadata: { promptTokenCount: 5 } } })}\n\n`,
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as unknown as typeof fetch;
		let forwards = 0;
		const gate = await startGate({
			upstream: "https://upstream.test",
			fetch: fakeFetch,
			onForward: () => forwards++,
		});
		const post = (method: string, payload: unknown, headers = {}) =>
			fetch(`${gate.url}/v1internal:${method}?alt=sse`, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: JSON.stringify(payload),
			});
		try {
			expect((await post("fetchAvailableModels", {})).status).toBe(200);
			// No model is known yet: nothing may go through.
			expect((await post("streamGenerateContent", body())).status).toBe(400);
			expect(gate.record.violation).toMatch(/none may be sent/);
		} finally {
			await gate.close();
		}

		const gate2 = await startGate({
			upstream: "https://upstream.test",
			fetch: fakeFetch,
			onForward: () => forwards++,
		});
		gate2.expect("gemini-3.8-flash-low");
		const post2 = (method: string, payload: unknown) =>
			fetch(`${gate2.url}/v1internal:${method}?alt=sse`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer t",
					cookie: "c=1",
					"x-goog-api-client": "x",
				},
				body: JSON.stringify(payload),
			});
		try {
			seen.length = 0;
			const first = await post2("streamGenerateContent", body());
			expect(first.status).toBe(200);
			await first.text();
			expect((await post2("streamGenerateContent", body())).status).toBe(400);
			expect((await post2("loadCodeAssist", {})).status).toBe(403);
			expect((await post2("onboardUser", {})).status).toBe(403);
			expect(forwards).toBe(1);
			expect(seen).toHaveLength(1);
			expect(seen[0]?.url).toBe(
				"https://upstream.test/v1internal:streamGenerateContent?alt=sse",
			);
			expect(Object.keys(seen[0]?.headers ?? {}).sort()).toEqual([
				"authorization",
				"content-type",
				"user-agent",
				"x-goog-api-client",
			]);
			expect(gate2.record).toMatchObject({
				forwarded: true,
				violation: null,
				status: 200,
				refused: ["streamGenerateContent", "loadCodeAssist", "onboardUser"],
				usage: { promptTokens: 5 },
			});
		} finally {
			await gate2.close();
		}
	});
});

describe("the call's parts", () => {
	it("maps effort to Google's thinking levels", () => {
		expect(thinkingLevel("low")).toBe("low");
		expect(thinkingLevel("medium")).toBe("medium");
		expect(thinkingLevel("high")).toBe("high");
		expect(thinkingLevel("xhigh")).toBe("high");
		expect(thinkingLevel("max")).toBe("high");
		expect(thinkingLevel(undefined)).toBe("high");
		expect(
			wireModel({ id: "gemini-4-argon", name: "", levels: ["low"] }, "low"),
		).toBe("gemini-4-argon-low");
		expect(
			wireModel({ id: "gpt-oss-120b-medium", name: "", levels: [] }, "low"),
		).toBe("gpt-oss-120b-medium");
	});

	it("reads the families from session/new", () => {
		expect(
			familiesOf({
				configOptions: [
					{
						id: "model",
						options: [
							{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
							{ value: "gpt-oss-120b-medium" },
						],
					},
				],
				models: {
					availableModels: [
						{ modelId: "gemini-3.8-flash-low" },
						{ modelId: "gemini-3.8-flash-high" },
						{ modelId: "gpt-oss-120b-medium" },
					],
				},
			}),
		).toEqual([
			{
				id: "gemini-3.8-flash",
				name: "Gemini 3.8 Flash",
				levels: ["low", "high"],
			},
			{ id: "gpt-oss-120b-medium", name: "gpt-oss-120b-medium", levels: [] },
		]);
		expect(familiesOf(null)).toEqual([]);
	});

	it("parses fenced, bare and wrapped JSON answers, and refuses prose", () => {
		expect(parseJsonAnswer('{"a":1}')).toEqual({ a: 1 });
		expect(parseJsonAnswer('```json\n{"a":1}\n```')).toEqual({ a: 1 });
		expect(parseJsonAnswer('```\n{"a":1}\n```\n')).toEqual({ a: 1 });
		expect(parseJsonAnswer('Here it is: {"a":{"b":2}} done')).toEqual({
			a: { b: 2 },
		});
		expect(() => parseJsonAnswer("Usage Limit Reached")).toThrow();
	});

	it("puts the system text, the schema and the prompt in one message", () => {
		const text = antigravityPrompt({
			system: "SYSTEM",
			promptPrefix: "PREFIX",
			prompt: "PROMPT",
			schema: z.object({ ok: z.boolean() }),
			task: "t",
		});
		expect(text.indexOf("SYSTEM")).toBeLessThan(text.indexOf('"ok"'));
		expect(text.indexOf('"ok"')).toBeLessThan(text.indexOf("PREFIX"));
		expect(text.indexOf("PREFIX")).toBeLessThan(text.indexOf("PROMPT"));
		expect(text).not.toContain("$schema");
		const slash = antigravityPrompt({
			system: "/logout",
			prompt: "",
			schema: z.object({}),
			task: "t",
		});
		expect(slash.startsWith("/")).toBe(false);
	});

	it("maps errors from the gate first, then from the answer text", () => {
		const now = new Date("2026-11-06T00:00:00Z");
		const at = new Date("2026-11-06T04:12:00Z");
		expect(
			errorPause(
				{
					forwarded: true,
					error: {
						status: 429,
						message: "x",
						reason: "QUOTA_EXHAUSTED",
						resetsAt: at,
					},
				},
				"",
				now,
			),
		).toMatchObject({ kind: "usage_limit", resetsAt: at });
		expect(
			errorPause(
				{
					forwarded: true,
					error: {
						status: 429,
						message: "No capacity available",
						reason: "MODEL_CAPACITY_EXHAUSTED",
						resetsAt: null,
					},
				},
				"",
				now,
			),
		).toBeNull();
		expect(
			errorPause(
				{
					forwarded: true,
					error: { status: 401, message: "", reason: null, resetsAt: null },
				},
				"",
				now,
			)?.kind,
		).toBe("logged_out");
		const text = errorPause(
			{ forwarded: false, error: null },
			"Usage Limit Reached\n\nYour limit will reset in 4 hours, 12 minutes.",
			now,
		);
		expect(text?.kind).toBe("usage_limit");
		expect(text?.resetsAt?.toISOString()).toBe("2026-11-06T04:12:00.000Z");
		expect(
			errorPause(
				{ forwarded: false, error: null },
				"Request had invalid authentication credentials.",
				now,
			)?.kind,
		).toBe("logged_out");
		expect(
			errorPause({ forwarded: true, error: null }, "quota", now),
		).toBeNull();
		expect(errorPause({ forwarded: false, error: null }, "{}", now)).toBeNull();
	});

	it("opens only Google's sign-in page returning to a loopback port", () => {
		const back = "redirect_uri=http%3A%2F%2F127.0.0.1%3A5555%2F";
		expect(
			isSignInUrl(`https://accounts.google.com/o/oauth2/v2/auth?${back}`),
		).toBe(true);
		expect(
			isSignInUrl(`http://accounts.google.com/o/oauth2/v2/auth?${back}`),
		).toBe(false);
		expect(isSignInUrl(`https://accounts.google.com.evil.test/?${back}`)).toBe(
			false,
		);
		expect(
			isSignInUrl(
				"https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fevil.test%2F",
			),
		).toBe(false);
		expect(isSignInUrl("not a url")).toBe(false);
	});
});

describe("process-wide state", () => {
	it("sweeps only call folders a crash left, never other folders or fresh calls", async () => {
		const old = await mkdtemp(join(tmpdir(), "offerfinch-agy-call-"));
		const fresh = await mkdtemp(join(tmpdir(), "offerfinch-agy-call-"));
		const other = await mkdtemp(join(tmpdir(), "offerfinch-agy-callx-"));
		const past = new Date(Date.now() - 3_600_000);
		await utimes(old, past, past);
		await utimes(other, past, past);
		try {
			await sweepAntigravityRoots();
			expect(existsSync(old)).toBe(false);
			expect(existsSync(fresh)).toBe(true);
			expect(existsSync(other)).toBe(true);
		} finally {
			for (const dir of [old, fresh, other])
				await rm(dir, { recursive: true, force: true });
		}
	});

	it("lifts the not-signed-in pause after an install or sign-in, and no other", async () => {
		const provider = new AntigravityProvider({
			model: "gemini-3.8-flash",
			ownerUserId: "u1",
			runtime: async () => null,
			tokenFile: "/nonexistent",
			platform: "darwin",
		});
		const request = {
			system: "s",
			prompt: "p",
			schema: z.object({}),
			task: "t",
		};
		const first = await provider.generateObject(request).catch((e) => e);
		expect(first).toBeInstanceOf(SubscriptionUnavailableError);
		expect(first.kind).toBe("logged_out");
		// Held: the same pause, nothing looked at again.
		expect(await provider.generateObject(request).catch((e) => e)).toBe(first);
		resumeAntigravityCalls();
		const next = await provider.generateObject(request).catch((e) => e);
		expect(next).not.toBe(first);
		expect(next.kind).toBe("logged_out");
		resumeAntigravityCalls();
	});
});

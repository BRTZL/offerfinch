import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	type BrowserSession,
	PRIVATE_NETWORK_REFUSED,
} from "@offerfinch/core/scrape/browser";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { siteBrowser } from "./browser";

/**
 * Codex review of PR #149 (2026-11-09), P1: a form read (`read_only`, `refusePrivateNetwork`) let a
 * permitted fetch, frame or GraphQL-query POST on a public host through with `route.continue()`,
 * and the browser followed its redirect to this Mac unseen: two `GET /sink` and a `POST /sink`
 * (a 307 keeps the POST) reached localhost. The board is on public-looking names under
 * `acme.test` (answered by this server through `siteBrowser`); the sink is `localhost:<port>`.
 */
let server: Server;
let port = 0;
const hits: string[] = [];
/** The `authorization` header each request arrived with, by "METHOD host/path". */
const credentials = new Map<string, string>();

beforeAll(async () => {
	server = createServer((req, res) => {
		const host = String(
			req.headers["x-fixture-host"] ?? req.headers.host ?? "",
		);
		const hit = `${req.method} ${host.replace(/:\d+$/, "")}${req.url}`;
		hits.push(hit);
		if (req.headers.authorization)
			credentials.set(hit, req.headers.authorization);
		const sink = `http://localhost:${port}/sink`;
		const redirects: Record<string, [number, string]> = {
			"/asset": [302, sink],
			"/post-asset": [307, sink],
			"/frame-asset": [302, sink],
			// Public, then public again, then this Mac: every hop is checked, not just the first.
			"/chain": [302, `http://cdn.acme.test:${port}/chain-2`],
			"/chain-2": [302, sink],
			// A normal redirect between public hosts.
			"/moved": [302, `http://cdn.acme.test:${port}/data`],
			"/moved-post": [307, `http://cdn.acme.test:${port}/data`],
			"/page-moved": [302, `http://cdn.acme.test:${port}/landed`],
			"/frame-chain": [302, `http://cdn.acme.test:${port}/chain-2`],
		};
		const redirect = redirects[(req.url ?? "").split("?")[0] ?? ""];
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
		if (req.url === "/data") {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify({ ok: true, method: req.method }));
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
});

const sinkHits = () => hits.filter((h) => h.includes("/sink"));

async function withPage<T>(
	network: "read_only" | "allowlist",
	run: (page: Awaited<ReturnType<BrowserSession["newPage"]>>) => Promise<T>,
): Promise<T> {
	const session = await siteBrowser(port).openSession({
		network,
		allowedHosts: ["boards.acme.test", "cdn.acme.test"],
		refusePrivateNetwork: true,
	});
	try {
		const page = await session.newPage();
		await page.goto(`http://boards.acme.test:${port}/main`);
		return await run(page);
	} finally {
		await session.close();
	}
}

const PROBE = `(() => {
	fetch('/asset').catch(() => {});
	fetch('/post-asset', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ query: 'query { probe }' }),
	}).catch(() => {});
	fetch('/chain').catch(() => {});
	const frame = document.createElement('iframe');
	frame.src = '/frame-asset';
	document.body.appendChild(frame);
	const chained = document.createElement('iframe');
	chained.src = '/frame-chain';
	document.body.appendChild(chained);
})()`;

const MOVED = `(async () => {
	const get = await fetch('/moved').then((r) => r.json());
	const post = await fetch('/moved-post', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ query: 'query { jobs }' }),
	}).then((r) => r.json());
	return { get, post };
})()`;

describe.each(["read_only", "allowlist"] as const)(
	"%s with private networks refused",
	(network) => {
		it("never follows a public subresource's redirect to this Mac (fetch, 307 POST, frame, chain)", async () => {
			const log = await withPage(network, async (page) => {
				await page.evaluate(PROBE);
				await page.waitForTimeout(1_500);
				return page.networkLog();
			});
			expect(sinkHits(), JSON.stringify(hits)).toEqual([]);
			// The public hops were asked; the private hop was not.
			expect(hits).toEqual(
				expect.arrayContaining([
					"GET boards.acme.test/asset",
					"POST boards.acme.test/post-asset",
					"GET boards.acme.test/frame-asset",
					"GET cdn.acme.test/chain-2",
				]),
			);
			const refused = log.filter((e) => !e.allowed && e.url.includes("/sink"));
			expect(refused.length).toBeGreaterThanOrEqual(5);
			if (network === "read_only")
				expect(refused.every((e) => e.reason === PRIVATE_NETWORK_REFUSED)).toBe(
					true,
				);
		}, 30_000);

		it("never follows the page's own redirect chain to this Mac", async () => {
			const session = await siteBrowser(port).openSession({
				network,
				allowedHosts: ["boards.acme.test", "cdn.acme.test"],
				refusePrivateNetwork: true,
			});
			try {
				const page = await session.newPage();
				await expect(
					page.goto(`http://boards.acme.test:${port}/chain`),
				).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
			} finally {
				await session.close();
			}
			expect(sinkHits(), JSON.stringify(hits)).toEqual([]);
			expect(hits).toEqual(
				expect.arrayContaining([
					"GET boards.acme.test/chain",
					"GET cdn.acme.test/chain-2",
				]),
			);
		}, 30_000);

		it("never follows a chain to this Mac that the page starts itself", async () => {
			const at = await withPage(network, async (page) => {
				await page.evaluate("location.href = '/chain'");
				await page.waitForTimeout(1_500);
				return page.evaluate<string>("location.href");
			});
			expect(sinkHits(), JSON.stringify(hits)).toEqual([]);
			expect(hits).toContain("GET cdn.acme.test/chain-2");
			expect(at).not.toMatch(/localhost/);
		}, 30_000);

		it("lands on the real URL when the page redirects between its hosts", async () => {
			const landed = await withPage(network, (page) =>
				page.goto(`http://boards.acme.test:${port}/page-moved`),
			);
			expect(landed).toMatchObject({
				status: 200,
				url: `http://cdn.acme.test:${port}/landed`,
			});
		}, 30_000);

		it("sends no credentials on to another origin", async () => {
			await withPage(network, (page) =>
				page.evaluate(
					"fetch('/moved', { headers: { authorization: 'Bearer probe' } }).then((r) => r.json())",
				),
			);
			expect(hits).toContain("GET cdn.acme.test/data");
			expect(credentials.get("GET boards.acme.test/moved")).toBe(
				"Bearer probe",
			);
			expect(credentials.has("GET cdn.acme.test/data")).toBe(false);
		}, 30_000);

		it("still follows a redirect between public hosts", async () => {
			const answer = await withPage(network, (page) => page.evaluate(MOVED));
			expect(answer).toEqual({
				get: { ok: true, method: "GET" },
				post: { ok: true, method: "POST" },
			});
			expect(hits).toEqual(
				expect.arrayContaining([
					"GET boards.acme.test/moved",
					"GET cdn.acme.test/data",
					"POST cdn.acme.test/data",
				]),
			);
		}, 30_000);
	},
);

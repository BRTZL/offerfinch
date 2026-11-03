import http from "node:http";
import type { AddressInfo } from "node:net";
import { readLinkedPage } from "@offerfinch/core/scrape/linked-page";
import {
	type DestinationPolicy,
	fetchPublic,
	RefusedDestination,
} from "@offerfinch/core/scrape/public-fetch";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findChrome, localChromeProvider } from "../src/worker/browser";

/**
 * A page a user links may be hostile: it must not reach this Mac or a private network, by any
 * route. Here 127.0.0.1 stands for "the internet" and [::1] for "a private network"; the private
 * server counts every request and connection attempt, and must see none.
 */

let pub: http.Server;
let priv: http.Server;
let pubPort = 0;
let privPort = 0;
const hits: string[] = [];

const policy: DestinationPolicy = {
	lookup: async (host) =>
		({
			"jobs.public.test": ["127.0.0.1"],
			"intranet.test": ["::1"],
			// Answers public and private: how DNS rebinding starts.
			"rebind.test": ["127.0.0.1", "::1"],
		})[host] ?? [],
	allowAddress: (address) => address === "127.0.0.1",
};

const POSTING = `<h1>Data Engineer</h1>
<p>Tidewater moves freight data between ports. You will build the pipelines our planners rely on, in Python and SQL, with a small team that ships weekly.</p>
<p>Planners in twelve ports use what you build every morning, so reliability matters more than novelty here.</p>
<h2>Requirements</h2><ul><li>3 years of Python</li><li>SQL and dbt</li><li>Experience with Airflow or Dagster</li></ul>`;

beforeAll(async () => {
	priv = http.createServer((req, res) => {
		hits.push(`${req.method} ${req.url}`);
		res.end("private");
	});
	priv.on("upgrade", (req, socket) => {
		hits.push(`UPGRADE ${req.url}`);
		socket.destroy();
	});
	priv.on("connection", () => hits.push("connection"));
	await new Promise<void>((r) => priv.listen(0, "::1", r));
	privPort = (priv.address() as AddressInfo).port;
	const p = `http://[::1]:${privPort}`;
	const named = `http://intranet.test:${privPort}`;
	const rebind = `http://rebind.test:${privPort}`;

	pub = http.createServer((req, res) => {
		const html = (body: string) => {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(body);
		};
		if (req.url === "/static")
			return html(`<!doctype html><html><head><title>Data Engineer | Tidewater</title>
<meta property="og:site_name" content="Tidewater">
<meta http-equiv="refresh" content="0; url=${p}/refresh">
<link rel="stylesheet" href="${p}/style.css"><link rel="prefetch" href="${named}/prefetch">
</head><body><main>${POSTING}<img src="${p}/img.png"><iframe src="${named}/frame"></iframe>
<script src="${p}/script.js"></script></main></body></html>`);
		if (req.url === "/redirect") {
			res.writeHead(302, { location: `${p}/landing` });
			return res.end();
		}
		if (req.url === "/redirect-name") {
			res.writeHead(301, { location: `${named}/landing` });
			return res.end();
		}
		if (req.url === "/js")
			// No posting until scripts run; the scripts try every way out to the private server.
			return html(`<!doctype html><html><head><title>Data Engineer | Tidewater</title>
<meta property="og:site_name" content="Tidewater"></head><body><main id="app"></main>
<div style="background:url(${p}/bg.png)">x</div>
<script>
document.getElementById("app").innerHTML = ${JSON.stringify(POSTING)};
new Image().src = "${p}/image";
const f = document.createElement("iframe"); f.src = "${named}/iframe"; document.body.append(f);
fetch("${p}/fetch").catch(() => {});
fetch("${rebind}/rebind").catch(() => {});
fetch("${p}/post", { method: "POST", body: "x" }).catch(() => {});
navigator.sendBeacon && navigator.sendBeacon("${p}/beacon", "x");
try { new WebSocket("ws://[::1]:${privPort}/ws"); } catch {}
try { new Worker(URL.createObjectURL(new Blob(['fetch("${p}/worker")'], { type: "text/javascript" }))); } catch {}
window.open("${p}/popup");
setTimeout(() => { location.href = "${p}/late"; }, 300);
</script></body></html>`);
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((r) => pub.listen(0, "127.0.0.1", r));
	pubPort = (pub.address() as AddressInfo).port;
});

afterAll(async () => {
	await new Promise<void>((r) => pub.close(() => r()));
	await new Promise<void>((r) => priv.close(() => r()));
});

const at = (path: string) => `http://jobs.public.test:${pubPort}${path}`;

describe("reading a linked page", () => {
	it("reads the posting from static HTML, fetching nothing the page refers to", async () => {
		hits.length = 0;
		const read = await readLinkedPage(at("/static"), { policy, llm: null });
		expect(read).toMatchObject({
			posting: { title: "Data Engineer", company: "Tidewater" },
		});
		expect(hits).toEqual([]);
	});

	it("refuses a redirect to a private address or a name that resolves to one", async () => {
		hits.length = 0;
		await expect(
			readLinkedPage(at("/redirect"), { policy, llm: null }),
		).rejects.toBeInstanceOf(RefusedDestination);
		await expect(
			readLinkedPage(at("/redirect-name"), { policy, llm: null }),
		).rejects.toBeInstanceOf(RefusedDestination);
		expect(hits).toEqual([]);
	});

	it("refuses a name that answers public and private (rebinding), and pins the address", async () => {
		hits.length = 0;
		await expect(
			fetchPublic(`http://rebind.test:${privPort}/`, policy),
		).rejects.toBeInstanceOf(RefusedDestination);
		// A name is resolved once per request and the connection goes to that address.
		let calls = 0;
		const flipping: DestinationPolicy = {
			lookup: async () => (++calls === 1 ? ["127.0.0.1"] : ["::1"]),
			allowAddress: policy.allowAddress,
		};
		const page = await fetchPublic(
			`http://flip.test:${pubPort}/static`,
			flipping,
		);
		expect(page.status).toBe(200);
		expect(calls).toBe(1);
		expect(hits).toEqual([]);
	});

	it.skipIf(!findChrome())(
		"renders a script-built page in a browser with no network of its own: nothing reaches the private network",
		async () => {
			hits.length = 0;
			const read = await readLinkedPage(at("/js"), {
				policy,
				browser: localChromeProvider(),
				llm: null,
			});
			expect(read).toMatchObject({
				posting: { title: "Data Engineer", company: "Tidewater" },
			});
			// Give anything late (the timed navigation, the worker) time to try.
			await new Promise((r) => setTimeout(r, 1_500));
			expect(hits).toEqual([]);
		},
		60_000,
	);
});

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	DESTINATION_REFUSED,
	type HostRules,
	type NetworkLogEntry,
	NOT_A_DESTINATION,
} from "@offerfinch/core/scrape/browser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureBrowser } from "./browser";

/**
 * A board's other hosts in a real submission's "allowlist" session (`BoardConfig.hosts` and
 * `refusedHosts`, docs/form-inspection.md 2026-11-09). The form is on 127.0.0.1 (a form host);
 * localhost plays one other role per test: an asset or scoring host (read-only, its own frame
 * may post) or an unlisted host (refused quietly unless the request could carry the application).
 */

interface Hit {
	host: string;
	method: string;
	path: string;
}

const EMAIL = "dryrun.testperson@example.com";
let server: Server;
let port = 0;
const hits: Hit[] = [];

const otherOrigin = () => `http://localhost:${port}`;

/** The form page for each case; `otherOrigin()` is the other host. */
function pageFor(name: string): string {
	const other = otherOrigin();
	const send = (body: string) =>
		`<script>fetch("${other}/asset", { method: "POST", body: ${body}, mode: "no-cors" }).catch(() => {});</script>`;
	const pages: Record<string, string> = {
		"read-get": `<img src="${other}/asset.png">`,
		"read-post": send(`"x"`),
		"read-post-data": send(`"email=${EMAIL}"`),
		"read-upload": `<script>const d = new FormData(); d.append("cv", new Blob(["%PDF-1.4"], { type: "application/pdf" }), "cv.pdf"); fetch("${other}/upload", { method: "POST", body: d, mode: "no-cors" }).catch(() => {});</script>`,
		"read-leak": `<input id="email"><script>document.getElementById("email").addEventListener("change", (e) => { new Image().src = "${other}/asset.png?d=" + encodeURIComponent(e.target.value); });</script>`,
		"read-redirect": `<img src="${other}/redirect">`,
		"read-navigate": `<script>setTimeout(() => { location.href = "${other}/asset"; }, 200);</script>`,
		"widget-frame-post": `<iframe src="${other}/widget"></iframe>`,
		"widget-form-target": `<iframe name="w" src="${other}/widget-idle"></iframe><form method="post" action="${other}/score" target="w"><input name="q" value="hello"></form><script>setTimeout(() => document.forms[0].submit(), 400);</script>`,
		"widget-frame-leak": `<iframe src="${other}/widget-leak"></iframe>`,
		analytics: `<img src="${other}/pixel.gif">${send(`JSON.stringify({ event: "page_view" })`)}`,
	};
	return `<!doctype html><html><body><h1>Form</h1>${pages[name] ?? ""}</body></html>`;
}

/** Pages served on the other host (the widget's own frame). */
const WIDGET: Record<string, string> = {
	"/widget": `<script>fetch("/score", { method: "POST", body: "token" }).catch(() => {});</script>`,
	"/widget-idle": "<p>widget</p>",
	"/widget-leak": `<script>setTimeout(() => fetch("/score", { method: "POST", body: "${EMAIL}" }).catch(() => {}), 300);</script>`,
};

beforeAll(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const host = (req.headers.host ?? "").split(":")[0] ?? "";
		hits.push({ host, method: req.method ?? "", path: url.pathname });
		res.setHeader("access-control-allow-origin", "*");
		if (url.pathname.startsWith("/page/")) {
			res.writeHead(200, { "content-type": "text/html" });
			res.end(pageFor(url.pathname.slice("/page/".length)));
			return;
		}
		if (url.pathname === "/redirect") {
			// To a host that is neither a destination nor an asset host.
			res.writeHead(302, { location: `http://[::1]:${port}/asset.png` });
			res.end();
			return;
		}
		const widget = WIDGET[url.pathname];
		if (widget) {
			res.writeHead(200, { "content-type": "text/html" });
			res.end(`<!doctype html><html><body>${widget}</body></html>`);
			return;
		}
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("ok");
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
	await new Promise<void>((done) => {
		server.closeAllConnections?.();
		server.close(() => done());
	});
});

const NONE: HostRules = { read: [] };
const ASSET: HostRules = { read: ["localhost"] };

/** Opens the case's page in an allowlist session; `typed` is filled into the page's #email. */
async function open(
	name: string,
	rules: HostRules | undefined,
	typed?: string,
): Promise<{ log: NetworkLogEntry[]; away: Hit[] }> {
	const before = hits.length;
	const session = await fixtureBrowser().openSession({
		network: "allowlist",
		allowedHosts: ["127.0.0.1"],
		...(rules ? { hostRules: rules } : {}),
		formValues: [EMAIL, "Dryrun Testperson"],
	});
	try {
		const page = await session.newPage();
		await page.goto(`http://127.0.0.1:${port}/page/${name}`);
		if (typed) {
			await page.fill("#email", typed);
			await page.press("#email", "Tab");
		}
		await page.waitForTimeout(1_200);
		return {
			log: page.networkLog(),
			away: hits.slice(before).filter((h) => h.host === "localhost"),
		};
	} finally {
		await session.close();
	}
}

const violations = (log: NetworkLogEntry[]) =>
	log.filter((r) => r.reason === DESTINATION_REFUSED);
const quiet = (log: NetworkLogEntry[]) =>
	log.filter((r) => r.reason === NOT_A_DESTINATION);
const seen = (list: Hit[]) => list.map((h) => `${h.method} ${h.path}`);

describe("asset and scoring hosts in a real submission's session", () => {
	it("are read with GET", async () => {
		const { log, away } = await open("read-get", ASSET);
		expect(violations(log)).toEqual([]);
		expect(seen(away)).toEqual(["GET /asset.png"]);
	});

	it("never get a POST from the page: refused quietly, nothing arrives", async () => {
		const { log, away } = await open("read-post", ASSET);
		expect(violations(log)).toEqual([]);
		expect(quiet(log).map((r) => r.method)).toEqual(["POST"]);
		expect(away).toEqual([]);
	});

	it("never get a filled value in a body: refused, and the run stops", async () => {
		const { log, away } = await open("read-post-data", ASSET);
		expect(violations(log).map((r) => r.method)).toEqual(["POST"]);
		expect(away).toEqual([]);
	});

	it("never get an upload: refused, and the run stops", async () => {
		const { log, away } = await open("read-upload", ASSET);
		expect(violations(log).map((r) => r.method)).toEqual(["POST"]);
		expect(away).toEqual([]);
	});

	it("never get a typed value in a URL: refused, and the run stops", async () => {
		const { log, away } = await open("read-leak", ASSET, EMAIL);
		expect(violations(log).map((r) => r.url)).toEqual([
			`http://localhost:${port}/asset.png?d=${encodeURIComponent(EMAIL)}`,
		]);
		expect(away).toEqual([]);
	});

	it("re-check a redirect: one to an unlisted host is not followed", async () => {
		const { log, away } = await open("read-redirect", ASSET);
		expect(quiet(log).map((r) => r.url)).toEqual([
			`http://[::1]:${port}/asset.png`,
		]);
		expect(seen(away)).toEqual(["GET /redirect"]);
	});

	it("are never where the page itself goes: that stops the run", async () => {
		const { log } = await open("read-navigate", ASSET);
		expect(violations(log).map((r) => r.url)).toEqual([
			`http://localhost:${port}/asset`,
		]);
	});

	it("may be posted to by a frame loaded from them (a scoring widget), with fetch", async () => {
		const { log, away } = await open("widget-frame-post", ASSET);
		expect(violations(log)).toEqual([]);
		expect(seen(away)).toEqual(["GET /widget", "POST /score"]);
	});

	it("never get a form aimed at the widget's frame (a document post)", async () => {
		const { log, away } = await open("widget-form-target", ASSET);
		expect(quiet(log).map((r) => r.method)).toEqual(["POST"]);
		expect(seen(away)).toEqual(["GET /widget-idle"]);
	});

	it("never get a filled value from the widget's frame either", async () => {
		const { log, away } = await open("widget-frame-leak", ASSET);
		expect(violations(log).map((r) => r.method)).toEqual(["POST"]);
		expect(seen(away)).toEqual(["GET /widget-leak"]);
	});
});

describe("hosts that are neither destinations nor asset hosts", () => {
	it("are refused quietly (analytics, error reports) and the run goes on", async () => {
		for (const rules of [NONE, undefined]) {
			const { log, away } = await open("analytics", rules);
			expect(violations(log)).toEqual([]);
			expect(
				quiet(log)
					.map((r) => r.method)
					.sort(),
			).toEqual(["GET", "POST"]);
			expect(away).toEqual([]);
		}
	});
});

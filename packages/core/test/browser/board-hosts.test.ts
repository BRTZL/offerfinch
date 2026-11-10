import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	DESTINATION_REFUSED,
	type HostRules,
	type NetworkLogEntry,
	NOT_A_DESTINATION,
} from "@offerfinch/core/scrape/browser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	hcaptcha,
	joinRules,
	recaptchaEnterprise,
} from "../../src/apply/host-rules";
import { fixtureBrowser } from "./browser";

/**
 * A board's other hosts in a real submission's "allowlist" session (`BoardConfig.hosts` and
 * `BOARD_HOST_RULES`, docs/form-inspection.md 2026-11-09). The form is on 127.0.0.1 (a form
 * host); localhost plays one other role per test: an asset host with reCAPTCHA's and hCaptcha's
 * rules (the boards' real paths and parameters, on localhost), or an unlisted host (refused
 * quietly unless the request could carry the application).
 */

interface Hit {
	host: string;
	method: string;
	path: string;
}

const EMAIL = "dryrun.testperson@example.com";
const KEY = "6LtestKey000000000000000000000000000000AA";
const B64 = Buffer.from(EMAIL).toString("base64");
let server: Server;
let port = 0;
const hits: Hit[] = [];

const otherOrigin = () => `http://localhost:${port}`;

/** reCAPTCHA's anchor frame as its script builds it, for a form on 127.0.0.1. */
const anchor = (key = KEY) =>
	`${otherOrigin()}/recaptcha/enterprise/anchor?ar=1&k=${key}&co=${Buffer.from(`http://127.0.0.1:${port}`).toString("base64").replace(/=/g, ".")}&hl=en&v=bSuJ2xBC8cFy7pM4Z3Hu9boH&size=invisible&anchor-ms=20000&execute-ms=30000&cb=7jjpwkes64lm`;
const HFRAME = () =>
	`${otherOrigin()}/captcha/v1/58a2633848099317cef7deac21e607b1a41a5b9d/static/hcaptcha.html#frame=checkbox-invisible&host=127.0.0.1&sitekey=${KEY}`;
const RELOAD = `/recaptcha/enterprise/reload?k=${KEY}`;

/** The form page for each case; `otherOrigin()` is the other host. */
function pageFor(name: string): string {
	const other = otherOrigin();
	const img = (query: string) => `<img src="${other}/asset.png?${query}">`;
	/** A frame the page makes itself, posting the email's base64 to reCAPTCHA's endpoint. */
	const madeFrame = (setup: string) =>
		`<script>const f = document.createElement("iframe"); ${setup} document.body.append(f);</script>`;
	const madePost = `fetch("${other}${RELOAD}", { method: "POST", body: "${B64}", mode: "no-cors" }).catch(() => {});`;
	const send = (body: string) =>
		`<script>fetch("${other}/asset", { method: "POST", body: ${body}, mode: "no-cors" }).catch(() => {});</script>`;
	const pages: Record<string, string> = {
		"read-get": `<img src="${other}/asset.png">`,
		"read-post": send(`"x"`),
		"read-post-data": send(`"email=${EMAIL}"`),
		"read-upload": `<script>const d = new FormData(); d.append("cv", new Blob(["%PDF-1.4"], { type: "application/pdf" }), "cv.pdf"); fetch("${other}/upload", { method: "POST", body: d, mode: "no-cors" }).catch(() => {});</script>`,
		"read-put": `<script>fetch("${other}/upload", { method: "PUT", body: new Blob(["%PDF-1.4"], { type: "application/pdf" }) }).catch(() => {});</script>`,
		"read-leak": `<input id="email"><script>document.getElementById("email").addEventListener("change", (e) => { new Image().src = "${other}/asset.png?d=" + encodeURIComponent(e.target.value); });</script>`,
		"read-redirect": `<img src="${other}/redirect">`,
		"read-navigate": `<script>setTimeout(() => { location.href = "${other}/asset"; }, 200);</script>`,
		"widget-frame-post": `<script src="${other}/recaptcha/enterprise.js?render=${KEY}&onload=onLoadReCaptcha"></script><iframe src="${anchor()}"></iframe>`,
		"hcaptcha-frame-post": `<script src="${other}/1/api.js?host=127.0.0.1&se=58a2633848099317cef7deac21e607b1a41a5b9d&onload=_onLoad"></script><iframe src="${HFRAME()}"></iframe>`,
		"widget-form-target": `<iframe name="w" src="${anchor().replace("7jjpwkes64lm", "idleidleidle")}"></iframe><iframe name="v" src="${HFRAME().replace("hcaptcha.html", "idle.html")}"></iframe><form method="post" action="${other}${RELOAD}" target="v"><input name="q" value="hello"></form><script>setTimeout(() => document.forms[0].submit(), 400);</script>`,
		"widget-frame-leak": `<iframe src="${anchor().replace("7jjpwkes64lm", "leakleakleak")}"></iframe>`,
		"widget-frame-other-path": `<iframe src="${HFRAME().replace("hcaptcha.html", "score.html")}"></iframe>`,
		"widget-frame-wrong-key": `<iframe src="${anchor("6LattackerKey00000000000000000000000000AA")}"></iframe>`,
		// Codex's probe: a frame on the widget's host but not its frame path, fed the email.
		"page-frame-message": `<script>const f = document.createElement("iframe"); f.src = "${other}/widget-message"; f.onload = () => f.contentWindow.postMessage("${B64}", "*"); document.body.append(f);</script>`,
		"page-frame-blank": madeFrame(
			`f.onload = () => f.contentWindow.eval(${JSON.stringify(madePost)});`,
		),
		"page-frame-srcdoc": madeFrame(
			`f.srcdoc = ${JSON.stringify(`<script>${madePost}</script>`).replace(/<\//g, "<\\/")};`,
		),
		"page-frame-blob": madeFrame(
			`f.src = URL.createObjectURL(new Blob([${JSON.stringify(`<script>${madePost}</script>`).replace(/<\//g, "<\\/")}], { type: "text/html" }));`,
		),
		"asset-base64": img(`d=${B64}`),
		"asset-double-encoded": img(
			`d=${encodeURIComponent(encodeURIComponent(EMAIL))}`,
		),
		"asset-unicode-escape": img(
			`d=${encodeURIComponent(JSON.stringify({ e: "dryrun.testperson\\u0040example.com" }).replace(/\\\\/g, "\\"))}`,
		),
		"asset-split": `${img("a=dryrun.testp")}${img("b=erson%40exam")}${img("c=ple.com")}`,
		"asset-script-query": `<script src="${other}/recaptcha/enterprise.js?render=${KEY}&onload=${B64.replace(/=+$/, "")}"></script>`,
		"asset-fetch": `<script>fetch("${other}/asset.js").catch(() => {}); navigator.sendBeacon("${other}/asset.png", "x");</script>`,
		analytics: `<img src="${other}/pixel.gif">${send(`JSON.stringify({ event: "page_view" })`)}`,
	};
	return `<!doctype html><html><body><h1>Form</h1>${pages[name] ?? ""}</body></html>`;
}

/** Pages served on the other host (the widget's own frame). */
const WIDGET: Record<string, (query: URLSearchParams) => string> = {
	// reCAPTCHA's anchor: posts a token to its own reload endpoint (or, `leak`, the email).
	"/recaptcha/enterprise/anchor": (q) =>
		q.get("cb") === "idleidleidle"
			? "<p>widget</p>"
			: `<script>setTimeout(() => fetch("${RELOAD}", { method: "POST", body: "${q.get("cb") === "leakleakleak" ? EMAIL : "token"}" }).catch(() => {}), 300);</script>`,
	// hCaptcha's frame: posts to checksiteconfig, as on Lever.
	"/captcha/v1/58a2633848099317cef7deac21e607b1a41a5b9d/static/hcaptcha.html":
		() =>
			`<script>fetch("/checksiteconfig?v=58a2&host=127.0.0.1&sitekey=${KEY}&sc=1", { method: "POST", body: "token" }).catch(() => {});</script>`,
	"/captcha/v1/58a2633848099317cef7deac21e607b1a41a5b9d/static/idle.html": () =>
		"<p>widget</p>",
	// A real widget frame posting to a path that is not one of its endpoints.
	"/captcha/v1/58a2633848099317cef7deac21e607b1a41a5b9d/static/score.html":
		() =>
			`<script>fetch("/score", { method: "POST", body: "token" }).catch(() => {});</script>`,
	"/widget-message": () =>
		`<script>onmessage = (e) => fetch("${RELOAD}", { method: "POST", body: e.data }).catch(() => {});</script>`,
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
			res.end(
				`<!doctype html><html><body>${widget(url.searchParams)}</body></html>`,
			);
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

const NONE: HostRules = { assets: [] };
/** The boards' real widget rules, on localhost. */
const ASSET: HostRules = joinRules(
	{ assets: ["localhost"] },
	recaptchaEnterprise([KEY], "localhost"),
	hcaptcha([KEY], {
		script: "localhost",
		frame: "localhost",
		api: ["localhost"],
	}),
);

/** Opens the case's page in an allowlist session; `typed` is filled into the page's #email. */
async function open(
	name: string,
	rules: HostRules | undefined,
	typed?: string,
	formValues: string[] = [EMAIL, "Dryrun Testperson"],
): Promise<{ log: NetworkLogEntry[]; away: Hit[] }> {
	const before = hits.length;
	const session = await fixtureBrowser().openSession({
		network: "allowlist",
		allowedHosts: ["127.0.0.1"],
		...(rules ? { hostRules: rules } : {}),
		formValues,
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
/** The requests that arrived, sorted: frames and scripts load in parallel, in no fixed order. */
const seen = (list: Hit[]) => list.map((h) => `${h.method} ${h.path}`).sort();

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

	it("never get a raw file (a presigned PUT): refused, and the run stops", async () => {
		const { log, away } = await open("read-put", ASSET);
		expect(violations(log).map((r) => r.method)).toEqual(["PUT"]);
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

	it("load a widget as the boards do: its script, its frame with the board's key, and that frame's posts to its endpoints", async () => {
		const recaptcha = await open("widget-frame-post", ASSET);
		expect(violations(recaptcha.log)).toEqual([]);
		expect(seen(recaptcha.away)).toEqual([
			"GET /recaptcha/enterprise.js",
			"GET /recaptcha/enterprise/anchor",
			"POST /recaptcha/enterprise/reload",
		]);
		const h = await open("hcaptcha-frame-post", ASSET);
		expect(violations(h.log)).toEqual([]);
		expect(seen(h.away)).toEqual([
			"GET /1/api.js",
			"GET /captcha/v1/58a2633848099317cef7deac21e607b1a41a5b9d/static/hcaptcha.html",
			"POST /checksiteconfig",
		]);
	});

	it("never get a form aimed at the widget's frame (a document post)", async () => {
		const { log, away } = await open("widget-form-target", ASSET);
		expect(quiet(log).map((r) => r.method)).toEqual(["POST"]);
		expect(seen(away)).toEqual([
			"GET /captcha/v1/58a2633848099317cef7deac21e607b1a41a5b9d/static/idle.html",
			"GET /recaptcha/enterprise/anchor",
		]);
	});

	it("never get a filled value from the widget's frame either", async () => {
		const { log, away } = await open("widget-frame-leak", ASSET);
		expect(violations(log).map((r) => r.method)).toEqual(["POST"]);
		expect(seen(away)).toEqual(["GET /recaptcha/enterprise/anchor"]);
	});
});

describe("by structure alone, with no filled value to look for (Codex review, 2026-11-09)", () => {
	const structural = (name: string) => open(name, ASSET, undefined, []);

	it.each([
		"asset-base64",
		"asset-double-encoded",
		"asset-unicode-escape",
		"asset-split",
		"asset-script-query",
	])(
		"an asset request carrying the email (%s): refused, nothing arrives",
		async (name) => {
			const { log, away } = await structural(name);
			expect(away).toEqual([]);
			expect(quiet(log).length).toBeGreaterThan(0);
		},
	);

	it("an asset host gets no fetch and no beacon, even without a query", async () => {
		const { log, away } = await structural("asset-fetch");
		expect(away).toEqual([]);
		expect(
			quiet(log)
				.map((r) => r.method)
				.sort(),
		).toEqual(["GET", "POST"]);
	});

	it.each([
		"page-frame-message",
		"page-frame-blank",
		"page-frame-srcdoc",
		"page-frame-blob",
	])(
		"a frame the page made (%s) never posts to a widget endpoint",
		async (name) => {
			const { log, away } = await structural(name);
			expect(away).toEqual([]);
			expect(quiet(log).length).toBeGreaterThan(0);
		},
	);

	it("a widget frame posts nowhere but its endpoints, and one without the board's key never loads", async () => {
		const other = await structural("widget-frame-other-path");
		expect(seen(other.away)).toEqual([
			"GET /captcha/v1/58a2633848099317cef7deac21e607b1a41a5b9d/static/score.html",
		]);
		expect(quiet(other.log).map((r) => r.method)).toEqual(["POST"]);
		const wrong = await structural("widget-frame-wrong-key");
		expect(wrong.away).toEqual([]);
	});
});

describe("hosts that are neither destinations nor asset hosts", () => {
	it("never get a raw file either: refused, and the run stops", async () => {
		const { log, away } = await open("read-put", NONE);
		expect(violations(log).map((r) => r.method)).toEqual(["PUT"]);
		expect(away).toEqual([]);
	});

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

import { describe, expect, it } from "vitest";

import { sessionHosts } from "../src/apply/forms";
import {
	boardHostDecision,
	carriesFormData,
	formValueNeedles,
	hostMatches,
	type RequestFacts,
	readOnlyDecision,
} from "../src/apply/network-guard";

describe("readOnlyDecision", () => {
	it("lets reads through and GraphQL queries", () => {
		expect(readOnlyDecision("GET", null).allow).toBe(true);
		expect(readOnlyDecision("HEAD", null).allow).toBe(true);
		expect(
			readOnlyDecision(
				"POST",
				JSON.stringify({
					operationName: "ApiJobPosting",
					query:
						"query ApiJobPosting($id: String!) { jobPosting(id: $id) { id } }",
				}),
			).allow,
		).toBe(true);
	});

	it("blocks mutations, form posts, uploads and other methods", () => {
		for (const [method, body] of [
			["POST", JSON.stringify({ query: "mutation Submit { submit { ok } }" })],
			["POST", JSON.stringify({ query: "query A { a } mutation B { b }" })],
			[
				"POST",
				JSON.stringify([
					{ query: "query A { a }" },
					{ query: "mutation B { b }" },
				]),
			],
			["POST", JSON.stringify({ name: "Ada", email: "a@b.c" })],
			["POST", "name=Ada&email=a%40b.c"],
			["POST", null],
			["PUT", "{}"],
			["PATCH", "{}"],
			["DELETE", null],
		] as const)
			expect(readOnlyDecision(method, body).allow, `${method} ${body}`).toBe(
				false,
			);
	});
});

describe("hostMatches", () => {
	it("matches exact names, and one label under a `*.` name", () => {
		expect(hostMatches("jobs.lever.co", "jobs.lever.co")).toBe(true);
		expect(hostMatches("JOBS.lever.co", "jobs.lever.co")).toBe(true);
		expect(hostMatches("cdn.lever.co", "jobs.lever.co")).toBe(false);
		expect(hostMatches("3490fe9a6ceb.w.hcaptcha.com", "*.w.hcaptcha.com")).toBe(
			true,
		);
		expect(hostMatches("a.b.w.hcaptcha.com", "*.w.hcaptcha.com")).toBe(false);
		expect(hostMatches("w.hcaptcha.com", "*.w.hcaptcha.com")).toBe(false);
		expect(hostMatches("w.hcaptcha.com.evil.com", "*.w.hcaptcha.com")).toBe(
			false,
		);
		expect(hostMatches("evilw.hcaptcha.com", "*.w.hcaptcha.com")).toBe(false);
	});
});

describe("carriesFormData", () => {
	const needles = formValueNeedles([
		"dryrun.testperson@example.com",
		"+1 555 010 0199",
		"Yes",
		"A long answer that would never be sent whole in a URL, only cut short.",
	]);

	it("finds a value as typed, URL-encoded, or a phone's digits", () => {
		expect(needles).not.toContain("yes");
		expect(
			carriesFormData(
				"https://x.test/v?address=dryrun.testperson%40example.com",
				needles,
			),
		).toBe(true);
		expect(carriesFormData("https://x.test/p?t=%2B15550100199", needles)).toBe(
			true,
		);
		expect(carriesFormData("https://x.test/p?t=1+555+010+0199", needles)).toBe(
			true,
		);
		expect(
			carriesFormData(
				"https://x.test/p?q=a%20long%20answer%20that%20would",
				needles,
			),
		).toBe(true);
		expect(
			carriesFormData('{"email":"DRYRUN.testperson@example.com"}', needles),
		).toBe(true);
	});

	it("passes URLs without the values, and long digit runs that do not hold the number", () => {
		expect(
			carriesFormData(
				"https://www.recaptcha.net/recaptcha/enterprise/anchor?ar=1&k=6Lc&co=aHR0cHM6&hl=en&v=1731000000000&size=invisible&cb=yes",
				needles,
			),
		).toBe(false);
		expect(
			carriesFormData("https://x.test/t?ts=17310000000005550100", needles),
		).toBe(false);
		expect(carriesFormData(null, needles)).toBe(false);
	});
});

describe("carriesFormData on the URLs the real forms load (2026-11-09)", () => {
	// A realistic applicant: a long LinkedIn link, a short first name, and "LinkedIn" as the
	// answer to Lever's "How did you hear about this opportunity?".
	const needles = formValueNeedles([
		"Mark Example",
		"mark.example@example.com",
		"+1 555 010 0199",
		"Lisbon",
		"https://www.linkedin.com/in/mark-example-1234567890",
		"https://github.com/mark-example",
		"LinkedIn",
		"Yes, I am willing to relocate to Lisbon.",
	]);

	it("matches none of the boards' own requests", () => {
		for (const url of [
			"https://platform.linkedin.com/xdoor/scripts/in.js",
			"https://www.linkedin.com/talentwidgets/apply-with-linkedin",
			"https://api.hcaptcha.com/checksiteconfig?v=58a2633848099317cef7deac21e607b1a41a5b9d&host=jobs.lever.co&sitekey=e33f87f8-88ec-4e1a-9a13-df9bbb1d8120&sc=1&swa=1&spst=1",
			"https://www.recaptcha.net/recaptcha/enterprise/anchor?ar=1&k=6LdQ&co=aHR0cHM6Ly9qb2ItYm9hcmRzLmdyZWVuaG91c2UuaW86NDQz&hl=en&v=gYdqkxiddE5aXrugNbBbKgtN&size=invisible&cb=mark",
			"https://www.googletagmanager.com/gtag/js?id=",
			"https://cdn.lever.co/fonts/linkedin.woff2",
			"https://jobs.lever.co/searchLocations?text=Lisbon",
			"https://www.recaptcha.net/recaptcha/enterprise/bframe?hl=en&v=bSuJ2xBC8cFy7pM4Z3Hu9boH&k=6LezdY0tAAAAAEnollNLCAI0z1VDGwM7AzGrU4XZ&bft=0dAFcWeA5AKr7zIhws48i2RjJeT9-Mo0uNf0ZrKQkIc3Se-0xBzKgEr5_Yx07WZSUn7_J8G2BQeCibUFTju81ounXhuIZ9LNGHnw",
			"https://www.recaptcha.net/recaptcha/enterprise/anchor?ar=1&k=6LezdY0tAAAAAEnollNLCAI0z1VDGwM7AzGrU4XZ&co=aHR0cHM6Ly9qb2JzLmFzaGJ5aHEuY29tOjQ0Mw..&hl=en&v=eiVW-J8HuKsDxSGNYMZ-9XFQ&size=invisible&anchor-ms=20000&execute-ms=30000&ovv=CADq00gF&cb=ed3hz57kie7j",
			"https://cdn.ashbyprd.com/frontend_non_user/9a61009d0135a9b1d820849e25de8c916f4233b0/.vite/manifest.json",
			"https://job-boards.cdn.greenhouse.io/locales/en/job_post.xARVcwpAozf1DR3o13mc-j7C04Jk3mAj0ab7ua2",
			"https://newassets.hcaptcha.com/captcha/v1/58a2633848099317cef7deac21e607b1a41a5b9d/static/hcaptcha.html",
		])
			expect(carriesFormData(url, needles), url).toBe(false);
	});

	it("still matches the applicant's own data", () => {
		expect(
			carriesFormData(
				"https://x.test/t?u=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fmark-example-1234567890",
				needles,
			),
		).toBe(true);
		expect(carriesFormData("https://x.test/t?n=Mark%20Example", needles)).toBe(
			true,
		);
		expect(
			carriesFormData("https://x.test/t?e=mark.example%40example.com", needles),
		).toBe(true);
	});
});

describe("carriesFormData through a script's encodings (Codex review, 2026-11-09)", () => {
	const EMAIL = "ada@example.test";
	const needles = formValueNeedles([EMAIL, "Ada Example"]);
	const b64 = Buffer.from(EMAIL).toString("base64");

	it("finds a value base64-encoded, URL-encoded twice, or JSON-escaped", () => {
		for (const text of [
			`https://x.test/p.png?d=${b64}`,
			`https://x.test/p.png?d=${b64.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}`,
			`https://x.test/p.png?d=${encodeURIComponent(encodeURIComponent(EMAIL))}`,
			'{"e":"ada\\u0040example.test"}',
			`https://x.test/p?d=${encodeURIComponent('{"e":"ada\\u0040example.test"}')}`,
		])
			expect(carriesFormData(text, needles), text).toBe(true);
	});

	it("cannot find a value split across requests (the structural rules refuse those)", () => {
		expect(carriesFormData("https://x.test/p.png?a=ada@exa", needles)).toBe(
			false,
		);
	});
});

describe("boardHostDecision on the boards' own requests (2026-11-09 inspection)", () => {
	const facts = (f: Partial<RequestFacts>): RequestFacts => ({
		method: "GET",
		url: "",
		resourceType: "script",
		navigation: false,
		mainFrame: true,
		frameUrl: "",
		...f,
	});
	const ashby = sessionHosts("ashby", ["jobs.ashbyhq.com"]);
	const lever = sessionHosts("lever", ["jobs.lever.co"]);
	const ASHBY_KEY = "6LezdY0tAAAAAEnollNLCAI0z1VDGwM7AzGrU4XZ";
	const LEVER_KEY = "e33f87f8-88ec-4e1a-9a13-df9bbb1d8120";
	const ANCHOR = `https://www.recaptcha.net/recaptcha/enterprise/anchor?ar=1&k=${ASHBY_KEY}&co=aHR0cHM6Ly9qb2JzLmFzaGJ5aHEuY29tOjQ0Mw..&hl=en&v=eiVW-J8HuKsDxSGNYMZ-9XFQ&size=invisible&anchor-ms=20000&execute-ms=30000&ovv=CADq00gF&cb=ed3hz57kie7j`;
	const HFRAME = `https://newassets.hcaptcha.com/captcha/v1/58a2633848099317cef7deac21e607b1a41a5b9d/static/hcaptcha.html#frame=checkbox-invisible&host=jobs.lever.co&sitekey=${LEVER_KEY}`;
	const ashbyOk = (f: Partial<RequestFacts>) =>
		boardHostDecision(facts(f), ashby.rules, ashby.form).allow;
	const leverOk = (f: Partial<RequestFacts>) =>
		boardHostDecision(facts(f), lever.rules, lever.form).allow;

	it("lets the boards' files, scripts and widget frames load", () => {
		expect(
			ashbyOk({
				url: "https://cdn.ashbyprd.com/frontend_non_user/5e16/assets/index-mlNa_IL5.js",
				resourceType: "script",
			}),
		).toBe(true);
		expect(
			ashbyOk({
				url: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
				resourceType: "stylesheet",
			}),
		).toBe(true);
		expect(
			ashbyOk({
				url: `https://www.recaptcha.net/recaptcha/enterprise.js?render=${ASHBY_KEY}&onload=onLoadReCaptcha`,
			}),
		).toBe(true);
		expect(
			ashbyOk({
				url: "https://www.recaptcha.net/recaptcha/enterprise/webworker.js?hl=en&v=bSuJ2xBC8cFy7pM4Z3Hu9boH",
			}),
		).toBe(true);
		expect(
			ashbyOk({
				url: ANCHOR,
				resourceType: "document",
				navigation: true,
				mainFrame: false,
			}),
		).toBe(true);
		expect(
			leverOk({
				url: "https://js.hcaptcha.com/1/api.js?host=jobs.lever.co&se=58a2633848099317cef7deac21e607b1a41a5b9d&onload=_onLoad",
			}),
		).toBe(true);
		expect(
			leverOk({
				url: "https://0e6bacb29f97.w.hcaptcha.com/logo.png",
				resourceType: "image",
				mainFrame: false,
				frameUrl: HFRAME,
			}),
		).toBe(true);
	});

	it("lets only the widget's own frame, with the board's key, post to its endpoints", () => {
		const reload = `https://www.recaptcha.net/recaptcha/enterprise/reload?k=${ASHBY_KEY}`;
		const post = { method: "POST", resourceType: "fetch", mainFrame: false };
		expect(ashbyOk({ ...post, url: reload, frameUrl: ANCHOR })).toBe(true);
		const check = `https://api2.hcaptcha.com/checksiteconfig?v=58a2&host=jobs.lever.co&sitekey=${LEVER_KEY}&sc=1`;
		expect(
			leverOk({ ...post, resourceType: "xhr", url: check, frameUrl: HFRAME }),
		).toBe(true);
		for (const frameUrl of [
			"about:blank",
			"about:srcdoc",
			"blob:https://jobs.ashbyhq.com/1d2c",
			"data:text/html,x",
			"https://jobs.ashbyhq.com/acme/1/application",
			ANCHOR.replace(ASHBY_KEY, "6LattackerKey0000000000000000000000000000"),
			"https://www.recaptcha.net/recaptcha/enterprise/other",
		])
			expect(ashbyOk({ ...post, url: reload, frameUrl }), frameUrl).toBe(false);
		// From the main frame, as a document, or to another path: never.
		expect(
			ashbyOk({ ...post, url: reload, mainFrame: true, frameUrl: ANCHOR }),
		).toBe(false);
		expect(
			ashbyOk({
				...post,
				url: reload,
				resourceType: "document",
				frameUrl: ANCHOR,
			}),
		).toBe(false);
		expect(
			ashbyOk({
				...post,
				url: "https://www.recaptcha.net/recaptcha/enterprise/score",
				frameUrl: ANCHOR,
			}),
		).toBe(false);
		// Turnstile's key is not recorded for Workable: none of its frames qualifies.
		const workable = sessionHosts("workable", ["apply.workable.com"]);
		expect(
			boardHostDecision(
				facts({
					...post,
					url: "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/flow/ov1/x",
					frameUrl:
						"https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/a/0x4AAAAAAAkey/auto/fbE/new/normal",
				}),
				workable.rules,
				workable.form,
			).allow,
		).toBe(false);
	});

	it("refuses an asset request that carries anything the board does not use", () => {
		const b64 = Buffer.from("ada@example.test").toString("base64");
		for (const url of [
			`https://cdn.ashbyprd.com/x.png?d=${b64}`,
			`https://cdn.ashbyprd.com/x.png?d=${encodeURIComponent(encodeURIComponent("ada@example.test"))}`,
			"https://cdn.ashbyprd.com/x.png?a=ada@exa",
			`https://fonts.googleapis.com/css2?family=Inter&display=swap&d=${b64}`,
			`https://fonts.googleapis.com/css2?family=${b64}`,
			`https://www.recaptcha.net/recaptcha/enterprise.js?render=${ASHBY_KEY}&onload=${b64}`,
			"https://www.recaptcha.net/recaptcha/enterprise.js?render=6LattackerKey&onload=x",
		])
			expect(ashbyOk({ url, resourceType: "image" }), url).toBe(false);
		// The same anchor frame from another origin's page (`co`), or with a parameter added.
		expect(
			ashbyOk({
				url: ANCHOR.replace(
					"aHR0cHM6Ly9qb2JzLmFzaGJ5aHEuY29tOjQ0Mw..",
					Buffer.from("https://evil.test:443").toString("base64"),
				),
				resourceType: "document",
				navigation: true,
				mainFrame: false,
			}),
		).toBe(false);
		expect(
			ashbyOk({
				url: `${ANCHOR}&d=x`,
				resourceType: "document",
				navigation: true,
				mainFrame: false,
			}),
		).toBe(false);
		// Not a file load: xhr, fetch, a beacon, a ping, a frame, or a POST.
		for (const resourceType of [
			"xhr",
			"fetch",
			"ping",
			"beacon",
			"other",
			"document",
			"",
		])
			expect(
				ashbyOk({ url: "https://cdn.ashbyprd.com/x.js", resourceType }),
				resourceType,
			).toBe(false);
		expect(
			ashbyOk({ url: "https://cdn.ashbyprd.com/x.js", method: "POST" }),
		).toBe(false);
	});
});

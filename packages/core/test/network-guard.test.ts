import { describe, expect, it } from "vitest";

import {
	carriesFormData,
	formValueNeedles,
	hostMatches,
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
		"Ankara",
		"https://www.linkedin.com/in/mark-example-1234567890",
		"https://github.com/mark-example",
		"LinkedIn",
		"Yes, I am willing to relocate to Istanbul.",
	]);

	it("matches none of the boards' own requests", () => {
		for (const url of [
			"https://platform.linkedin.com/xdoor/scripts/in.js",
			"https://www.linkedin.com/talentwidgets/apply-with-linkedin",
			"https://api.hcaptcha.com/checksiteconfig?v=58a2633848099317cef7deac21e607b1a41a5b9d&host=jobs.lever.co&sitekey=e33f87f8-88ec-4e1a-9a13-df9bbb1d8120&sc=1&swa=1&spst=1",
			"https://www.recaptcha.net/recaptcha/enterprise/anchor?ar=1&k=6LdQ&co=aHR0cHM6Ly9qb2ItYm9hcmRzLmdyZWVuaG91c2UuaW86NDQz&hl=en&v=gYdqkxiddE5aXrugNbBbKgtN&size=invisible&cb=mark",
			"https://www.googletagmanager.com/gtag/js?id=",
			"https://cdn.lever.co/fonts/linkedin.woff2",
			"https://jobs.lever.co/searchLocations?text=Ankara",
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

import { describe, expect, it } from "vitest";
import { formTargetFor } from "../src/apply/form-target";
import {
	HANDOFF_SOURCES,
	submissionModeAfterRead,
	submissionModeForSource,
} from "../src/apply/modes";
import { hostMatches } from "../src/apply/network-guard";
import {
	sameSite,
	siteOfHost,
	webFormHosts,
	webReadHosts,
	webSessionHosts,
} from "../src/apply/web-hosts";

/** Plan step 6: the board from the apply link, and an employer's own form as the "web" board. */

const job = (source: string, url: string, applyUrl: string | null = null) => ({
	source,
	url,
	applyUrl,
	externalId: "job-1",
	companyKey: "acme-robotics",
});

const GH = "https://job-boards.greenhouse.io/acmerobotics/jobs/4012345";
const LEVER =
	"https://jobs.lever.co/acme/0f8c2b6e-1d2a-4a9b-9c1e-2b3c4d5e6f70/apply";

describe("which form a job is filled on", () => {
	it("keeps the board a board source names", () => {
		expect(formTargetFor(job("greenhouse", GH))).toMatchObject({
			board: "greenhouse",
			from: "source",
			companyKey: "acme-robotics",
			externalId: "job-1",
		});
	});

	it("reads a known board from a LinkedIn job's employer link, with that posting's keys", () => {
		const target = formTargetFor(
			job("linkedin", "https://www.linkedin.com/jobs/view/123", GH),
		);
		expect(target).toMatchObject({
			board: "greenhouse",
			from: "url",
			url: GH,
			companyKey: "acmerobotics",
			externalId: "4012345",
		});
		expect(
			submissionModeForSource("linkedin", target.board, target.from),
		).toEqual({ mode: "auto", reason: "" });
	});

	it("reads a known board from a web or feed job's own link", () => {
		expect(formTargetFor(job("web", LEVER))).toMatchObject({
			board: "lever",
			from: "url",
			companyKey: "acme",
			externalId: "0f8c2b6e-1d2a-4a9b-9c1e-2b3c4d5e6f70",
		});
		expect(
			formTargetFor(
				job("remotive", "https://remotive.com/remote-jobs/x/1", GH),
			),
		).toMatchObject({ board: "greenhouse", from: "url" });
	});

	it("makes any other employer link the web board", () => {
		const url = "https://careers.acme-robotics.example/jobs/42/apply";
		for (const source of ["web", "hackernews", "scrape"]) {
			const target = formTargetFor(
				job(source, "https://elsewhere.test/x", url),
			);
			expect(target).toMatchObject({ board: "web", from: "url", url });
			expect(
				submissionModeForSource(source, target.board, target.from).mode,
			).toBe("auto");
		}
	});

	it("never fills LinkedIn, Indeed or Glassdoor's own page", () => {
		for (const source of ["linkedin", "indeed", "glassdoor"]) {
			const target = formTargetFor(
				job(source, "https://careers.acme-robotics.example/jobs/42"),
			);
			expect(target.board).toBeNull();
			expect(
				submissionModeForSource(source, target.board, target.from),
			).toEqual({ mode: "handoff", reason: HANDOFF_SOURCES[source] });
		}
	});

	it("keeps manual, sample and SmartRecruiters jobs hand-off, whatever their links", () => {
		for (const source of ["manual", "sample", "smartrecruiters"]) {
			const target = formTargetFor(job(source, GH, GH));
			expect(target.board).toBeNull();
			expect(
				submissionModeForSource(source, target.board, target.from).mode,
			).toBe("handoff");
		}
		// Even a context that claims a board from the link stays hand-off for these sources.
		expect(submissionModeForSource("manual", "greenhouse", "url").mode).toBe(
			"handoff",
		);
	});

	it("hands off links that are no fillable form, saying why", () => {
		const cases: [string, RegExp][] = [
			[
				"https://jobs.smartrecruiters.com/Acme/123456789-engineer",
				/SmartRecruiters.*CAPTCHA/,
			],
			[
				"https://acme.wd1.myworkdayjobs.com/en-US/careers/job/42",
				/Workday.*account/,
			],
			["https://acme.taleo.net/careersection/jobdetail.ftl", /Taleo/],
			["https://jobs.lever.co/acme", /Lever but is not one of its postings/],
			["https://job-boards.eu.greenhouse.io/acme/jobs/4012345", /EU site/],
			["https://www.indeed.co.uk/viewjob?jk=1", /job site/],
			["https://news.ycombinator.com/item?id=1", /job site/],
		];
		for (const [link, why] of cases) {
			const target = formTargetFor(job("web", link));
			expect(target.board, link).toBeNull();
			expect(target.reason, link).toMatch(why);
			const mode = submissionModeForSource(
				"web",
				target.board,
				target.from,
				target.reason,
			);
			expect(mode.mode).toBe("handoff");
			expect(mode.reason).toContain(target.reason);
		}
		// A mail link or no link at all: the source's hand-off.
		expect(
			formTargetFor(job("hackernews", "mailto:jobs@acme.example")).board,
		).toBeNull();
		expect(
			formTargetFor(job("linkedin", "https://www.linkedin.com/jobs/view/1"))
				.board,
		).toBeNull();
	});

	it("a web form without a field list read before review is a hand-off", () => {
		const auto = submissionModeForSource("web", "web", "url");
		expect(auto.mode).toBe("auto");
		expect(submissionModeAfterRead(auto, "web", null).mode).toBe("handoff");
		const failed = submissionModeAfterRead(auto, "web", {
			status: "failed",
			board: "web",
			url: "https://careers.acme.example/apply",
			note: "The form could not be read before review: No application form.",
			readAt: "2026-11-09T00:00:00Z",
		});
		expect(failed).toMatchObject({
			mode: "handoff",
			reason: expect.stringMatching(/^The form could not be read/),
		});
		// Boards fill without a read, as before.
		expect(submissionModeAfterRead(auto, "greenhouse", null)).toBe(auto);
	});
});

describe("the generic host rule", () => {
	it("finds the registrable domain, never across a public or shared suffix", () => {
		expect(siteOfHost("jobs.acme.com")).toBe("acme.com");
		expect(siteOfHost("careers.eu.acme.co.uk")).toBe("acme.co.uk");
		expect(siteOfHost("acme.co.uk")).toBe("acme.co.uk");
		expect(siteOfHost("co.uk")).toBeNull();
		expect(siteOfHost("acme.github.io")).toBeNull();
		expect(siteOfHost("forms.acme.netlify.app")).toBeNull();
		expect(siteOfHost("127.0.0.1")).toBeNull();
		expect(siteOfHost("localhost")).toBeNull();
		expect(siteOfHost("[::1]")).toBeNull();
	});

	it("reads country suffixes from the public suffix list (Codex, 2026-11-09)", () => {
		expect(siteOfHost("jobs.acme.com.es")).toBe("acme.com.es");
		expect(siteOfHost("com.es")).toBeNull();
		expect(siteOfHost("jobs.acme.com.tr")).toBe("acme.com.tr");
		expect(siteOfHost("com.tr")).toBeNull();
		expect(siteOfHost("jobs.acme.co.uk")).toBe("acme.co.uk");
		expect(sameSite("jobs.acme.com.es", "other.com.es")).toBe(false);
		expect(sameSite("jobs.acme.com.es", "com.es")).toBe(false);
		expect(sameSite("jobs.acme.com.tr", "api.acme.com.tr")).toBe(true);
	});

	it("sends data only to the form's host and the same-site hosts its read saw, never a wildcard", () => {
		// Codex's case: a suffix the old built-in list lacked authorized `com.es` and `*.com.es`.
		expect(webFormHosts("https://jobs.acme.com.es/apply")).toEqual([
			"jobs.acme.com.es",
		]);
		expect(
			webFormHosts("https://jobs.acme.com.es/apply", [
				"api.acme.com.es",
				"com.es",
				"*.acme.com.es",
				"other.com.es",
				"acme.com.es.evil.test",
			]),
		).toEqual(["jobs.acme.com.es", "api.acme.com.es"]);
		expect(
			webFormHosts("https://careers.eu.acme.co.uk/apply", [
				"acme.co.uk",
				"a.b.acme.co.uk",
				"other.co.uk",
			]),
		).toEqual(["careers.eu.acme.co.uk", "acme.co.uk", "a.b.acme.co.uk"]);
		// A sibling subdomain the read never saw gets nothing.
		const hosts = webFormHosts("https://jobs.acme.com.tr/apply", [
			"apply.acme.com.tr",
		]);
		const on = (host: string) => hosts.some((h) => hostMatches(host, h));
		expect(on("apply.acme.com.tr")).toBe(true);
		expect(on("api.acme.com.tr")).toBe(false);
		expect(on("acme.com.tr")).toBe(false);
		expect(on("evil.com.tr")).toBe(false);
	});

	it("reads, sending nothing, across the form's own site", () => {
		expect(webReadHosts("https://careers.eu.acme.co.uk/apply")).toEqual([
			"careers.eu.acme.co.uk",
			"acme.co.uk",
			"*.acme.co.uk",
		]);
		expect(webReadHosts("https://jobs.acme.com.es/apply")).toEqual([
			"jobs.acme.com.es",
			"acme.com.es",
			"*.acme.com.es",
		]);
	});

	it("keeps a shared host, an IP or localhost to the exact host", () => {
		expect(webFormHosts("https://acme.github.io/jobs")).toEqual([
			"acme.github.io",
		]);
		expect(webFormHosts("http://127.0.0.1:4000/web/single")).toEqual([
			"127.0.0.1",
		]);
		expect(webFormHosts("http://localhost:4000/x")).toEqual(["localhost"]);
		expect(sameSite("127.0.0.1", "localhost")).toBe(false);
		expect(sameSite("jobs.acme.com", "apply.acme.com")).toBe(true);
		expect(sameSite("a.github.io", "b.github.io")).toBe(false);
	});

	it("only reads from the public asset hosts", () => {
		const { form, rules } = webSessionHosts("https://jobs.acme.com/apply", [
			"api.acme.com",
		]);
		expect(form).toEqual(["jobs.acme.com", "api.acme.com"]);
		expect(rules.assets).toContain("fonts.gstatic.com");
		for (const host of rules.assets) expect(host.startsWith("*.")).toBe(false);
		expect(rules.widgets ?? []).toEqual([]);
	});
});

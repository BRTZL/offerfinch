import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { detectLinkedInStop } from "../src/linkedin/detect";
import { parseJobView, parseSearchResults } from "../src/linkedin/parse";
import { detectSiteStop, readJobPage, readSearchPage } from "../src/sites/read";
import { SITES } from "../src/sites/sites";

/**
 * The readers against the live sites' markup: `real-*` fixtures were taken from Indeed (signed
 * in), Glassdoor (signed out) and LinkedIn (signed in) on 2026-11-02 and cut down to the parts
 * the readers use, with no account data (see the privacy check at the end).
 */
const DIR = path.join(import.meta.dirname, "fixtures/sites");
const fixture = (name: string) => fs.readFileSync(path.join(DIR, name), "utf8");
const at = (url: string, name: string) => ({
	url,
	status: 200,
	html: fixture(name),
});

describe("Indeed, live markup", () => {
	it("reads the cards of a search page (titles are in an <h3> now)", () => {
		expect(
			readSearchPage(fixture("real-indeed-search.html"), SITES.indeed),
		).toEqual({
			cards: [
				{
					jobId: "42e93ddc471d0c03",
					title: "Lead Front End Developer",
					company: "Lateral Insights LLC",
					location: "Remote in Great Falls, VA 22066",
				},
				{
					jobId: "038a4ee34e48f446",
					title: "Senior Frontend Engineer",
					company: "Yobitel Communications",
					location: "Remote",
				},
				{
					jobId: "859f1a34950596d2",
					title: "Front-End Angular Developer (AWS/Python)",
					company: "TBM Inc",
					location: "Remote",
				},
			],
		});
	});

	it("does not take reCAPTCHA's invisible badge on every page for a check", () => {
		const page = at(
			"https://www.indeed.com/jobs?q=x",
			"real-indeed-search.html",
		);
		expect(page.html).toContain("grecaptcha-badge");
		expect(detectSiteStop(page, SITES.indeed)).toBeNull();
		// A visible challenge still is one.
		expect(
			detectSiteStop(
				{
					...page,
					html: '<html><body><iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor?size=normal"></iframe></body></html>',
				},
				SITES.indeed,
			)?.kind,
		).toBe("captcha");
	});

	it("reads the newer job page layout", () => {
		const page = at(
			"https://tr.indeed.com/viewjob?jk=42e93ddc471d0c03",
			"real-indeed-job.html",
		);
		expect(detectSiteStop(page, SITES.indeed)).toBeNull();
		const job = readJobPage(page.html, SITES.indeed);
		expect(job).toMatchObject({ title: "Lead Front End Developer" });
		expect("description" in job && job.description).toMatch(
			/^\*\*Role: Lead Front End Developer/,
		);
	});
});

describe("Glassdoor, live markup (signed out)", () => {
	it("reads the cards, whose job id is on the card itself", () => {
		const read = readSearchPage(
			fixture("real-glassdoor-search.html"),
			SITES.glassdoor,
		);
		expect("cards" in read && read.cards.map((c) => c.jobId)).toEqual([
			"1010300348112",
			"1010307414236",
			"1010216203126",
		]);
		expect("cards" in read && read.cards[0]).toEqual({
			jobId: "1010300348112",
			title: "Frontend Engineer",
			company: "IQware",
			location: "Remote",
		});
	});

	it("is not refused because its scripts carry a 'Too many requests' message", () => {
		for (const name of [
			"real-glassdoor-search.html",
			"real-glassdoor-job.html",
		]) {
			const page = at("https://www.glassdoor.com/Job/jobs.htm", name);
			expect(page.html).toContain("Too many requests. Try again in an hour.");
			expect(detectSiteStop(page, SITES.glassdoor)).toBeNull();
		}
		// The same words shown on the page are a refusal.
		expect(
			detectSiteStop(
				{
					url: "https://www.glassdoor.com/Job/jobs.htm",
					status: 200,
					html: "<html><body><h1>Too many requests</h1></body></html>",
				},
				SITES.glassdoor,
			)?.kind,
		).toBe("blocked");
	});

	it("reads the job's own title, not a similar job's", () => {
		const job = readJobPage(
			fixture("real-glassdoor-job.html"),
			SITES.glassdoor,
		);
		expect(job).toMatchObject({ title: "Frontend Engineer" });
		expect("description" in job && job.description).toContain("Fullsteam");
	});

	it("still sees a Cloudflare check by the scripts it loads", () => {
		expect(
			detectSiteStop(
				{
					url: "https://www.glassdoor.com/Job/jobs.htm",
					status: 200,
					html: '<html><head><title>Just a moment...</title><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></head><body></body></html>',
				},
				SITES.glassdoor,
			)?.kind,
		).toBe("security_check");
	});
});

describe("LinkedIn, live markup (server-driven layout)", () => {
	it("reads each card's id once, from its component key", () => {
		const page = at(
			"https://www.linkedin.com/jobs/search-results/?keywords=Frontend%20Engineer",
			"real-linkedin-search.html",
		);
		expect(detectLinkedInStop(page, "www.linkedin.com")).toBeNull();
		expect(parseSearchResults(page.html)).toEqual([
			{
				jobId: "4481892756",
				title: "Senior React Native Engineer (Mobile) - Remote",
				company: "",
				location: "",
			},
			{
				jobId: "4484441694",
				title: "Starszy Programista Frontend (Angular)",
				company: "",
				location: "",
			},
			{
				jobId: "4452483787",
				title: "Senior Frontend Engineer (Full-stack)",
				company: "",
				location: "",
			},
		]);
	});

	it("reads a job view: title, company, location, chips and the employer's link", () => {
		const url = "https://www.linkedin.com/jobs/view/4481892756/";
		const page = at(url, "real-linkedin-job.html");
		expect(detectLinkedInStop(page, "www.linkedin.com")).toBeNull();
		const listing = parseJobView(page.html, url, "4481892756");
		expect(listing).toMatchObject({
			jobId: "4481892756",
			title: "Senior React Native Engineer (Mobile) - Remote",
			company: "Kake",
			locations: ["Cracow, Małopolskie, Poland"],
			workplaceType: "remote",
			employmentType: "Contract",
			easyApply: false,
			externalApplyUrl:
				"https://kake.co/jobs/senior-react-native-engineer-mobile-a05cc19ec941",
		});
		expect(listing.descriptionText).toContain("React Native");
		// LinkedIn's "… more" control is not part of the posting.
		expect(listing.descriptionText).not.toMatch(/…\s*more\s*$/);
	});

	it("stops and names the selector when the server-driven layout changes", () => {
		const html = fixture("real-linkedin-job.html").replaceAll(
			'data-testid="expandable-text-box"',
			'data-testid="something-else"',
		);
		expect(() =>
			parseJobView(html, "https://www.linkedin.com/jobs/view/1/", "1"),
		).toThrow(/"sduiJobDescription"/);
		const search = fixture("real-linkedin-search.html").replaceAll(
			"job-card-component-ref-",
			"job-tile-",
		);
		expect(() => parseSearchResults(search)).toThrow(/"sduiCard"/);
	});
});

describe("Cloudflare's check, served with HTTP 403 (live pages)", () => {
	it("is a check the user solves, not a refusal, on Indeed and Glassdoor", () => {
		expect(
			detectSiteStop(
				{
					url: "https://www.indeed.com/viewjob?jk=42e93ddc471d0c03",
					status: 403,
					html: fixture("real-indeed-cloudflare.html"),
				},
				SITES.indeed,
			)?.kind,
		).toBe("security_check");
		expect(
			detectSiteStop(
				{
					url: "https://www.glassdoor.com/job-listing/index.htm?jl=1",
					status: 403,
					html: fixture("real-glassdoor-cloudflare.html"),
				},
				SITES.glassdoor,
			)?.kind,
		).toBe("security_check");
		// A bare 403 is still a refusal.
		expect(
			detectSiteStop(
				{
					url: "https://www.indeed.com/jobs",
					status: 403,
					html: "<html></html>",
				},
				SITES.indeed,
			)?.kind,
		).toBe("blocked");
	});
});

describe("the real-page fixtures", () => {
	it("hold no account data: no email address, no account menu", () => {
		for (const name of fs.readdirSync(DIR)) {
			const html = fixture(name);
			expect(html, name).not.toMatch(
				/[\w.%+-]+@[\w-]+\.(?:com|net|org|io|co|de|pl|tr)\b/i,
			);
			expect(html, name).not.toMatch(
				/meMenu|Sign out|my-profile|\/in\/[\w-]+/i,
			);
		}
	});
});

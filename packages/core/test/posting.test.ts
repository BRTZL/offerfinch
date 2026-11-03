import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { FakeLlmProvider } from "../src/scoring/fake";
import {
	extractPostingWithLlm,
	readPostingPage,
} from "../src/scrape/llm-extract";
import {
	cleanPostingText,
	htmlToMarkdown,
	linesFromSource,
	looksLikeRawPage,
	postingFromJsonLd,
	postingFromMainContent,
} from "../src/scrape/posting";

const fixture = (name: string) =>
	fs.readFileSync(
		path.join(import.meta.dirname, "fixtures/posting", name),
		"utf8",
	);

/** Text a page has around the posting that must never be stored. */
const FURNITURE = [
	"DOCTYPE",
	"<",
	"Jump to content",
	"JUMP TO CONTENT",
	"cookies",
	"Cookie settings",
	"Our Jobs",
	"Saved jobs",
	"Shortlist",
	"Search",
	"Teams",
	"Share on LinkedIn",
	"Similar jobs",
	"Data Analyst",
	"Get job alerts",
	"Imprint",
	"Privacy",
	"logo",
	"Apply now",
	"window.dataLayer",
	"color:red",
];

describe("a posting page, read without the model", () => {
	it("1. uses schema.org JobPosting: fields and the description as Markdown", () => {
		const posting = postingFromJsonLd(fixture("jsonld.html"));
		expect(posting).toMatchObject({
			title: "Backend Engineer II",
			company: "Northwind Foods",
			location: "Lisbon, Portugal",
			employmentType: "FULL_TIME",
			via: "json-ld",
		});
		expect(posting?.datePosted?.toISOString().slice(0, 10)).toBe("2026-10-20");
		expect(posting?.description).toBe(
			[
				"## About the role",
				"",
				"You will build the services that move **groceries** from store to door.",
				"",
				"## Requirements",
				"",
				"- 3+ years of Go or Java",
				"- Event-driven systems (Kafka)",
				"",
				"## What we offer",
				"",
				"- Hybrid work",
			].join("\n"),
		);
	});

	it("2. without JSON-LD, keeps the main content and drops nav, banners, search and footer", () => {
		const posting = postingFromMainContent(
			fixture("heavy-nav.html"),
			"https://careers.harbor-mills.example/jobs/42",
		);
		expect(posting).toMatchObject({
			title: "Frontend Engineer",
			company: "Harbor Mills",
			via: "readability",
		});
		const text = posting?.description ?? "";
		for (const word of FURNITURE) expect(text, word).not.toContain(word);
		expect(text).toContain("## About the role");
		expect(text).toContain(
			"Harbor Mills makes billing software for small shops.",
		);
		expect(text).toContain("## Requirements");
		expect(text).toContain("- 4+ years of **React** and TypeScript");
		expect(text).toContain("- Comfortable writing tests: *Vitest*, Playwright");
		expect(text).toContain("1. A yearly learning budget");
		expect(text).toContain("2. Four days in the office, one at home");
	});

	it("prefers the element the page labels as the job description over a wider wrapper", () => {
		const body = "Requirements: three years of Go. ".repeat(12);
		const html = `<!doctype html><html><head><title>Go Engineer | Kiln</title><meta property="og:site_name" content="Kiln"></head><body>
<div class="job-details-widget"><h2>This vacancy has expired</h2><p>${"Other roles you may like. ".repeat(20)}</p>
<div aria-label="Job description"><p><strong>Role</strong></p><p>${body}</p></div></div></body></html>`;
		const posting = postingFromMainContent(html, "https://kiln.example/jobs/1");
		expect(posting?.title).toBe("Go Engineer");
		expect(posting?.description.startsWith("**Role**")).toBe(true);
		expect(posting?.description).not.toMatch(/expired|Other roles/);
	});

	it("reads both pages in order with no model call", async () => {
		const llm = new FakeLlmProvider();
		const a = await readPostingPage(
			fixture("jsonld.html"),
			"https://jobs.northwind.example/backend",
			llm,
		);
		const b = await readPostingPage(
			fixture("heavy-nav.html"),
			"https://careers.harbor-mills.example/jobs/42",
			llm,
		);
		expect(a?.via).toBe("json-ld");
		expect(b?.via).toBe("readability");
		expect(llm.calls).toHaveLength(0);
	});
});

describe("the model, as a last resort", () => {
	const page = `<!doctype html><html><head><title>Careers</title></head><body>
<div>Menu</div><div>Welcome to our careers corner</div>
<div><b>Site Reliability Engineer</b></div>
<div>Tern Labs is hiring at our Oslo office.</div>
<div>Requirements: Linux, on-call experience, Terraform.</div>
<div>Responsibilities: keep the platform up, automate the rest.</div>
<div>Our offices · Our values · Contact</div></body></html>`;

	it("only picks lines and fields: the description is verbatim, invented fields are dropped", async () => {
		const llm = new FakeLlmProvider({
			"extract-posting": (req) => {
				const lines = (req.context as { lines: string[] }).lines;
				return {
					isPosting: true,
					title: "Site Reliability Engineer",
					company: "Tern Labs",
					location: "Oslo, Norway", // not in the text: dropped
					firstLine: lines.indexOf("**Site Reliability Engineer**") + 1,
					lastLine:
						lines.findIndex((l) => l.startsWith("Responsibilities")) + 1,
				};
			},
		});
		const posting = await extractPostingWithLlm(
			llm,
			page,
			"https://tern.example/jobs/sre",
		);
		expect(posting).toMatchObject({
			title: "Site Reliability Engineer",
			company: "Tern Labs",
			location: "",
			via: "ai",
		});
		expect(posting?.description).not.toMatch(/Menu|Welcome|Our offices/);
		expect(
			linesFromSource(posting?.description ?? "", htmlToMarkdown(page)),
		).toBe(true);
	});

	it("refuses a title the text does not contain", async () => {
		const llm = new FakeLlmProvider({
			"extract-posting": () => ({
				isPosting: true,
				title: "Senior Staff Wizard",
				company: "",
				location: "",
				firstLine: 1,
				lastLine: 99,
			}),
		});
		expect(
			await extractPostingWithLlm(llm, page, "https://tern.example/jobs/sre"),
		).toBeNull();
	});

	it("the verbatim check fails on a line the source never had", () => {
		expect(linesFromSource("Requirements: Linux", "Requirements: Linux")).toBe(
			true,
		);
		expect(
			linesFromSource(
				"Requirements: Linux\nA great place to work!",
				"Requirements: Linux",
			),
		).toBe(false);
	});
});

describe("pasted text and stored text", () => {
	it("cleans a messy paste the same way: furniture out, bullets and spacing regular", () => {
		expect(cleanPostingText(fixture("messy-paste.txt"))).toBe(
			[
				"Platform Engineer",
				"",
				"Quarry Systems · Berlin",
				"",
				"About the job",
				"We are hiring a platform engineer to run our build and deploy tooling. It is on-site in Berlin.",
				"",
				"Requirements:",
				"- Go and Kubernetes",
				"- Five years of backend work",
				"  - Terraform (nice to have)",
				"1. Relocation is not offered",
			].join("\n"),
		);
	});

	it("turns pasted HTML into Markdown, never storing tags or a doctype", () => {
		const text = cleanPostingText(
			"<!DOCTYPE html><html><body><nav>Our Jobs</nav><h2>Role</h2><p>Build things.</p><ul><li>Go</li></ul></body></html>",
		);
		expect(text).toBe("## Role\n\nBuild things.\n\n- Go");
	});

	it("knows a stored whole page from a posting", () => {
		expect(
			looksLikeRawPage(
				"<!DOCTYPE html>\n\nSoftware Engineer II\n\nThis website uses cookies...\nJUMP TO CONTENT",
			),
		).toBe(true);
		expect(looksLikeRawPage("## About the role\n\nYou will build.")).toBe(
			false,
		);
	});
});

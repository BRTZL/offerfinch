import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { diagnosticDom, redact } from "../src/sites/debug";
import { readSearchPage } from "../src/sites/read";
import { SITES } from "../src/sites/sites";

describe("the page kept for diagnosis", () => {
	const page = `<html><head><meta name="csrf-token" content="PRIVATE_CSRF"><script>PRIVATE_SCRIPT</script><link rel="preload" href="/x?sig=PRIVATE_LINK"></head><body>
		<header>Signed in as Sam Rivera</header>
		<div class="avatar" title="Sam Rivera"><span title="Engineer">Engineer</span></div>
		<nav aria-label="Primary">Me · Sam Rivera</nav>
		<div id="meMenuV2WideComponentRef">Sam Rivera</div>
		<form><input type="hidden" name="session_token" value="PRIVATE_SESSION"><textarea>PRIVATE_DRAFT</textarea><select><option>PRIVATE_OPTION</option></select></form>
		<iframe src="https://x/?t=PRIVATE_FRAME"></iframe>
		<main data-testid="results" onclick="PRIVATE_HANDLER" style="PRIVATE_STYLE" data-token="PRIVATE_DATA">
			<a href="mailto:sam&#64;example.test">mail</a>
			<a href="tel:+15550100199">call</a>
			<a href="/rc/clk?jk=abc&amp;token=PRIVATE_URL#PRIVATE_FRAGMENT" data-jk="abc">Engineer</a>
			<p aria-label="Contact sam@example.test">Write to sam&#64;example.test or call +1 (555) 010-0199. Posted 2026-11-02, salary 120,000.</p>
		</main></body></html>`;

	it("keeps no token, form value, account name, email or phone, entity-encoded or not", () => {
		const kept = diagnosticDom(page);
		for (const secret of [
			"PRIVATE",
			"Sam Rivera",
			"sam@example.test",
			"sam&#64;example.test",
			"555",
			"mailto:",
			"tel:",
		])
			expect(kept, secret).not.toContain(secret);
	});

	it("keeps the structure and hooks a reader's selectors need", () => {
		const kept = diagnosticDom(page);
		expect(kept).toContain('<main data-testid="results">');
		expect(kept).toContain('<a href="/rc/clk" data-jk="abc">Engineer</a>');
		expect(kept).toContain('<span title="Engineer">Engineer</span>');
		expect(kept).toContain("Posted 2026-11-02, salary 120,000.");
		// A real page, cut down, still reads the same.
		const real = fs.readFileSync(
			path.join(import.meta.dirname, "fixtures/sites/real-indeed-search.html"),
			"utf8",
		);
		expect(readSearchPage(diagnosticDom(real), SITES.indeed)).toEqual(
			readSearchPage(real, SITES.indeed),
		);
	});

	it("blanks emails and phone numbers in text, not dates or amounts", () => {
		expect(redact("a.b+c@mail.example.co.uk or +48 555 010 199")).toBe(
			"[email] or [phone]",
		);
		expect(redact("Posted 2026-11-02 · 120,000 · job 1010300348112")).toBe(
			"Posted 2026-11-02 · 120,000 · job 1010300348112",
		);
	});

	// A million paragraphs on purpose: about 1 s alone, several under a loaded machine (CI, parallel
	// suites), hence its own time limit rather than the default 5 s.
	it("reads a bounded part of a huge page", { timeout: 30_000 }, () => {
		const huge = `<main>${"<p>x</p>".repeat(1_000_000)}</main>`;
		expect(diagnosticDom(huge).length).toBeLessThan(5 * 1024 * 1024);
	});
});

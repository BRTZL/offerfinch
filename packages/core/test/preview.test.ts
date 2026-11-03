import { describe, expect, it } from "vitest";

import { markdownToPreviewHtml } from "../src/export/render";

/**
 * The review pane showed raw Markdown (`#`, `*`). It now renders the document the way the export
 * does, with the export's sanitizing (no raw HTML, no images, only http, mailto and tel links),
 * and marks flagged lines inside the rendered text.
 */
describe("rendered preview", () => {
	const CV = `# Ada Example

## Experience

### Senior Engineer — Brightloom
*Remote · Jan 2023 – Oct 2025*

- **Built** payment services.
- Fixed slow queries.`;

	it("renders Markdown as the export does", () => {
		const html = markdownToPreviewHtml(CV);
		expect(html).toContain("<h1>Ada Example</h1>");
		expect(html).toContain("<h3>Senior Engineer — Brightloom</h3>");
		expect(html).toContain("<em>Remote · Jan 2023 – Oct 2025</em>");
		expect(html).toContain("<li><strong>Built</strong> payment services.</li>");
		expect(html).not.toMatch(/(^|\n)#|\*\*/);
	});

	it("drops raw HTML, images, scripts and unsafe links", () => {
		const html = markdownToPreviewHtml(
			[
				"Hello <script>alert(1)</script> there.",
				'<img src="https://evil.example/x.png" onerror="alert(2)">',
				"![tracker](https://evil.example/pixel.png)",
				"[click](javascript:alert(3)) and [data](data:text/html;base64,PHNjcmlwdD4=)",
				"[site](https://ada.example) <iframe src=https://evil.example></iframe>",
			].join("\n\n"),
		);
		expect(html).not.toMatch(
			/<script|<img|<iframe|onerror|javascript:|data:text/i,
		);
		expect(html).toContain('<a href="https://ada.example">site</a>');
		expect(html).toContain("click");
	});

	it("marks flagged spans, open and confirmed, with their number and reasons", () => {
		const start = CV.indexOf("Fixed slow queries.");
		const bold = CV.indexOf("**Built** payment services.");
		const html = markdownToPreviewHtml(CV, [
			{
				id: "cv-1",
				n: 1,
				start,
				end: start + "Fixed slow queries.".length,
				open: true,
				title: 'Not tied to the profile <"x">',
			},
			{
				id: "cv-2",
				n: 2,
				start: bold,
				end: bold + "**Built** payment services.".length,
				open: false,
				title: "Confirmed",
			},
		]);
		expect(html).toContain(
			'<li><a href="#flag-cv-1" data-testid="flag-mark" data-flag-state="open" title="Not tied to the profile &lt;&quot;x&quot;&gt;"><sup>1</sup>Fixed slow queries.</a></li>',
		);
		expect(html).toContain(
			'<a href="#flag-cv-2" data-testid="flag-mark" data-flag-state="confirmed" title="Confirmed"><sup>2</sup><strong>Built</strong> payment services.</a>',
		);
		expect(html).not.toMatch(/[-]/u);
	});
});

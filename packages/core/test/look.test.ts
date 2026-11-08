import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
	ACCENTS,
	DEFAULT_LOOK,
	type DocumentLook,
	documentLookSchema,
	lookSlug,
} from "../src/export/look";
import { PRINT_CSS, printCss } from "../src/export/print-css";
import { markdownToDocx, markdownToHtml } from "../src/export/render";

/** The skill's stylesheet as it was before looks existed. */
const SKILL_CSS = readFileSync(
	join(import.meta.dirname, "fixtures/print-classic.css"),
	"utf8",
);

/** One file of a zip (DOCX), read with zlib: stored or deflated entries. */
function zipEntry(zip: Uint8Array, name: string): string {
	const buf = Buffer.from(zip);
	let at = 0;
	while (buf.readUInt32LE(at) === 0x04034b50) {
		const method = buf.readUInt16LE(at + 8);
		const size = buf.readUInt32LE(at + 18);
		const nameLength = buf.readUInt16LE(at + 26);
		const extra = buf.readUInt16LE(at + 28);
		const entry = buf.toString("utf8", at + 30, at + 30 + nameLength);
		const start = at + 30 + nameLength + extra;
		const data = buf.subarray(start, start + size);
		if (entry === name)
			return (method === 8 ? inflateRawSync(data) : data).toString("utf8");
		at = start + size;
	}
	throw new Error(`${name} not in the zip`);
}

/** WCAG contrast of a hex color on white. */
function contrastOnWhite(hex: string): number {
	const channel = (i: number) => {
		const c = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	const l = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
	return 1.05 / (l + 0.05);
}

describe("document look settings", () => {
	it("fills every missing field with its default", () => {
		expect(documentLookSchema.parse({})).toEqual(DEFAULT_LOOK);
		expect(documentLookSchema.parse({ template: "modern" })).toEqual({
			...DEFAULT_LOOK,
			template: "modern",
		});
	});

	it("refuses values outside the lists", () => {
		expect(documentLookSchema.safeParse({ font: "Comic Sans" }).success).toBe(
			false,
		);
		expect(documentLookSchema.safeParse({ pageSize: "A5" }).success).toBe(
			false,
		);
	});

	it("keeps every accent dark enough for print", () => {
		for (const accent of Object.values(ACCENTS))
			expect(contrastOnWhite(accent.hex)).toBeGreaterThanOrEqual(7);
	});

	it("names a look in file names only when it is not the default", () => {
		expect(lookSlug(DEFAULT_LOOK)).toBe("");
		expect(
			lookSlug({
				template: "modern",
				font: "georgia",
				accent: "navy",
				pageSize: "Letter",
			}),
		).toBe("-modern-georgia-navy-letter");
	});
});

describe("print stylesheets", () => {
	it("prints the default look with the skill's stylesheet, unchanged", () => {
		expect(PRINT_CSS).toBe(SKILL_CSS);
		expect(printCss()).toBe(SKILL_CSS);
		expect(markdownToHtml("# Ada", "Ada CV")).toContain(SKILL_CSS);
	});

	it("sets the page size, the font and the accent", () => {
		const css = printCss({
			template: "classic",
			font: "georgia",
			accent: "navy",
			pageSize: "Letter",
		});
		expect(css).toContain("size: Letter;");
		expect(css).toContain("font-family: Georgia,");
		expect(css).toContain(`color: ${ACCENTS.navy.hex};`);
		expect(css).toContain("font-variant-ligatures: none;");
	});

	it("keeps ligatures off and headings tracked no wider than classic in every template", () => {
		for (const template of ["classic", "modern", "compact"] as const) {
			const css = printCss({ ...DEFAULT_LOOK, template });
			expect(css).toContain("font-variant-ligatures: none;");
			for (const [, em] of css.matchAll(/letter-spacing: ([\d.]+)em/g))
				expect(Number(em)).toBeLessThanOrEqual(0.06);
			// One column of text: no layout that could change the reading order.
			expect(css).not.toMatch(
				/display:\s*(flex|grid)|float:|position:|columns?:|order:/,
			);
		}
	});

	it("draws the page on screen for the preview: its size and margins, no @page", () => {
		const css = printCss(
			{ ...DEFAULT_LOOK, template: "compact", pageSize: "Letter" },
			".sheet",
		);
		expect(css).not.toContain("@page");
		expect(css).toContain("width: 215.9mm;");
		expect(css).toContain("padding: 10mm 13mm;");
		expect(css).toContain(".sheet > div {");
	});
});

describe("Word documents in a look", () => {
	const md =
		"# Ada Example\n\nada@example.test\n\n## Experience\n\n- Built things.";

	it("uses the page size, the font and the accent on headings", async () => {
		const look: DocumentLook = {
			template: "modern",
			font: "charter",
			accent: "burgundy",
			pageSize: "Letter",
		};
		const docx = await markdownToDocx(md, look);
		const document = zipEntry(docx, "word/document.xml");
		const styles = zipEntry(docx, "word/styles.xml");
		expect(document).toMatch(/<w:pgSz w:w="12240" w:h="15840"/);
		expect(styles).toContain('w:ascii="Georgia"');
		// Headings 1 to 4 (all a Markdown document makes) in the accent, none in Word's blue.
		for (const level of [1, 2, 3, 4])
			expect(styles).toMatch(
				new RegExp(
					`w:styleId="Heading${level}">(?:(?!</w:style>).)*w:color w:val="${ACCENTS.burgundy.hex.slice(1)}"`,
				),
			);
	});

	it("is A4 in Arial by default", async () => {
		const docx = await markdownToDocx(md);
		expect(zipEntry(docx, "word/document.xml")).toMatch(
			/<w:pgSz w:w="11906" w:h="16838"/,
		);
		expect(zipEntry(docx, "word/styles.xml")).toContain('w:ascii="Arial"');
	});
});

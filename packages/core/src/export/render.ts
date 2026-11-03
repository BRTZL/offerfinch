import { Marked } from "marked";

import { PRINT_CSS } from "./print-css";

/**
 * Markdown to the two submission formats, in plain JS so it runs on Workers: HTML (printed to
 * PDF by the browser) and DOCX. Mirrors the skill's pandoc + headless Chrome export.
 */

/** Link targets kept in the HTML; anything else renders as plain text. */
const SAFE_HREF = /^(https?:|mailto:|tel:)/i;

/**
 * The Markdown is model-written from a posting, so it is untrusted: images and raw HTML are
 * dropped (an image URL would leak data when printed), and only http, mailto and tel links stay.
 */
const marked = new Marked({
	gfm: true,
	breaks: false,
	renderer: {
		image: () => "",
		html: () => "",
		link({ href, tokens }) {
			const text = this.parser.parseInline(tokens);
			// Preview marks never belong in a URL.
			const target = href.replace(MARKS, "").trim();
			return SAFE_HREF.test(target)
				? `<a href="${escapeHtml(target).replace(/"/g, "&quot;")}">${text}</a>`
				: text;
		},
	},
});

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/* --------------------------------------------------------------- preview */

/** Private-use characters standing for a mark's start (with its index) and end while rendering. */
const OPEN = "\uE010";
const CLOSE = "\uE011";
const FIRST_INDEX = 0xe100;
const MARKS = /[\uE010\uE011\uE100-\uE8FF]/gu;

/** A flagged span of the Markdown source, marked in the rendered preview. */
export interface PreviewMark {
	id: string;
	/** The flag's number in reading order. */
	n: number;
	start: number;
	end: number;
	open: boolean;
	/** The reasons, as a tooltip. */
	title: string;
}

/**
 * The document as the export renders it (the same sanitizing: no raw HTML, no images, only http,
 * mailto and tel links), for the review pane, with each flagged span wrapped in a link to its
 * flag. The spans are marked in the source before rendering, so a mark follows its text into
 * lists, headings and emphasis.
 */
export function markdownToPreviewHtml(
	markdown: string,
	marks: PreviewMark[] = [],
): string {
	const clean = markdown.replace(MARKS, "");
	const usable = marks
		.slice(0, 0x700)
		.map((mark, index) => ({ mark, index }))
		.filter(
			({ mark }) =>
				mark.start >= 0 && mark.end > mark.start && mark.end <= clean.length,
		)
		.sort((a, b) => b.mark.start - a.mark.start);
	let source = clean;
	let floor = clean.length + 1;
	for (const { mark, index } of usable) {
		// Overlapping spans: the later one wins, the earlier is left unmarked.
		if (mark.end > floor) continue;
		source = `${source.slice(0, mark.start)}${OPEN}${String.fromCharCode(FIRST_INDEX + index)}${source.slice(mark.start, mark.end)}${CLOSE}${source.slice(mark.end)}`;
		floor = mark.start;
	}
	const html = marked.parse(source, { async: false });
	return html
		.replace(/\uE010([\uE100-\uE8FF])/gu, (_, code: string) => {
			const mark = marks[code.charCodeAt(0) - FIRST_INDEX];
			if (!mark) return "";
			const attr = (text: string) => escapeHtml(text).replace(/"/g, "&quot;");
			return `<a href="#flag-${attr(mark.id)}" data-testid="flag-mark" data-flag-state="${mark.open ? "open" : "confirmed"}" title="${attr(mark.title)}"><sup>${mark.n}</sup>`;
		})
		.replace(/\uE011/gu, "</a>")
		.replace(MARKS, "");
}

export function markdownToHtml(markdown: string, title: string): string {
	const body = marked.parse(markdown, { async: false });
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}

/* ------------------------------------------------------------------ DOCX */

/**
 * Markdown to DOCX. The builder (and the `docx` library) loads on first use, so a process that
 * never exports a document never loads it.
 */
export async function markdownToDocx(markdown: string): Promise<Uint8Array> {
	const { buildDocx } = await import("./docx");
	return buildDocx(markdown);
}

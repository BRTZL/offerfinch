import { parse } from "node-html-parser";

/** Converts HTML (possibly entity-escaped, as Greenhouse returns it) to readable plain text. */
export function htmlToText(html: string): string {
	if (!html) return "";
	const decoded = /&lt;[a-z/]/i.test(html) ? decodeEntities(html) : html;
	const root = parse(decoded, {
		blockTextElements: { script: false, style: false },
	});
	for (const el of root.querySelectorAll("br")) el.replaceWith("\n");
	for (const el of root.querySelectorAll(
		"p, div, li, h1, h2, h3, h4, h5, h6, tr, section",
	)) {
		el.insertAdjacentHTML("afterend", "\n");
	}
	for (const el of root.querySelectorAll("li"))
		el.insertAdjacentHTML("afterbegin", "- ");
	return (
		decodeEntities(root.textContent)
			.replace(/ /g, " ")
			.replace(/[ \t]+/g, " ")
			.replace(/\n\s*\n\s*\n+/g, "\n\n")
			.split("\n")
			.map((line) => line.trim())
			.join("\n")
			// <li><p>text</p></li> leaves the bullet on its own line; join it to its text.
			.replace(/^- *\n+(?=\S)/gm, "- ")
			.trim()
	);
}

export function decodeEntities(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#(\d+);/g, (_, code: string) => codePoint(Number(code)))
		.replace(/&amp;/g, "&");
}

/**
 * A numeric character reference's character; one outside Unicode (or a lone surrogate) is the
 * replacement character, so a posting with a stray "&#99999999;" still reads (feeds, boards).
 */
export function codePoint(code: number): string {
	if (
		!Number.isInteger(code) ||
		code < 0 ||
		code > 0x10ffff ||
		(code >= 0xd800 && code <= 0xdfff)
	)
		return "\ufffd";
	return String.fromCodePoint(code);
}

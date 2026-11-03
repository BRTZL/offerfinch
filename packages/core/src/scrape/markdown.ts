import { type HTMLElement, type Node, NodeType, parse } from "node-html-parser";

import { decodeEntities } from "../domain/text";

/**
 * A job posting's text, cleaned for storage and display: Markdown with headings, lists and
 * paragraphs. Never a doctype, raw HTML, navigation, cookie banners or images. The words are
 * the posting's own: cleaning only drops page furniture and reformats.
 */

/** Elements that are never posting text. */
const DROP = new Set([
	"head",
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	"canvas",
	"img",
	"picture",
	"figure",
	"video",
	"audio",
	"iframe",
	"object",
	"embed",
	"form",
	"input",
	"button",
	"select",
	"textarea",
	"label",
	"nav",
	"header",
	"footer",
	"aside",
	"dialog",
	"meta",
	"link",
]);

const BLOCK = new Set([
	"p",
	"div",
	"section",
	"article",
	"main",
	"blockquote",
	"pre",
	"address",
	"dl",
	"dd",
	"dt",
	"table",
	"tbody",
	"thead",
	"body",
	"html",
	"center",
]);

/** Page chrome by its role, id or class: banners, cookie notices, menus, "skip to content". */
const CHROME_ROLE =
	/^(?:navigation|banner|contentinfo|search|dialog|alertdialog|menu|menubar)$/i;
export const CHROME_NAME =
	/(?:^|[-_\s])(?:cookie|cookies|consent|gdpr|onetrust|ot-sdk|cc-banner|skip(?:-to|link)|breadcrumbs?|navbar|site-nav|main-nav|menu|newsletter|social|share|modal|popup|toast)(?:$|[-_\s])/i;

function isChrome(el: HTMLElement): boolean {
	const role = el.getAttribute("role") ?? "";
	if (CHROME_ROLE.test(role)) return true;
	if (el.getAttribute("aria-hidden") === "true") return true;
	if (el.getAttribute("hidden") !== undefined) return true;
	const name = `${el.getAttribute("id") ?? ""} ${el.getAttribute("class") ?? ""}`;
	return CHROME_NAME.test(name);
}

const inlineText = (s: string) => s.replace(/\s+/g, " ");

/** HTML (a posting body, a board API's description, a whole page) as clean Markdown. */
export function htmlToMarkdown(html: string): string {
	if (!html) return "";
	// Board APIs send escaped HTML ("&lt;p&gt;"); unescape it once.
	const source = /&lt;[a-z/!]/i.test(html) ? decodeEntities(html) : html;
	const root = parse(
		source.replace(/<!doctype[^>]*>/gi, "").replace(/<\?xml[^>]*\?>/gi, ""),
		{ comment: false, blockTextElements: { pre: true } },
	);
	const out = render(root, 0);
	return cleanPostingText(out, { html: false });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep recursive HTML rendering cases together so node-type and depth fallbacks retain precedence.
function render(node: Node, depth: number): string {
	if (node.nodeType === NodeType.TEXT_NODE)
		return inlineText(decodeEntities(node.rawText));
	if (node.nodeType !== NodeType.ELEMENT_NODE) return "";
	const el = node as HTMLElement;
	const tag = (el.rawTagName ?? "").toLowerCase();
	if (DROP.has(tag)) return "";
	if (tag && isChrome(el)) return "";
	const inner = () => el.childNodes.map((c) => render(c, depth)).join("");
	if (/^h[1-6]$/.test(tag)) {
		const text = inlineText(inner()).trim();
		return text ? `\n\n${"#".repeat(Number(tag[1]))} ${text}\n\n` : "";
	}
	if (tag === "br") return "\n";
	if (tag === "hr") return "\n\n";
	if (tag === "ul" || tag === "ol") {
		let n = 0;
		const items = el.childNodes
			.filter(
				(c) =>
					c.nodeType === NodeType.ELEMENT_NODE &&
					((c as HTMLElement).rawTagName ?? "").toLowerCase() === "li",
			)
			.map((li) => {
				n += 1;
				const nested: string[] = [];
				const own = (li as HTMLElement).childNodes
					.map((c) => {
						const t = ((c as HTMLElement).rawTagName ?? "").toLowerCase();
						if (t === "ul" || t === "ol") {
							nested.push(render(c, depth + 1));
							return "";
						}
						return render(c, depth + 1);
					})
					.join("");
				const text = inlineText(own).trim();
				if (!text && nested.length === 0) return "";
				const marker = tag === "ol" ? `${n}.` : "-";
				const pad = "  ".repeat(depth);
				return `${text ? `${pad}${marker} ${text}` : ""}${nested.join("")}`;
			})
			.filter(Boolean);
		return items.length ? `\n${items.join("\n")}\n${depth ? "" : "\n"}` : "";
	}
	if (tag === "li") return `\n- ${inlineText(inner()).trim()}\n`;
	if (tag === "strong" || tag === "b") {
		const text = inner();
		return text.trim() ? ` **${text.trim()}** ` : text;
	}
	if (tag === "em" || tag === "i") {
		const text = inner();
		return text.trim() ? ` *${text.trim()}* ` : text;
	}
	if (tag === "tr")
		return `\n${el.childNodes
			.map((c) => inlineText(render(c, depth)).trim())
			.filter(Boolean)
			.join(" · ")}\n`;
	if (BLOCK.has(tag)) return `\n\n${inner()}\n\n`;
	return inner();
}

/** Short lines that are site furniture, not posting text. */
const FURNITURE =
	/^(?:jump to (?:main )?content|skip to (?:main )?content|skip navigation|search(?: jobs)?|saved jobs|shortlist(?: \d+)?|menu|close|open menu|back to (?:all )?(?:jobs|search(?: results)?)|apply(?: now| for this job)?|save(?: job)?|share(?: this job)?|print|log ?in|sign ?in|sign up|register|our jobs|\d+|×|☰)$/i;
const COOKIE =
	/\b(?:this (?:web)?site uses cookies|we use cookies|accept (?:all )?cookies|cookie (?:settings|preferences|policy)|manage (?:cookie )?preferences|reject all)\b/i;
const GLYPH_BULLET = /^[•·▪◦●○■□➢➤►▶✓✔•‣⁃∙]\s*/;

/**
 * Posting text, cleaned the same way wherever it comes from: a page, a board's API, or what the
 * user pasted. HTML is converted first; furniture lines (menus, "Jump to content", cookie
 * notices) are dropped; bullets, spacing and blank lines are made regular. Words are not changed.
 */
export function cleanPostingText(
	text: string,
	options: { html?: boolean } = {},
): string {
	let source = text ?? "";
	if (
		options.html !== false &&
		/<!doctype|<(?:html|body|p|div|li|ul|ol|br|h[1-6]|span|strong)\b[^>]*>/i.test(
			source,
		)
	)
		return htmlToMarkdown(source);
	source = source
		.replace(/\r\n?/g, "\n")
		.replace(/[   ]/g, " ")
		.replace(/[​-‍﻿]/g, "")
		.replace(/\t/g, " ");
	const lines: string[] = [];
	for (const raw of source.split("\n")) {
		const indent = raw.match(/^ */)?.[0].length ?? 0;
		let line = raw.replace(/[ ]{2,}/g, " ").trim();
		if (FURNITURE.test(line) || (COOKIE.test(line) && line.length < 400))
			continue;
		line = line
			.replace(GLYPH_BULLET, "- ")
			.replace(/^\* (?=\S)/, "- ")
			.replace(/^(\d{1,2})\)\s+/, "$1. ")
			.replace(/\*\*\s*\*\*/g, "")
			.replace(/\s+([,.;:!?])(?=\s|$)/g, "$1");
		if (/^(?:-|\d+\.)$/.test(line)) continue;
		const nested = /^(?:-|\d+\.) /.test(line) && indent >= 2;
		lines.push(nested ? `  ${line}` : line);
	}
	return lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^(#{1,6} .+)\n(?!\n)/gm, "$1\n\n")
		.trim();
}

/** True when stored text is a whole page rather than a posting (a doctype, tags, or furniture). */
export function looksLikeRawPage(text: string): boolean {
	return (
		/^\s*<!doctype/i.test(text) ||
		/<\/?(?:html|body|div|script)\b/i.test(text) ||
		/^(?:jump|skip) to (?:main )?content$/im.test(text) ||
		COOKIE.test(text.slice(0, 1500))
	);
}

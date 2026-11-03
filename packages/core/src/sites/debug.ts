import { type HTMLElement, type Node, parse, TextNode } from "node-html-parser";

/**
 * A page a site run stopped on, cut down to what diagnoses a reader: the element tree with its
 * structure and the hooks the readers select on, and the text it shows. Built from an allowlist,
 * so nothing private is kept by accident:
 * - elements that carry no layout or that hold account data are dropped with all they hold:
 *   scripts, styles, meta and link tags, frames, media, form fields (and their values), the site's
 *   header, navigation and account menus;
 * - attributes are dropped except class, id, role, aria-*, test ids and the readers' own hooks
 *   (a title only when it repeats the element's own text);
 *   a link keeps its path only (no query or fragment: they carry tokens), and never a mailto: or
 *   tel: target;
 * - text is decoded first, then email addresses and phone numbers are blanked.
 * The DOM holds no cookies; none are read.
 */

/** The most HTML read before anything is parsed. */
export const DIAGNOSTIC_INPUT_LIMIT = 4 * 1024 * 1024;

const DROP_TAGS = new Set([
	"script",
	"style",
	"noscript",
	"template",
	"meta",
	"link",
	"base",
	"iframe",
	"frame",
	"frameset",
	"object",
	"embed",
	"svg",
	"math",
	"img",
	"picture",
	"source",
	"video",
	"audio",
	"canvas",
	"input",
	"textarea",
	"select",
	"option",
	"button",
	"header",
	"nav",
]);

/** The sites' account menus and global navigation, wherever they sit. */
const DROP_SELECTOR = [
	'[role="banner"]',
	'[role="navigation"]',
	'[id*="meMenu" i]',
	'[componentkey*="meMenu" i]',
	'[id*="gnav" i]',
	'[class*="gnav" i]',
	'[class*="global-nav" i]',
	'[class*="account-menu" i]',
	'[class*="user-menu" i]',
	'[class*="usermenu" i]',
	'[aria-label*="account" i]',
	'[data-testid*="account" i]',
	'[data-testid*="user-menu" i]',
].join(", ");

const KEEP_ATTRS = new Set([
	"class",
	"id",
	"role",
	"data-testid",
	"data-test",
	// The readers' hooks (job ids, LinkedIn's component keys and screen).
	"data-jk",
	"data-jobid",
	"data-occludable-job-id",
	"componentkey",
	"data-sdui-screen",
	"data-display-contents",
]);

const VOID = new Set(["br", "hr", "wbr", "col", "area", "track"]);

const EMAIL = /[\w.%+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** A run of digits with separators that holds 9 to 15 digits: a phone number. */
const PHONE = /\+?\(?\d[\d\s().-]{7,}\d/g;

/** Email addresses and phone numbers blanked (on decoded text). */
export function redact(text: string): string {
	return text.replace(EMAIL, "[email]").replace(PHONE, (match) => {
		const digits = match.replace(/\D/g, "").length;
		return digits >= 9 && digits <= 15 && /[\s().-]/.test(match)
			? "[phone]"
			: match;
	});
}

const escapeText = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, "&quot;");

/** A link's path only: the query and fragment carry tokens, mailto: and tel: an address. */
function hrefPath(href: string): string | null {
	try {
		const url = new URL(href, "https://page.invalid");
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		const path = redact(url.pathname);
		return url.host === "page.invalid" ? path : `${url.origin}${path}`;
	} catch {
		return null;
	}
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function attributes(el: HTMLElement): string {
	let out = "";
	for (const [name, value] of Object.entries(el.attributes)) {
		const key = name.toLowerCase();
		let kept: string | null = null;
		if (key === "href") kept = hrefPath(value);
		else if (KEEP_ATTRS.has(key) || key.startsWith("aria-"))
			kept = redact(value);
		// A title only when it repeats the element's own shown text (Indeed's card titles are
		// span[title]); an avatar's title naming the account is dropped.
		else if (key === "title" && squash(value) === squash(el.text))
			kept = redact(value);
		if (kept !== null) out += ` ${key}="${escapeAttr(kept)}"`;
	}
	return out;
}

/** The page as kept for diagnosis (see the module's comment). */
export function diagnosticDom(html: string): string {
	const root = parse(html.slice(0, DIAGNOSTIC_INPUT_LIMIT), {
		comment: false,
	});
	const dropped = new Set<Node>(root.querySelectorAll(DROP_SELECTOR));
	const emit = (node: Node): string => {
		if (node instanceof TextNode) return escapeText(redact(node.text));
		const el = node as HTMLElement;
		const tag = el.rawTagName?.toLowerCase();
		const inner = () => el.childNodes.map(emit).join("");
		if (!tag) return inner();
		if (DROP_TAGS.has(tag) || dropped.has(el)) return "";
		if (VOID.has(tag)) return `<${tag}${attributes(el)}>`;
		return `<${tag}${attributes(el)}>${inner()}</${tag}>`;
	};
	return emit(root).replace(/\n\s*\n+/g, "\n");
}

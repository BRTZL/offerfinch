import type { HostRules } from "../scrape/browser";
import { GOOGLE_FONTS, joinRules } from "./host-rules";

/**
 * Which hosts an employer's own form (the "web" board, docs/auto-apply-plan.md step 6) may send
 * the application to, and which it may only read from (docs/decisions.md, 2026-11-09 step 6).
 */

/** Two-label public suffixes a registrable domain sits under (`example.co.uk`). */
const MULTI_LABEL_SUFFIXES = new Set(
	[
		"co.uk org.uk ac.uk gov.uk me.uk ltd.uk plc.uk net.uk sch.uk",
		"com.au net.au org.au edu.au gov.au co.nz org.nz net.nz co.jp ne.jp or.jp ac.jp",
		"co.kr or.kr com.br net.br org.br com.mx org.mx com.ar com.tr gen.tr org.tr net.tr",
		"co.in net.in org.in com.cn net.cn org.cn com.hk com.sg com.tw co.za org.za com.pl",
		"co.il org.il com.ua com.my com.ph com.vn co.id com.co com.pe com.sa com.eg co.th",
		"com.ng com.pk co.ke com.bd com.uy com.ec com.do com.gt co.at or.at com.cy com.mt",
	]
		.join(" ")
		.split(" "),
);

/**
 * Suffixes under which anyone can have a site of their own (hosting, site builders, form
 * services): two of their subdomains belong to different people, so only the exact host counts.
 */
const SHARED_HOSTING = new Set(
	[
		"github.io gitlab.io netlify.app vercel.app herokuapp.com pages.dev workers.dev web.app",
		"firebaseapp.com azurewebsites.net cloudfront.net amazonaws.com appspot.com wixsite.com",
		"webflow.io framer.website framer.app notion.site onrender.com fly.dev glitch.me surge.sh",
		"replit.app blogspot.com wordpress.com myshopify.com squarespace.com carrd.co bubbleapps.io",
		"typeform.com jotform.com google.com googleusercontent.com softr.app tilda.ws weebly.com",
	]
		.join(" ")
		.split(" "),
);

/**
 * The registrable domain of `host` (`jobs.example.co.uk` gives `example.co.uk`), or null when it
 * cannot be told safely: an IP address, `localhost` or another single label, or a host on a
 * shared-hosting suffix (`acme.github.io`). Null means the exact host alone is that site. Without
 * the full public-suffix list an unknown two-label suffix reads as a domain, so callers never
 * widen past one label in front of it (`hostMatches`' `*.`).
 */
export function siteOfHost(host: string): string | null {
	const name = host.toLowerCase().replace(/\.$/, "");
	if (/^[\d.]+$/.test(name) || name.includes(":") || !name.includes("."))
		return null;
	const labels = name.split(".");
	const take = MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join(".")) ? 3 : 2;
	if (labels.length < take) return null;
	for (let i = 0; i < labels.length - 1; i++)
		if (SHARED_HOSTING.has(labels.slice(i).join("."))) return null;
	return labels.slice(-take).join(".");
}

/** True when both hosts are the same site (`siteOfHost`), or the same host when it has none. */
export function sameSite(a: string, b: string): boolean {
	const one = a.toLowerCase();
	const two = b.toLowerCase();
	if (one === two) return true;
	const site = siteOfHost(one);
	return site !== null && site === siteOfHost(two);
}

/**
 * The hosts an employer's form may send the application to: the form's own host, its
 * registrable domain, and one label in front of it (`example.com`, `jobs.example.com`,
 * `api.example.com`; not `a.b.example.com` unless it is the form's own host). A host with no
 * safe registrable domain (an IP, `localhost`, `acme.github.io`) is its own and only destination.
 */
export function webFormHosts(formUrl: string): string[] {
	const host = new URL(formUrl).hostname.toLowerCase();
	const site = siteOfHost(host);
	return site ? [...new Set([host, site, `*.${site}`])] : [host];
}

/**
 * Public hosts an employer's page commonly loads its fonts, libraries and scoring widget from:
 * read-only (GET, HEAD) in a real submission, never sent a filled value or a file. Every other
 * host is refused quietly, as on the boards.
 */
export const WEB_READ_HOSTS: readonly string[] = [
	"fonts.googleapis.com",
	"fonts.gstatic.com",
	"www.gstatic.com",
	"www.recaptcha.net",
	"cdnjs.cloudflare.com",
	"cdn.jsdelivr.net",
	"unpkg.com",
];

/** The session hosts of a real submission on an employer's form (cf. `sessionHosts` for boards). */
export function webSessionHosts(formUrl: string): {
	form: string[];
	rules: HostRules;
} {
	// Asset reads only (scripts, styles, fonts, images; no query string but Google Fonts' own):
	// an employer's scoring widget has no recorded site key, so it gets no posts.
	return {
		form: webFormHosts(formUrl),
		rules: joinRules({ assets: [...WEB_READ_HOSTS] }, GOOGLE_FONTS),
	};
}

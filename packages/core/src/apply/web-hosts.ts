import { getDomain } from "tldts";
import type { HostRules } from "../scrape/browser";
import { GOOGLE_FONTS, joinRules } from "./host-rules";

/**
 * Which hosts an employer's own form (the "web" board, docs/auto-apply-plan.md step 6) may send
 * the application to, and which it may only read from (docs/decisions.md, 2026-11-09 step 6).
 */

/**
 * Hosts under which anyone can have a site of their own that the public suffix list does not
 * split (form services, a big provider's shared domains): two of their subdomains belong to
 * different people, so only the exact host counts. Hosting suffixes the list does name
 * (`github.io`, `netlify.app` …) are held here too, so they never widen either.
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
 * The registrable domain of `host` (`jobs.acme.com.es` gives `acme.com.es`), from the public
 * suffix list (`tldts`, private suffixes included), or null when it cannot be told safely: an IP
 * address, `localhost` or another single label, a public suffix itself (`com.es`), or a host on
 * a shared-hosting suffix (`acme.github.io`). Null means the exact host alone is that site.
 */
export function siteOfHost(host: string): string | null {
	const name = host.toLowerCase().replace(/\.$/, "");
	if (/^[\d.]+$/.test(name) || name.includes(":") || !name.includes("."))
		return null;
	const labels = name.split(".");
	for (let i = 0; i < labels.length - 1; i++)
		if (SHARED_HOSTING.has(labels.slice(i).join("."))) return null;
	return getDomain(name, { allowPrivateDomains: true }) ?? null;
}

/** True when both hosts are the same site (`siteOfHost`), or the same host when it has none. */
export function sameSite(a: string, b: string): boolean {
	const one = a.toLowerCase();
	const two = b.toLowerCase();
	if (one === two) return true;
	const site = siteOfHost(one);
	return site !== null && site === siteOfHost(two);
}

/** A plain host name (no wildcard, no port, no path): what may be listed as a destination. */
const PLAIN_HOST =
	/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/**
 * The hosts an employer's form may send the application to, and only these, never a wildcard:
 * the form's own host, and the hosts the read before review saw the form send to (`sendsTo`:
 * where the form was read after a redirect or a frame of the same site, its `action`, its
 * buttons' `formaction`), each only when it is the same registrable domain as the form's host.
 */
export function webFormHosts(
	formUrl: string,
	sendsTo: readonly string[] = [],
): string[] {
	const host = new URL(formUrl).hostname.toLowerCase();
	const known = sendsTo
		.map((h) => h.toLowerCase())
		.filter((h) => PLAIN_HOST.test(h) && sameSite(host, h));
	return [...new Set([host, ...known])];
}

/**
 * Where reading an employer's form may go (read-only, nothing typed): the form's own host, its
 * registrable domain and one label in front of it, so a redirect or a frame on the same site
 * still reads. What the read finds there becomes `sendsTo`; submission gets only those.
 */
export function webReadHosts(formUrl: string): string[] {
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
export function webSessionHosts(
	formUrl: string,
	sendsTo: readonly string[] = [],
): {
	form: string[];
	rules: HostRules;
} {
	// Asset reads only (scripts, styles, fonts, images; no query string but Google Fonts' own):
	// an employer's scoring widget has no recorded site key, so it gets no posts.
	return {
		form: webFormHosts(formUrl, sendsTo),
		rules: joinRules({ assets: [...WEB_READ_HOSTS] }, GOOGLE_FONTS),
	};
}

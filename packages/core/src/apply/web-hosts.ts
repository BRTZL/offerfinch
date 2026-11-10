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

/**
 * The only host an employer's form may send the application to: the exact host of the form's page
 * (`FormSchema.formUrl`, which is on the job link's own host: `linkMoved`). Nothing the
 * page says (its `action`, a `formaction`, a script) adds another (docs/decisions.md, 2026-11-09,
 * step 6 re-review).
 */
export function webFormHost(formUrl: string): string {
	return new URL(formUrl).hostname.toLowerCase();
}

/**
 * Why an employer's form is the user's to finish when its link led to another host: the HTTP
 * redirects moved the job's link (`link`) to a page (`formUrl`) on a host other than the link's
 * own, same site included. Null when the host stayed (a path change is fine).
 */
export function linkMoved(link: string, formUrl: string): string | null {
	const to = webFormHost(formUrl);
	return to === webFormHost(link)
		? null
		: `The job link moves to ${to}; finish it yourself.`;
}

/**
 * Where reading an employer's form may go (read-only, nothing typed): the form's own host, its
 * registrable domain and one label in front of it, so a redirect or a frame on the same site
 * still reads. Where the page lands after HTTP redirects is the form's page; submission sends
 * only to that exact host (`webFormHost`).
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
export function webSessionHosts(formUrl: string): {
	form: string[];
	rules: HostRules;
} {
	// Asset reads only (scripts, styles, fonts, images; no query string but Google Fonts' own):
	// an employer's scoring widget has no recorded site key, so it gets no posts.
	return {
		form: [webFormHost(formUrl)],
		rules: joinRules({ assets: [...WEB_READ_HOSTS] }, GOOGLE_FONTS),
	};
}

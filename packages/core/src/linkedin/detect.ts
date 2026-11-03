import { firstMarker } from "../sites/read";
import { LINKEDIN_SELECTORS } from "./selectors";

/**
 * Recognizes a LinkedIn page the runner must not read past: a login wall, a security check, a
 * CAPTCHA, an account warning or a page that is not the one it asked for. Any of these stops the
 * run and blocks the next one until the user clears it. The desktop app first hands a login
 * wall, security check or CAPTCHA to the user (the run waits while they solve it by hand in the
 * live tab, apps/desktop/src/worker/checks.ts) and stops only if it is still there. There is no
 * retry or workaround path; nothing here hides the browser or changes how it looks.
 */

export const LINKEDIN_STOP_KINDS = [
	"login_wall",
	"security_check",
	"captcha",
	"warning",
	"unusual_page",
	"selectors",
] as const;
export type LinkedInStopKind = (typeof LINKEDIN_STOP_KINDS)[number];

export interface LinkedInStop {
	kind: LinkedInStopKind;
	/** What was seen, without page text or account data; saved as the stop reason. */
	reason: string;
}

export interface LinkedInPage {
	/** The URL the browser ended on, after any redirect. */
	url: string;
	status: number | null;
	html: string;
}

/**
 * The posting's own description, in either layout: the employer's text (a fraud team's posting
 * may well mention "unusual activity"). Everything LinkedIn itself shows stays.
 */
export const LINKEDIN_POSTING_TEXT = `${LINKEDIN_SELECTORS.jobDescription}, ${LINKEDIN_SELECTORS.sduiJobDescription}`;

const PATHS: { pattern: RegExp; stop: LinkedInStop }[] = [
	{
		pattern: /^\/(?:checkpoint|challenge|uas\/consumer-captcha)\b/i,
		stop: { kind: "security_check", reason: "LinkedIn security check page" },
	},
	{
		pattern: /^\/(?:login|uas\/login|authwall|signup|reauthentication)\b/i,
		stop: { kind: "login_wall", reason: "LinkedIn sign-in page" },
	},
];

/**
 * `markup` markers are read in the page's tags and attributes, `text` markers in what it shows.
 * Neither reads inline script bodies (the SDUI layout ships every message LinkedIn might show
 * as JSON in its scripts) or the posting's own description.
 */
const MARKERS: {
	pattern: RegExp;
	stop: LinkedInStop;
	on: "text" | "markup";
}[] = [
	{
		pattern:
			/<iframe[^>]+(?:captcha|arkoselabs|funcaptcha|recaptcha|hcaptcha)/i,
		stop: { kind: "captcha", reason: "CAPTCHA on the page" },
		on: "markup",
	},
	{
		pattern:
			/let(?:'|&#39;|’)s do a quick security check|security verification|verify (?:that )?you(?:'|&#39;|’)?re (?:a )?human|are you a robot/i,
		stop: { kind: "security_check", reason: "security check prompt" },
		on: "text",
	},
	{
		pattern:
			/(?:account|profile) (?:has been |is |was )?(?:temporarily )?restricted|we(?:'|&#39;|’)ve restricted|unusual activity|automated (?:activity|tools|software)|too many requests|exceeded the (?:daily|weekly) limit/i,
		stop: { kind: "warning", reason: "account warning or rate notice" },
		on: "text",
	},
	{
		pattern: /name="session_key"|class="[^"]*\bauthwall\b/i,
		stop: {
			kind: "login_wall",
			reason: "signed out: LinkedIn asks to sign in",
		},
		on: "markup",
	},
	{
		pattern:
			/sign in to view more jobs|join linkedin to see|sign in to see who you already know/i,
		stop: {
			kind: "login_wall",
			reason: "signed out: LinkedIn asks to sign in",
		},
		on: "text",
	},
];

/** The stop the page calls for, or null when it is a normal page on the expected host. */
export function detectLinkedInStop(
	page: LinkedInPage,
	expectedHost: string,
): LinkedInStop | null {
	let url: URL;
	try {
		url = new URL(page.url);
	} catch {
		return { kind: "unusual_page", reason: "the browser reported no page URL" };
	}
	for (const { pattern, stop } of PATHS)
		if (pattern.test(url.pathname)) return stop;
	if (url.hostname !== expectedHost)
		return {
			kind: "unusual_page",
			reason: "the page left LinkedIn for another host",
		};
	// The page first, whatever its status: a check, sign-in wall or warning shown with HTTP 403 is
	// the user's to clear (held), not an unusual page to retry.
	const marked = firstMarker(
		page,
		LINKEDIN_POSTING_TEXT,
		MARKERS.map(({ pattern, stop, on }) => ({ pattern, on, ...stop })),
	);
	if (marked) return marked;
	if (page.status === 999 || page.status === 429)
		return {
			kind: "security_check",
			reason: `HTTP ${page.status}: LinkedIn refused the request`,
		};
	if (page.status !== null && page.status >= 400)
		return { kind: "unusual_page", reason: `HTTP ${page.status}` };
	return null;
}

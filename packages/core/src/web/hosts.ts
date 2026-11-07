import { checkJobLink } from "../sources/link";

/**
 * Which web search results are read. Only http(s) pages on public hosts (no user name or
 * password, not this Mac or a private network), and never a site another source already covers:
 * LinkedIn, Indeed and Glassdoor (with their regional sites, indeed.co.uk, de.indeed.com,
 * indeed.com.br, glassdoor.de, uk.linkedin.com, ...), and the boards job-board search reads
 * (Ashby, Greenhouse, Lever, SmartRecruiters, Workable, Recruitee, Teamtailor, Personio).
 */

/**
 * The sites other sources read, by their registrable name: the label right before the public
 * suffix, under ANY suffix (linkedin.com, uk.linkedin.com, linkedin.jobs, indeed.co.uk,
 * indeed.careers, glassdoor.work, ashbyhq.org, greenhouse.com, job-boards.eu.greenhouse.io,
 * jobs.eu.lever.co, lever.io). Only the whole label counts: cleverbridge.com or myindeed.com are
 * other sites.
 */
const BRANDS = new Set([
	"linkedin",
	"indeed",
	"glassdoor",
	"ashbyhq",
	"greenhouse",
	"lever",
	"smartrecruiters",
	"workable",
	"recruitee",
	"teamtailor",
	"personio",
]);

/**
 * Second-level labels under a country code that are part of the public suffix (co.uk, com.br,
 * org.au, ac.jp, ...). A compact stand-in for the Public Suffix List for this one question.
 */
const SECOND_LEVEL = new Set([
	"co",
	"com",
	"org",
	"net",
	"gov",
	"edu",
	"ac",
	"or",
	"ne",
	"go",
	"gob",
	"gv",
	"ltd",
	"plc",
	"nom",
	"info",
	"biz",
]);

function hostOf(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase().replace(/\.+$/, "");
	} catch {
		return null;
	}
}

/** The registrable label: "indeed" for de.indeed.com, indeed.co.uk and indeed.careers. */
function registrableLabel(host: string): string | null {
	const labels = host.split(".").filter(Boolean);
	if (labels.length < 2) return null;
	const last = labels.at(-1) as string;
	const second = labels.at(-2) as string;
	// A country code with a second level under it (co.uk, com.br): the suffix is two labels.
	const twoPart =
		labels.length >= 3 && /^[a-z]{2}$/.test(last) && SECOND_LEVEL.has(second);
	return (twoPart ? labels.at(-3) : second) ?? null;
}

/** The page is on a site another source reads (so web search leaves it to that source). */
export function coveredByOtherSource(url: string): boolean {
	const host = hostOf(url);
	if (!host) return false;
	const label = registrableLabel(host);
	return label !== null && BRANDS.has(label);
}

/** A result web search may open: a public http(s) page on a site no other source covers. */
export function readableResult(url: string): boolean {
	const check = checkJobLink(url);
	return check.ok && !coveredByOtherSource(check.url.toString());
}

/** The site's own host, for the per-site cap and a company name when the page names none. */
export function siteKey(url: string): string {
	return (hostOf(url) ?? "").replace(/^www\./, "");
}

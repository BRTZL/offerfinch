import type { WorkplaceType } from "../domain/types";
import { LINKEDIN_ORIGIN } from "../linkedin/runner";
import type { SiteId } from "../sites/sites";
import { describeSearch, type PlanSearch, rotate } from "./plan";

/**
 * Each source's form of the shared search plan (`plan.ts`): LinkedIn's search URL parameters,
 * Indeed's and Glassdoor's search pages, DuckDuckGo queries for job-board search (one board
 * per query) and web search (plain words), and the remote feeds' local match (a feed is read
 * whole; its postings are kept when one of the plan's searches would have found them).
 */

const words = (s: PlanSearch) =>
	[s.seniority, s.keywords].filter(Boolean).join(" ");

/** The search in words, with the user's country where the entry names no place. */
const label = (s: PlanSearch, livesIn: string) =>
	describeSearch(
		s.where === "remote-worldwide" || s.place || !livesIn
			? s
			: { ...s, place: livesIn },
	);

/* --------------------------------------------------------------- LinkedIn */

/** LinkedIn's workplace filter (`f_WT`): 1 on-site, 2 remote, 3 hybrid. */
const LINKEDIN_REMOTE = "2";
const LINKEDIN_OFFICE = "1,3";

export interface LinkedInSearch {
	/** What it searches for, in words. */
	label: string;
	url: string;
}

/**
 * A LinkedIn job search for a plan entry: keywords, location (worldwide remote: "Worldwide";
 * remote in a country: that country, else where the user lives; office: the place), the
 * workplace filter, newest first (a run reads only the top few cards).
 */
export function linkedinSearch(
	s: PlanSearch,
	livesIn: string,
	origin = LINKEDIN_ORIGIN,
): LinkedInSearch {
	const url = new URL("/jobs/search/", origin);
	url.searchParams.set("keywords", words(s));
	const location =
		s.where === "remote-worldwide" ? "Worldwide" : (s.place ?? livesIn);
	if (location) url.searchParams.set("location", location);
	url.searchParams.set(
		"f_WT",
		s.where === "onsite" ? LINKEDIN_OFFICE : LINKEDIN_REMOTE,
	);
	url.searchParams.set("sortBy", "DD");
	return { label: label(s, livesIn), url: url.toString() };
}

/**
 * A stored LinkedIn search URL as a plan entry (the custom searches of earlier versions):
 * `keywords`, `location` and `f_WT` read back. Null for anything else (a collection).
 */
export function searchFromLinkedInUrl(
	value: string,
	livesIn: string,
): PlanSearch | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (!/^\/jobs\/search\b/.test(url.pathname)) return null;
	const keywords = (url.searchParams.get("keywords") ?? "").trim();
	if (!keywords) return null;
	const location = (url.searchParams.get("location") ?? "").trim();
	const remote = (url.searchParams.get("f_WT") ?? "")
		.split(",")
		.includes(LINKEDIN_REMOTE);
	if (remote)
		return !location || /^worldwide$/i.test(location)
			? { keywords, where: "remote-worldwide" }
			: {
					keywords,
					where: "remote-in-country",
					place: location === livesIn ? undefined : location,
				};
	return {
		keywords,
		where: "onsite",
		...(location ? { place: location } : {}),
	};
}

/* ------------------------------------------------------ Indeed, Glassdoor */

/**
 * Indeed's own site per country (`xx.indeed.com`); a signed-in user is sent there anyway, and
 * its results are that country's. The US site, www, otherwise.
 */
const INDEED_REGIONS: Record<string, string> = {
	"United Kingdom": "uk",
	Germany: "de",
	France: "fr",
	Netherlands: "nl",
	Spain: "es",
	Italy: "it",
	Ireland: "ie",
	Poland: "pl",
	Portugal: "pt",
	Switzerland: "ch",
	Austria: "at",
	Belgium: "be",
	Sweden: "se",
	Türkiye: "tr",
	Canada: "ca",
	Mexico: "mx",
	Brazil: "br",
	India: "in",
	Australia: "au",
	"New Zealand": "nz",
	Singapore: "sg",
	Japan: "jp",
	"United Arab Emirates": "ae",
};

export interface SiteSearch {
	/** Where the search page is (Indeed's regional site for a country). */
	origin: string;
	query: string;
	location: string;
	label: string;
}

/**
 * Indeed or Glassdoor's search for a plan entry. Remote searches put "remote" in the location
 * (Indeed and Glassdoor both read it); a country's remote search runs on that country's Indeed.
 * Glassdoor's country sites are other domains with their own sign-in, so it stays on its main
 * site and names the place. A test run's stand-in origin is never changed.
 */
export function siteSearch(
	site: SiteId,
	s: PlanSearch,
	livesIn: string,
	origin: string,
	standIn: boolean,
): SiteSearch {
	const country = s.where === "remote-worldwide" ? "" : (s.place ?? livesIn);
	const region = INDEED_REGIONS[country];
	const regional =
		site === "indeed" && region && !standIn
			? `https://${region}.indeed.com`
			: origin;
	const remote = s.where !== "onsite";
	let location = country;
	if (remote)
		location =
			s.where === "remote-worldwide" || regional !== origin
				? "Remote"
				: `Remote ${country}`.trim();
	return {
		origin: regional,
		query: words(s),
		location,
		label: label(s, livesIn),
	};
}

/* ------------------------------------------------------------- DuckDuckGo */

const BOARD_SITES = [
	// One site per query: the form checked on DuckDuckGo (job-boards is where boards.greenhouse.io
	// postings live now). An OR of two sites met DuckDuckGo's bot check on its first query.
	"site:job-boards.greenhouse.io",
	"site:jobs.lever.co",
	"site:jobs.ashbyhq.com",
] as const;

const quoted = (text: string) => (text.includes(" ") ? `"${text}"` : text);

/** Where, as words a posting would say. */
function whereWords(s: PlanSearch, livesIn: string): string {
	if (s.where === "remote-worldwide") return "remote";
	const place = s.place ?? livesIn;
	if (s.where === "remote-in-country")
		return `remote${place ? ` ${quoted(place)}` : ""}`;
	return place ? quoted(place) : "";
}

/**
 * Job-board search's queries: each entry on each board, one site per query. A scan makes at most
 * `max`, from `start` in that list (wrapping); the next scan starts where this one ended, so
 * successive scans cover every entry on every board.
 */
export function boardQueries(
	searches: PlanSearch[],
	livesIn: string,
	max: number,
	start: number,
): string[] {
	const all: string[] = [];
	for (const s of searches)
		for (const site of BOARD_SITES)
			all.push(
				`${site} "${words(s).replace(/"/g, "")}" ${whereWords(s, livesIn)}`.trim(),
			);
	return rotate(all, start, max);
}

/**
 * Web search's queries: plain words a person would type ("senior frontend engineer remote
 * Turkey"). At most `max` a scan, from `start` in that list (wrapping).
 */
export function webQueries(
	searches: PlanSearch[],
	livesIn: string,
	max: number,
	start: number,
): string[] {
	const all = searches.map((s) =>
		[words(s), "jobs", whereWords(s, livesIn).replace(/"/g, "")]
			.filter(Boolean)
			.join(" ")
			.replace(/\s+/g, " ")
			.trim(),
	);
	return rotate([...new Set(all)], start, max);
}

/* ------------------------------------------------------------ Remote feeds */

/**
 * Words that name the kind of role, any one standing for the others ("Frontend Developer",
 * "Frontend Lead"). Never enough on their own: a search must also name a specialty.
 */
const ROLE_NOUNS = new Set([
	"engineer",
	"developer",
	"programmer",
	"swe",
	"sde",
	"dev",
	"lead",
]);
/** Words that make a title no more specific ("Software Engineer"): its feed tags may say more. */
const GENERIC = new Set(["software", "web", "application", "app"]);
/** Left out of matching: the fit score weighs seniority; these words say nothing else. */
const IGNORED = new Set([
	"senior",
	"sr",
	"staff",
	"principal",
	"junior",
	"jr",
	"mid",
	"level",
	"ii",
	"iii",
	"iv",
	"and",
	"or",
	"the",
	"of",
	"for",
	"in",
	"a",
	"an",
	"with",
	"to",
	"remote",
]);

/**
 * Words of a title or a search, folded so spellings meet: "Front-End", "front end" and
 * "frontend"; "Node.js" and "node"; plurals ("Engineers") as one.
 */
function matchWords(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/\bfront[\s-]+end\b/g, "frontend")
		.replace(/\bback[\s-]+end\b/g, "backend")
		.replace(/\bfull[\s-]+stack\b/g, "fullstack")
		.replace(/\b(react|node|vue|next)\.?js\b/g, "$1")
		.split(/[^\p{L}\p{N}+#]+/u)
		.filter(Boolean)
		.map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w));
}

/**
 * A feed posting is what a search asks for. The search must name a specialty (a word beyond role
 * words and seniority: "Staff Engineer" alone finds nothing), and every one of its specialty words
 * must be in the title. The feed's tags may supply them only when the title is a generic role
 * ("Software Engineer", "Engineer") with no specialty of its own to conflict with. When the
 * search names a kind of role (engineer, developer, lead), the title names one of them.
 * Seniority is left to the fit score.
 */
export function feedKeywordsMatch(
	posting: { title: string; tags?: string[] },
	s: PlanSearch,
): boolean {
	const wanted = matchWords(s.keywords).filter((w) => !IGNORED.has(w));
	const core = wanted.filter((w) => !ROLE_NOUNS.has(w));
	if (core.length === 0) return false;
	const titleWords = matchWords(posting.title);
	const title = new Set(titleWords);
	const role = wanted.some((w) => ROLE_NOUNS.has(w));
	if (role && ![...ROLE_NOUNS].some((w) => title.has(w))) return false;
	if (core.every((w) => title.has(w))) return true;
	const generic = titleWords.every(
		(w) => IGNORED.has(w) || ROLE_NOUNS.has(w) || GENERIC.has(w),
	);
	if (!generic) return false;
	const tags = new Set(matchWords((posting.tags ?? []).join(" , ")));
	return core.every((w) => title.has(w) || tags.has(w));
}

/**
 * The posting is the kind of work the search looks for: a remote search takes remote (or
 * unstated) work, an office search office, hybrid or unstated work. Where it hires from is the
 * fit score's to judge (docs/decisions.md, 2026-11-05), so a place never drops a posting here.
 */
export function feedWhereMatch(
	posting: { workplaceType: WorkplaceType },
	s: PlanSearch,
): boolean {
	if (s.where === "onsite") return posting.workplaceType !== "remote";
	return (
		posting.workplaceType === "remote" || posting.workplaceType === "unknown"
	);
}

/**
 * Where a run starts in its list of searches: the stored cursor, or without one (no store) the
 * hour's turn times the run's count.
 */
export function runStart(
	cursor: number | undefined,
	now: Date,
	count: number,
	hours = 1,
): number {
	return cursor ?? scanTurn(now, hours) * count;
}

/** A scan's turn, for rotating searches: the hour it runs in. */
function scanTurn(now: Date, hours = 1): number {
	return Math.floor(now.getTime() / (hours * 3_600_000));
}

import { postingFromUrl } from "../sources/search";
import { BOARDS, type Board, type FormBoard } from "./forms";
import { siteOfHost } from "./web-hosts";

/**
 * Which form an application is filled on (docs/auto-apply-plan.md, step 6): the board its source
 * names, else the board or employer site its apply link points to. The one place this is decided:
 * the database's submission context and the review both read it, so what review shows is what
 * the run fills.
 */

export interface FormTarget {
	/** Null: no form is filled (a hand-off; the reason is the source's or `reason`). */
	board: FormBoard | null;
	/** "source": the job's source is the board; "url": read from its apply link. */
	from: "source" | "url" | null;
	/** The posting the form belongs to: the job's own, or the one its apply link names. */
	url: string;
	companyKey: string;
	externalId: string;
	/** Why a link that was followed names no fillable form; empty otherwise. */
	reason: string;
}

export interface JobLink {
	source: string;
	url: string;
	applyUrl?: string | null;
	externalId: string;
	companyKey: string;
}

/** Sources that never fill a form, whatever their links say. */
const NEVER = new Set(["manual", "sample", "smartrecruiters"]);

/** Sources whose own page is never the form: only an employer link they show may be. */
const APPLY_LINK_ONLY = new Set(["linkedin", "indeed", "glassdoor"]);

/** The boards' own sites: a link there is a posting on that board, or no form at all. */
const BOARD_SITES: Record<string, string> = {
	"greenhouse.io": "Greenhouse",
	"lever.co": "Lever",
	"ashbyhq.com": "Ashby",
	"workable.com": "Workable",
	"recruitee.com": "Recruitee",
	"teamtailor.com": "Teamtailor",
	"personio.de": "Personio",
	"personio.com": "Personio",
	"smartrecruiters.com": "SmartRecruiters",
};

/** Application systems that ask for an account before the form (Rule 5: no passwords stored). */
const ACCOUNT_SITES: Record<string, string> = {
	"myworkdayjobs.com": "Workday",
	"myworkday.com": "Workday",
	"taleo.net": "Taleo",
	"icims.com": "iCIMS",
	"successfactors.com": "SuccessFactors",
	"successfactors.eu": "SuccessFactors",
	"brassring.com": "BrassRing",
	"oraclecloud.com": "Oracle Recruiting",
	"ultipro.com": "UKG",
};

/** Job sites and feeds: their pages list a job, they are not the employer's form. */
const LISTING_SITES = new Set([
	"linkedin.com",
	"lnkd.in",
	"remotive.com",
	"remoteok.com",
	"remoteok.io",
	"weworkremotely.com",
	"ycombinator.com",
	"wellfound.com",
	"angel.co",
	"ziprecruiter.com",
	"monster.com",
	"stepstone.de",
	"welcometothejungle.com",
]);

/** Job sites under a country domain of their own (indeed.co.uk, glassdoor.de). */
const LISTING_NAMES = new Set(["indeed", "glassdoor", "linkedin"]);

function parse(url: string): URL | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:"
			? parsed
			: null;
	} catch {
		return null;
	}
}

/** Why the link at `url` names no fillable form, or null when it is an employer's own page. */
function notAForm(url: URL): string | null {
	const host = url.hostname.toLowerCase();
	const site = siteOfHost(host) ?? host;
	const board = BOARD_SITES[site];
	if (board)
		return board === "SmartRecruiters"
			? "The apply link is on SmartRecruiters, whose application form shows an automated browser a CAPTCHA (DataDome)."
			: `The apply link is on ${board} but is not one of its postings this app can fill (${host}).`;
	const account = ACCOUNT_SITES[site];
	if (account)
		return `The apply link is on ${account}, which asks for an account before its form; no passwords are stored, so apply there yourself.`;
	if (LISTING_SITES.has(site) || LISTING_NAMES.has(site.split(".")[0] ?? ""))
		return `The apply link is on ${host}, a job site rather than the employer's form.`;
	return null;
}

/** The form an application from `job` is filled on, and why none when there is none. */
export function formTargetFor(job: JobLink): FormTarget {
	const none = (reason = ""): FormTarget => ({
		board: null,
		from: null,
		url: job.url,
		companyKey: job.companyKey,
		externalId: job.externalId,
		reason,
	});
	if (NEVER.has(job.source)) return none();
	if ((BOARDS as readonly string[]).includes(job.source))
		return { ...none(), board: job.source as Board, from: "source" };
	const link = APPLY_LINK_ONLY.has(job.source)
		? job.applyUrl
		: job.applyUrl || job.url;
	const parsed = link ? parse(link) : null;
	if (!link || !parsed) return none();
	const posting = postingFromUrl(link);
	if (posting && (BOARDS as readonly string[]).includes(posting.board)) {
		// The EU hosts are other sites than the ones the form URL is built on.
		if (/\.eu\./i.test(parsed.hostname))
			return none(
				`The apply link is on ${parsed.hostname}, a board's EU site this app has not checked.`,
			);
		return {
			board: posting.board as Board,
			from: "url",
			url: link,
			companyKey: posting.companyKey,
			externalId: posting.jobId,
			reason: "",
		};
	}
	const refused = notAForm(parsed);
	if (refused) return none(refused);
	return { ...none(), board: "web", from: "url", url: link };
}

import { promises as dns } from "node:dns";
import type {
	NormalizedJob,
	WorkplaceType,
} from "@offerfinch/core/domain/types";
import { normalizeUrl } from "@offerfinch/core/domain/url";
import { FEEDS } from "@offerfinch/core/feeds/feeds";
import {
	evaluateHardRequirements,
	type FilterResult,
} from "@offerfinch/core/filter/rules";
import { companyNameFor } from "@offerfinch/core/pipeline/providers";
import { LlmPausedError } from "@offerfinch/core/scoring/llm";
import { meteredFor } from "@offerfinch/core/scoring/metered";
import { readLinkedPage } from "@offerfinch/core/scrape/linked-page";
import {
	cleanPostingText,
	looksLikeRawPage,
} from "@offerfinch/core/scrape/markdown";
import {
	type DestinationPolicy,
	publicOnly,
} from "@offerfinch/core/scrape/public-fetch";
import { detectSiteStop, readJobPage } from "@offerfinch/core/sites/read";
import { SITES } from "@offerfinch/core/sites/sites";
import {
	checkJobLink,
	checkResolvedHost,
	routeJobLink,
} from "@offerfinch/core/sources/link";
import { USER_AGENT } from "@offerfinch/core/sources/types";
import { DashboardRepository, SqliteSearchStore } from "@offerfinch/db";
import { flowEvents, flowRuns, flowSteps } from "@offerfinch/db/schema/jobs";
import { applications, jobs } from "@offerfinch/db/schema/pipeline";
import { PRIORITY } from "@offerfinch/runner";
import { and, eq } from "drizzle-orm";
import type { WorkerApp } from "./app";
import { readLinkedInJob } from "./linkedin";
import { LOCAL_USER_ID } from "./settings";
import { openSiteReader, siteOrigins } from "./sites";

/** What the user typed when a page could not be read (or to skip reading). */
export interface PastedPosting {
	title: string;
	company: string;
	location?: string;
	description: string;
}

/** What was read so far, to prefill the paste form. */
type Partial_ = {
	title?: string;
	company?: string;
	location?: string;
	description?: string;
};

/** The job filter's verdict, shown as a note: a job added by link is never set aside. */
type FilterNote = { matches: boolean; summary: string };

export type AddLinkResult =
	| { url: string; status: "added"; applicationId: string }
	| {
			url: string;
			status: "exists";
			applicationId: string;
			filter: FilterNote | null;
	  }
	| { url: string; status: "refused"; reason: string };

export type AddPastedResult =
	| { status: "added" | "exists"; applicationId: string; filter: FilterNote }
	| { status: "refused"; reason: string };

const workplace = (text: string): WorkplaceType =>
	/\bremote\b/i.test(text)
		? "remote"
		: /\bhybrid\b/i.test(text)
			? "hybrid"
			: "unknown";

/**
 * Test runs only (OFFERFINCH_LINK_ALLOW_LOCAL=1 with OFFERFINCH_TEST): a local stand-in on
 * 127.0.0.1 may be "any other site". Never allowed outside test mode.
 */
const allowLocal = (app: WorkerApp) =>
	Boolean(app.init.test) && process.env.OFFERFINCH_LINK_ALLOW_LOCAL === "1";

/** Where reads may go: public addresses only (any address in test runs with local stand-ins). */
export const linkPolicy = (app: WorkerApp): DestinationPolicy =>
	allowLocal(app)
		? { lookup: lookupAll, allowAddress: () => true }
		: publicOnly(lookupAll);

async function lookupAll(host: string): Promise<string[]> {
	return (await dns.lookup(host, { all: true, verbatim: true })).map(
		(a) => a.address,
	);
}

/** A link that may be read: http(s), public by name and, unless pasted, by every address. */
async function checkLink(
	app: WorkerApp,
	input: string,
	options: { resolve: boolean },
): Promise<{ ok: true; url: URL } | { ok: false; reason: string }> {
	const check = checkJobLink(input);
	if (!check.ok) {
		if (allowLocal(app) && /private network/.test(check.reason))
			return { ok: true, url: new URL(input.trim()) };
		return check;
	}
	if (options.resolve && !allowLocal(app)) {
		const resolved = await checkResolvedHost(
			check.url.hostname.replace(/\.+$/, ""),
			lookupAll,
		);
		if (resolved && !resolved.ok) return resolved;
	}
	return check;
}

/** Several links in one paste: one per line (or separated by spaces or commas), each once. */
export function splitLinks(text: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const part of text.split(/[\s,]+/)) {
		const link = part.trim();
		if (!link) continue;
		let key = link;
		try {
			key = normalizeUrl(link);
		} catch {}
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(link);
	}
	return out;
}

/** "careers.example.com/jobs/42" for a row whose posting has not been read yet. */
const placeholderTitle = (url: URL) =>
	`${url.hostname.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname}`.slice(
		0,
		120,
	);

/** One company row for every job still being read; the read moves the job to its own. */
const pendingCompany = (app: WorkerApp, userId: string) =>
	new SqliteSearchStore(app.db).companyFor(userId, {
		name: "Added by link",
		source: "manual",
		sourceKey: "manual:pending",
	});

const companyId = (app: WorkerApp, userId: string, name: string) =>
	new SqliteSearchStore(app.db).companyFor(userId, {
		name,
		source: "manual",
		sourceKey: `manual:${name.toLowerCase().replace(/\s+/g, "-")}`,
	});

/** Runs (or runs again) a job's application at user priority: ahead of scans and scoring. */
async function runNow(app: WorkerApp, userId: string, jobId: string) {
	const started = await app.starter.startBatch([{ userId, jobId }], {
		priority: PRIORITY.event,
	});
	if (started.existing.length > 0)
		await app.starter.restart({ userId, jobId }, { priority: PRIORITY.event });
	await app.deps.repo.markWorkflowsStarted(userId, [jobId], "local");
}

/**
 * Adds jobs from links the user pasted, at once: each link is checked (http or https, not this
 * Mac or a private network, by name and by every address), a link already here opens its job,
 * and every new one is saved straight away as "reading" and queued. The posting is read in the
 * application run's first step (see readPostingForJob), so the dialog closes at once, the read
 * survives quitting, and links wait their turn with everything else the queue runs.
 */
export async function addJobLinks(
	app: WorkerApp,
	input: { urls: string[] },
): Promise<AddLinkResult[]> {
	const userId = LOCAL_USER_ID;
	const results: AddLinkResult[] = [];
	for (const raw of input.urls) {
		const check = await checkLink(app, raw, { resolve: true });
		if (!check.ok) {
			results.push({ url: raw, status: "refused", reason: check.reason });
			continue;
		}
		const url = check.url;
		const existing = await findByUrl(app, userId, url.toString());
		if (existing) {
			results.push({
				url: raw,
				...(await keepExisting(app, userId, existing)),
			});
			continue;
		}
		const repo = app.deps.repo;
		const { jobId } = await repo.upsertJob(
			userId,
			await pendingCompany(app, userId),
			{
				source: "manual",
				externalId: normalizeUrl(url.toString()),
				url: url.toString(),
				title: placeholderTitle(url),
				locations: [],
				workplaceType: "unknown",
				descriptionText: "",
			},
		);
		await app.db
			.update(jobs)
			.set({ readStatus: "reading", readError: null })
			.where(eq(jobs.id, jobId));
		const application = await repo.getApplicationByJob(userId, jobId);
		if (!application)
			throw new Error("the job was saved without an application");
		await app.db
			.update(applications)
			.set({ announceReady: true })
			.where(eq(applications.id, application.applicationId));
		await runNow(app, userId, jobId);
		results.push({
			url: raw,
			status: "added",
			applicationId: application.applicationId,
		});
	}
	return results;
}

/** The posting's text, typed or pasted by the user: saved as given (cleaned), then filtered and scored. */
export async function addJobFromPaste(
	app: WorkerApp,
	input: { url: string; pasted: PastedPosting },
): Promise<AddPastedResult> {
	const userId = LOCAL_USER_ID;
	// Pasted text needs no request, so a host that can't be found doesn't block it.
	const check = await checkLink(app, input.url, { resolve: false });
	if (!check.ok) return { status: "refused", reason: check.reason };
	const url = check.url;
	const existing = await findByUrl(app, userId, url.toString());
	if (existing) {
		// A job already here keeps its posting: pasting only fills one that could not be read.
		const row = await addedJob(app, existing);
		if (row?.readStatus === "failed")
			await pasteForApplication(app, existing, input.pasted);
		const kept = await keepExisting(app, userId, existing);
		return {
			status: "exists",
			applicationId: existing,
			filter: kept.filter ?? { matches: true, summary: "" },
		};
	}
	const job = pastedJob(url, input.pasted);
	const repo = app.deps.repo;
	const { jobId } = await repo.upsertJob(
		userId,
		await companyId(app, userId, input.pasted.company.trim()),
		job,
	);
	const application = await repo.getApplicationByJob(userId, jobId);
	if (!application) throw new Error("the job was saved without an application");
	await runNow(app, userId, jobId);
	const settings = await repo.getFilterSettings(userId);
	return {
		status: "added",
		applicationId: application.applicationId,
		filter: note(evaluateHardRequirements(job, settings)),
	};
}

function pastedJob(url: URL, p: PastedPosting): NormalizedJob {
	return {
		source: "manual",
		externalId: normalizeUrl(url.toString()),
		url: url.toString(),
		title: p.title.trim(),
		locations: p.location?.trim() ? [p.location.trim()] : [],
		workplaceType: workplace(`${p.location ?? ""} ${p.description}`),
		descriptionText: cleanPostingText(p.description),
	};
}

type PostingPatch = Parameters<
	DashboardRepository["updatePosting"]
>[0]["patch"];

/**
 * Every rewrite of a saved posting goes through here: refused once it is being or has been
 * submitted, and otherwise revoking any approval and running the review again (see
 * DashboardRepository.updatePosting).
 */
async function writePosting(
	app: WorkerApp,
	applicationId: string,
	patch: PostingPatch,
): Promise<void> {
	const { event } = await new DashboardRepository(app.db).updatePosting({
		userId: LOCAL_USER_ID,
		applicationId,
		patch,
	});
	if (event) await app.starter.sendEvent(event);
}

async function applicationOf(app: WorkerApp, jobId: string): Promise<string> {
	const found = await app.deps.repo.getApplicationByJob(LOCAL_USER_ID, jobId);
	if (!found) throw new Error("the job has no application");
	return found.applicationId;
}

/** The application of a job the user added by link; null for any other job. */
async function addedJob(app: WorkerApp, applicationId: string) {
	const [row] = await app.db
		.select({
			jobId: jobs.id,
			url: jobs.url,
			source: jobs.source,
			readStatus: jobs.readStatus,
		})
		.from(applications)
		.innerJoin(jobs, eq(jobs.id, applications.jobId))
		.where(
			and(
				eq(applications.id, applicationId),
				eq(applications.userId, LOCAL_USER_ID),
			),
		);
	return row?.source === "manual" ? row : null;
}

/** "Paste description" on a job whose posting could not be read: the user's text, then on. */
export async function pasteForApplication(
	app: WorkerApp,
	applicationId: string,
	pasted: PastedPosting,
): Promise<void> {
	const row = await addedJob(app, applicationId);
	// Only a posting that could not be read is typed in; a read one is never replaced.
	if (row?.readStatus !== "failed")
		throw new Error(
			"Only a job you added whose posting could not be read can be pasted in",
		);
	const job = pastedJob(new URL(row.url), pasted);
	await writePosting(app, applicationId, {
		title: job.title,
		locations: job.locations,
		workplaceType: job.workplaceType,
		descriptionText: job.descriptionText,
		companyId: await companyId(app, LOCAL_USER_ID, pasted.company.trim()),
		readStatus: null,
		readError: null,
	});
	await runNow(app, LOCAL_USER_ID, row.jobId);
}

/** "Retry" on a job whose posting could not be read: read it again, at user priority. */
export async function retryRead(
	app: WorkerApp,
	applicationId: string,
): Promise<void> {
	const row = await addedJob(app, applicationId);
	if (row?.readStatus !== "failed")
		throw new Error("Only a posting that could not be read can be retried");
	await app.db
		.update(jobs)
		.set({ readStatus: "reading", readError: null })
		.where(eq(jobs.id, row.jobId));
	await runNow(app, LOCAL_USER_ID, row.jobId);
}

/**
 * "Remove": a job the user added by link, with its application and run. Refused while its run
 * is executing (a read or a score in progress); it can be removed once that step ends.
 */
export async function removeAddedJob(
	app: WorkerApp,
	applicationId: string,
): Promise<void> {
	const row = await addedJob(app, applicationId);
	if (!row) throw new Error("Only a job you added by link can be removed");
	const runId = `job-${row.jobId}`;
	const [run] = await app.db
		.select({ status: flowRuns.status })
		.from(flowRuns)
		.where(eq(flowRuns.id, runId));
	if (run?.status === "running")
		throw new Error(
			"It is being read or scored right now; remove it when that ends",
		);
	await app.db.transaction(async (tx) => {
		await tx.delete(flowEvents).where(eq(flowEvents.runId, runId));
		await tx.delete(flowSteps).where(eq(flowSteps.runId, runId));
		await tx.delete(flowRuns).where(eq(flowRuns.id, runId));
		// The application and everything under it go with the job (foreign keys cascade).
		await tx.delete(jobs).where(eq(jobs.id, row.jobId));
	});
}

/** A failed read in words, without the browser's log. */
function readError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const first = message.split("\n")[0] ?? message;
	if (/ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_ABORTED.*40\d/.test(first))
		return "The page answered with an error; it may have been taken down";
	if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/.test(first))
		return "The site could not be found";
	if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(first))
		return "The site refused the connection";
	if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/.test(first))
		return "This Mac is offline";
	if (/Timeout|timed out|ERR_TIMED_OUT/i.test(first))
		return "The page took too long to load";
	if (/ERR_TOO_MANY_REDIRECTS/.test(first))
		return "The page redirects in a loop";
	if (/private network/.test(first)) return first;
	return `The page could not be read (${first.replace(/^page\.\w+: /, "").slice(0, 160)})`;
}

/** Reads for LinkedIn, Indeed and Glassdoor go one at a time (one browser profile each). */
const siteLocks = new Map<string, Promise<unknown>>();
async function oneAtATime<T>(key: string | null, work: () => Promise<T>) {
	if (!key) return work();
	const before = siteLocks.get(key) ?? Promise.resolve();
	const run = before.catch(() => {}).then(work);
	siteLocks.set(
		key,
		run.catch(() => {}),
	);
	return run;
}

/**
 * The application run's first step for a job added by link (PipelineDeps.postingReader): reads
 * the posting and stores it, with its company; or records why it could not be read. Never
 * throws, so a wall is never retried by the queue. Nothing to do for any other job.
 */
export async function readPostingForJob(
	app: WorkerApp,
	userId: string,
	jobId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const [row] = await app.db
		.select({ url: jobs.url, readStatus: jobs.readStatus })
		.from(jobs)
		.where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)));
	if (row?.readStatus !== "reading") return { ok: true };
	const fail = async (reason: string, found: Partial_ = {}) => {
		const cause = reason.replace(/ Paste the posting's text instead\.$/, "");
		await writePosting(app, await applicationOf(app, jobId), {
			readStatus: "failed",
			readError: cause,
			...(found.title ? { title: found.title } : {}),
			...(found.description
				? { descriptionText: cleanPostingText(found.description) }
				: {}),
			...(found.location ? { locations: [found.location] } : {}),
		});
		return { ok: false as const, reason: cause };
	};
	let read: Read;
	try {
		// Checked again at read time: the name may resolve elsewhere by now.
		const check = await checkLink(app, row.url, { resolve: true });
		if (!check.ok) return fail(check.reason);
		const kind = routeJobLink(check.url).kind;
		read = await oneAtATime(
			kind === "linkedin" || kind === "indeed" || kind === "glassdoor"
				? kind
				: null,
			() => readLink(app, check.url),
		);
	} catch (error) {
		return fail(readError(error));
	}
	if ("needs" in read) return fail(read.needs, read.found);
	const job = read.job;
	await writePosting(app, await applicationOf(app, jobId), {
		title: job.title,
		locations: job.locations,
		workplaceType: job.workplaceType,
		employmentType: job.employmentType ?? null,
		descriptionText: job.descriptionText,
		applyUrl: job.applyUrl ?? null,
		publishedAt:
			job.publishedAt && !Number.isNaN(job.publishedAt.getTime())
				? job.publishedAt
				: null,
		companyId: await companyId(app, userId, read.company),
		readStatus: null,
		readError: null,
	});
	return { ok: true };
}

const note = (result: FilterResult): FilterNote => ({
	matches: result.decision !== "reject",
	summary: result.summary,
});

/**
 * The job is already here: it opens. Added by link now, so it is the user's pick: one the
 * filter set aside (or a low score ended) comes back to the Inbox.
 */
async function keepExisting(
	app: WorkerApp,
	userId: string,
	applicationId: string,
): Promise<{
	status: "exists";
	applicationId: string;
	filter: FilterNote | null;
}> {
	const dashboard = new DashboardRepository(app.db);
	const event = await dashboard.keepAddedJob({ userId, applicationId });
	if (event) await app.starter.sendEvent(event);
	const [row] = await app.db
		.select({ filter: applications.filterResult })
		.from(applications)
		.where(eq(applications.id, applicationId));
	return {
		status: "exists",
		applicationId,
		filter: row?.filter ? note(row.filter) : null,
	};
}

async function findByUrl(app: WorkerApp, userId: string, url: string) {
	const [row] = await app.db
		.select({ id: jobs.id })
		.from(jobs)
		.where(
			and(eq(jobs.userId, userId), eq(jobs.urlNormalized, normalizeUrl(url))),
		)
		.limit(1);
	if (!row) return null;
	const app_ = await new DashboardRepository(app.db).getApplicationByJob(
		userId,
		row.id,
	);
	return app_?.applicationId ?? null;
}

type Read =
	| { job: NormalizedJob; company: string }
	| { needs: string; found: Partial_ };

async function readLink(app: WorkerApp, url: URL): Promise<Read> {
	const route = routeJobLink(url);
	const manual = (job: Omit<NormalizedJob, "source" | "externalId">) => ({
		...job,
		source: "manual" as const,
		externalId: normalizeUrl(job.url),
	});

	if (route.kind === "board") {
		const source = app.deps.sources[route.posting.board];
		if (!source)
			return { needs: "That job board cannot be read here.", found: {} };
		try {
			const listed = await source.listJobs({
				sourceKey: route.posting.companyKey,
			});
			const hit = listed.filter((j) =>
				route.posting.board === "greenhouse"
					? j.externalId === route.posting.jobId
					: j.externalId.toLowerCase() === route.posting.jobId,
			);
			const first = hit[0];
			if (!first)
				return {
					needs:
						"The posting is no longer on the company's board. Paste its text to add it anyway.",
					found: {},
				};
			return {
				job: manual(first),
				company: await companyNameFor(route.posting, hit),
			};
		} catch (error) {
			return {
				needs: `The board could not be read (${error instanceof Error ? error.message : String(error)}). Paste the posting's text instead.`,
				found: {},
			};
		}
	}

	if (route.kind === "linkedin") {
		const read = await readLinkedInJob(app, route.jobId);
		if ("stop" in read)
			return {
				needs: `${read.stop}. Paste the posting's text instead.`,
				found: {},
			};
		const l = read.listing;
		return {
			job: manual({
				url: read.url,
				title: l.title,
				locations: l.locations,
				workplaceType: l.workplaceType,
				employmentType: l.employmentType,
				descriptionText: l.descriptionText,
				applyUrl: l.externalApplyUrl ?? undefined,
			}),
			company: l.company,
		};
	}

	if (route.kind === "indeed" || route.kind === "glassdoor") {
		const site = SITES[route.kind];
		const origin = siteOrigins(Boolean(app.init.test))[route.kind];
		// One page the user asked for: a check stops it at once (no waiting).
		const reader = await openSiteReader(
			app.siteHost(),
			route.kind,
			origin,
			false,
		);
		try {
			const page = await reader.open(
				site.jobUrl(origin ?? site.origin, route.jobId),
			);
			const stop = detectSiteStop(
				page,
				site,
				new URL(origin ?? site.origin).host,
			);
			if (stop)
				return {
					needs: `${site.label} stopped the read (${stop.reason}). Paste the posting's text instead.`,
					found: {},
				};
			const read = readJobPage(page.html, site);
			if ("stop" in read)
				return {
					needs: `${site.label}'s page could not be read (${read.stop.reason}). Paste the posting's text instead.`,
					found: {},
				};
			// The job page names no employer reliably: the user adds it.
			return {
				needs: `Read from ${site.label}. Add the company name to finish.`,
				found: { title: read.title, description: read.description },
			};
		} finally {
			await reader.close().catch(() => {});
		}
	}

	// Any other site: its HTML through a checking, pinning fetcher; a browser without network of
	// its own only when that HTML holds no posting; the model (metered) only as a last resort.
	try {
		const read = await readLinkedPage(url.toString(), {
			policy: linkPolicy(app),
			browser: app.deps.browser,
			llm: meteredFor(app.deps.llm, app.deps.spend, LOCAL_USER_ID, null),
			userAgent: USER_AGENT,
		});
		if ("needs" in read)
			return {
				needs: `${read.needs}. Paste the posting's text instead.`,
				found: {},
			};
		const posting = read.posting;
		if (!posting.company)
			return {
				needs: "Read the posting. Add the company name to finish.",
				found: {
					title: posting.title,
					location: posting.location,
					description: posting.description,
				},
			};
		return {
			job: manual({
				url: url.toString(),
				title: posting.title,
				locations: posting.location ? [posting.location] : [],
				workplaceType: workplace(`${posting.location} ${posting.description}`),
				employmentType: posting.employmentType,
				publishedAt: posting.datePosted,
				descriptionText: posting.description,
			}),
			company: posting.company,
		};
	} catch (error) {
		if (error instanceof LlmPausedError)
			return {
				needs: `Your AI is paused (${error.message}). Paste the posting's text instead.`,
				found: {},
			};
		return {
			needs: `${readError(error)}. Paste the posting's text instead.`,
			found: {},
		};
	}
}

export type RereadResult =
	| { ok: true; via: "page" | "cleaned" }
	| { ok: false; reason: string };

/**
 * "Re-read posting": reads the job's link again the way it was added (a board's public data,
 * the read-only readers, or the page: structured data, then the main content, the model only
 * when neither works) and stores the cleaned posting. A title that was page furniture is
 * replaced too. When the link can't be read now, a whole-page text is still cleaned in place.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep guarded posting reads and recovery reasons in their original order.
/** Job sources whose postings come whole from a public feed (core/feeds). */
const FEED_SOURCES: ReadonlySet<string> = new Set(FEEDS.map((f) => f.source));

export async function rereadPosting(
	app: WorkerApp,
	applicationId: string,
	options: { offlineFallback?: boolean } = {},
): Promise<RereadResult> {
	const userId = LOCAL_USER_ID;
	const [row] = await app.db
		.select({
			jobId: jobs.id,
			url: jobs.url,
			title: jobs.title,
			state: applications.state,
			description: jobs.descriptionText,
			source: jobs.source,
		})
		.from(applications)
		.innerJoin(jobs, eq(jobs.id, applications.jobId))
		.where(
			and(eq(applications.id, applicationId), eq(applications.userId, userId)),
		);
	if (!row) return { ok: false, reason: "That job is not here." };
	// A remote feed gave the whole posting; its page there (an HN post, a page behind a browser
	// check) is never read by the app (docs/decisions.md, 2026-11-03).
	if (FEED_SOURCES.has(row.source))
		return {
			ok: false,
			reason:
				"This posting came whole from its feed and is not read again. Open it there to see the page.",
		};
	// Nothing is read for a posting that can no longer change.
	if (["applying", "applied", "needs_human"].includes(row.state))
		return {
			ok: false,
			reason: `The posting can't change once it is being or has been submitted (it is ${row.state}).`,
		};
	const check = checkJobLink(row.url);
	let read: Read | null = null;
	const resolved =
		check.ok && !allowLocal(app)
			? await checkResolvedHost(
					check.url.hostname.replace(/\.+$/, ""),
					lookupAll,
				)
			: null;
	if ((check.ok && !resolved) || allowLocal(app)) {
		try {
			read = await readLink(app, new URL(row.url));
		} catch (error) {
			read = {
				needs: error instanceof Error ? error.message : String(error),
				found: {},
			};
		}
	}
	const posting =
		read && "job" in read
			? { title: read.job.title, description: read.job.descriptionText }
			: read?.found.description
				? { title: read.found.title, description: read.found.description }
				: null;
	const badTitle = (t: string) => /[<>]|doctype/i.test(t) || !t.trim();
	// Through the one posting write: refused once submitted; otherwise an approval is revoked
	// and the review runs again on the new text.
	const write = async (patch: PostingPatch, via: "page" | "cleaned") => {
		try {
			await writePosting(app, applicationId, patch);
			return { ok: true as const, via };
		} catch (error) {
			return {
				ok: false as const,
				reason: (error instanceof Error
					? error.message
					: String(error)
				).replace(/^Refusing: /, ""),
			};
		}
	};
	if (posting?.description)
		return write(
			{
				descriptionText: posting.description,
				...(posting.title && badTitle(row.title)
					? { title: posting.title }
					: {}),
			},
			"page",
		);
	if (options.offlineFallback !== false && looksLikeRawPage(row.description))
		return write(
			{
				descriptionText: cleanPostingText(
					row.description.replace(/<!doctype[^>]*>/gi, ""),
					{ html: false },
				),
				...(badTitle(row.title)
					? { title: row.title.replace(/<!doctype[^>]*>/gi, "").trim() }
					: {}),
			},
			"cleaned",
		);
	return {
		ok: false,
		reason:
			read && "needs" in read
				? read.needs.replace(/ Paste the posting's text instead\.$/, "")
				: resolved && !resolved.ok
					? resolved.reason
					: check.ok
						? "The posting could not be read."
						: check.reason,
	};
}

/**
 * On start: jobs added by link whose stored description is a whole page (an earlier version
 * kept the doctype, menus and banners) are read again once. Only plain pages and board links:
 * LinkedIn, Indeed and Glassdoor are never contacted unasked. Text that can't be read again is
 * cleaned in place, so a job is never retried on every start.
 */
export async function cleanStoredPostings(app: WorkerApp): Promise<number> {
	const rows = await app.db
		.select({
			id: applications.id,
			state: applications.state,
			url: jobs.url,
			description: jobs.descriptionText,
		})
		.from(applications)
		.innerJoin(jobs, eq(jobs.id, applications.jobId))
		.where(
			and(eq(applications.userId, LOCAL_USER_ID), eq(jobs.source, "manual")),
		);
	let done = 0;
	for (const row of rows) {
		if (!looksLikeRawPage(row.description)) continue;
		// Only jobs nothing was drafted for: a drafted, reviewed or approved one is left as it is
		// (its Re-read posting runs the review again).
		if (!["found", "scored", "rejected_by_filter"].includes(row.state))
			continue;
		const check = checkJobLink(row.url);
		const route = check.ok ? routeJobLink(check.url).kind : "page";
		if (route === "linkedin" || route === "indeed" || route === "glassdoor")
			continue;
		const result = await rereadPosting(app, row.id);
		if (result.ok) done += 1;
	}
	return done;
}

import { ENDED_COMPANY_HIDDEN } from "../domain/dismissal";
import type { FilterResult, FilterRule } from "../filter/rules";

/**
 * Scan history: what each scan searched, found, set aside and why, per source. A scan records
 * what it knows itself (each source's status, searches, counts, new jobs, the drops a provider
 * reports); what happens to its new jobs afterwards (the job filter, the fit score) is read from
 * their applications when the history is shown, so the outcome line stays true as they finish.
 */

/* ------------------------------------------------------- provider contract */

/**
 * Why a provider set a posting aside before saving it. Providers fill these; the job filter's
 * and the score's reasons are added from the applications.
 */
const PROVIDER_DROP_REASONS = [
	"already_seen",
	"expired",
	"not_a_job",
	"off_search",
	"other",
] as const;
export type ProviderDropReason = (typeof PROVIDER_DROP_REASONS)[number];

export interface DroppedExample {
	title: string;
	company?: string;
	url?: string;
}

/**
 * Optional fields a provider's run may fill (`ProviderRun` extends this). All optional and
 * additive: a provider that fills none still gets a status, its counts and its new jobs.
 */
export interface ProviderRunReport {
	/** The searches run, as the user would read them ("Senior Frontend Engineer remote"). */
	searches?: string[];
	/** Result and posting pages read. */
	pagesRead?: number;
	/** Listings seen on result pages, before anything was set aside. */
	results?: number;
	/** Postings the app already had (counted, not saved again). */
	duplicates?: number;
	/** Postings set aside before saving, grouped by reason, with a few examples each. */
	dropped?: {
		reason: ProviderDropReason;
		count: number;
		examples?: DroppedExample[];
	}[];
	/** Overrides the status the scan derives from the provider's stored stop. */
	status?: SourceStatus;
	/** With status `retrying`: when the next scan tries again (ISO). */
	retryAt?: string;
	/** A page kept for diagnosis (site-debug), when the worker knows it. */
	debugSnapshot?: string;
	/**
	 * Where the source's next run starts in its list of searches: this run's start plus the
	 * searches it got through. Unset when it got through none (held, waiting, stopped at the first
	 * search): the next run starts where this one did.
	 */
	cursor?: number;
}

/** What a source can report while it runs, for the live progress line. */
export interface ScanProgress {
	source: string;
	label?: string;
	/** The search being run now. */
	query?: string;
}

/**
 * The scan history's hooks, bound to one scan run by the runner. Each is an idempotent upsert:
 * the flow replays on resume and calls them again with the same values.
 */
export interface ScanLog {
	/** The sources this scan runs, in order. */
	start(sources: { id: string; label: string }[]): Promise<void>;
	/** What runs now; null when the sources are done. */
	progress(progress: ScanProgress | null): Promise<void>;
	/** A source's run, as it ended. */
	source(
		run: {
			provider: string;
			queries: number;
			fetched: number;
			newJobIds: string[];
			problem?: string;
		} & ProviderRunReport,
		label: string,
	): Promise<void>;
}

/* ---------------------------------------------------------------- reports */

export type SourceStatus =
	| "ok"
	/** Not due in this scan (LinkedIn's 6-hour wait or its daily pages); `retryAt` says when. */
	| "waiting"
	| "paused_check"
	| "needs_sign_in"
	| "retrying"
	| "off"
	| "not_set_up"
	| "error";

export type ScanTrigger = "timer" | "start" | "manual";

/** One source in one scan, as recorded when its step ends. */
export interface SourceReport {
	id: string;
	label: string;
	status: SourceStatus;
	retryAt?: string;
	problem?: string;
	debugSnapshot?: string;
	searches: string[];
	/** How many searches ran (when the provider does not list them). */
	queries: number;
	pagesRead: number | null;
	results: number | null;
	/** Postings read from the boards or pages (the provider's `fetched`). */
	read: number;
	duplicates: number | null;
	newJobIds: string[];
	dropped: {
		reason: ProviderDropReason;
		count: number;
		examples: DroppedExample[];
	}[];
}

/** Totals over the sources, for the list row. */
export interface ScanTotals {
	searches: number;
	read: number;
	newJobs: number;
	duplicates: number;
	dropped: number;
}

const DROPPED_SAMPLE = 20;

/** The stored stop of a source after its run (Settings › Sources), for its status. */
export interface StoredStop {
	kind: string;
	reason?: string;
	retryAt?: string;
}

const HELD_CHECK = new Set(["captcha", "security_check", "warning"]);

/**
 * A source's status from what is stored, never from its problem's wording: an explicit status
 * from the provider; a held check or sign-in; a transient stop with its retry time; a problem
 * without a stop is an error.
 */
export function sourceStatus(
	run: { status?: SourceStatus; retryAt?: string; problem?: string },
	stop: StoredStop | null,
): { status: SourceStatus; retryAt?: string } {
	if (run.status) return { status: run.status, retryAt: run.retryAt };
	if (stop) {
		if (stop.kind === "login_wall") return { status: "needs_sign_in" };
		if (HELD_CHECK.has(stop.kind)) return { status: "paused_check" };
		return { status: "retrying", retryAt: stop.retryAt };
	}
	return { status: run.problem ? "error" : "ok" };
}

/** A provider's run as the scan records it: the contract fields kept, examples capped. */
export function sourceReport(
	run: {
		provider: string;
		queries: number;
		fetched: number;
		newJobIds: string[];
		problem?: string;
	} & ProviderRunReport,
	label: string,
	stop: StoredStop | null,
	debugSnapshot?: string,
): SourceReport {
	const status = sourceStatus(run, stop);
	let budget = DROPPED_SAMPLE;
	return {
		id: run.provider,
		label,
		...status,
		...(run.problem ? { problem: run.problem.slice(0, 500) } : {}),
		...((run.debugSnapshot ?? debugSnapshot)
			? { debugSnapshot: run.debugSnapshot ?? debugSnapshot }
			: {}),
		searches: (run.searches ?? []).slice(0, 50).map((s) => s.slice(0, 300)),
		queries: run.searches?.length ?? run.queries,
		pagesRead: run.pagesRead ?? null,
		results: run.results ?? null,
		read: run.fetched,
		duplicates: run.duplicates ?? null,
		newJobIds: run.newJobIds,
		dropped: (run.dropped ?? [])
			.filter((d) => d.count > 0)
			.map((d) => {
				const examples = (d.examples ?? []).slice(0, Math.max(0, budget));
				budget -= examples.length;
				return { reason: d.reason, count: d.count, examples };
			}),
	};
}

export function scanTotals(sources: SourceReport[]): ScanTotals {
	const sum = (f: (s: SourceReport) => number) =>
		sources.reduce((n, s) => n + f(s), 0);
	return {
		searches: sum((s) => s.queries),
		read: sum((s) => s.read),
		newJobs: sum((s) => s.newJobIds.length),
		duplicates: sum((s) => s.duplicates ?? 0),
		dropped: sum((s) => s.dropped.reduce((n, d) => n + d.count, 0)),
	};
}

/* ---------------------------------------------------- after the scan ends */

/** What became of one new job, read from its application. */
export type JobFate =
	| { kind: "checking" }
	| { kind: "listed" }
	| { kind: "filtered"; rule: FilterRule | "other"; message: string }
	| { kind: "below_score"; message: string }
	/** From a company the user hid: dismissed by the app, never scored or listed. */
	| { kind: "hidden_company" };

/** The fate of a new job from its application's state, filter result and score reason. */
export function jobFate(
	app: {
		state: string;
		filterResult: FilterResult | null;
		endedReason: string | null;
	} | null,
): JobFate {
	if (!app || app.state === "found") return { kind: "checking" };
	if (app.state === "rejected_by_filter") {
		const reason = app.filterResult?.reasons.find(
			(r) => r.outcome === "reject",
		);
		return {
			kind: "filtered",
			rule: reason?.rule ?? "other",
			message:
				reason?.message ??
				app.filterResult?.summary ??
				"Set aside by your job search",
		};
	}
	if (app.state === "scored" && app.endedReason)
		return { kind: "below_score", message: app.endedReason };
	// A match the user dismissed later was listed; only the app's own dismissal is a drop.
	if (app.state === "dismissed" && app.endedReason === ENDED_COMPANY_HIDDEN)
		return { kind: "hidden_company" };
	return { kind: "listed" };
}

const FILTER_RULE_LABEL: Record<FilterRule | "other", string> = {
	location: "location",
	work_permit: "right to work",
	citizenship: "citizenship",
	language: "language",
	role: "role",
	other: "your job search",
};

const DROP_REASON_LABEL: Record<ProviderDropReason, string> = {
	already_seen: "already seen",
	expired: "expired",
	not_a_job: "not a job page",
	off_search: "outside the search",
	other: "other",
};

/** Every reason a source's postings did not become listed jobs, with counts, biggest first. */
export interface DropGroup {
	key: string;
	label: string;
	count: number;
	/** Where it happened: in the source, or afterwards in the filter or the score. */
	stage: "source" | "filter" | "score";
	examples: DroppedExample[];
}

export function dropGroups(
	source: SourceReport,
	fates: { fate: JobFate; title: string; company: string }[],
): DropGroup[] {
	const groups = new Map<string, DropGroup>();
	const add = (
		key: string,
		label: string,
		stage: DropGroup["stage"],
		count: number,
		example?: DroppedExample,
	) => {
		const g = groups.get(key) ?? { key, label, count: 0, stage, examples: [] };
		g.count += count;
		if (example && g.examples.length < 5) g.examples.push(example);
		groups.set(key, g);
	};
	if (source.duplicates)
		add(
			"already_seen",
			DROP_REASON_LABEL.already_seen,
			"source",
			source.duplicates,
		);
	for (const d of source.dropped) {
		add(d.reason, DROP_REASON_LABEL[d.reason], "source", d.count);
		const g = groups.get(d.reason);
		if (g) g.examples.push(...d.examples.slice(0, 5 - g.examples.length));
	}
	for (const { fate, title, company } of fates) {
		if (fate.kind === "filtered")
			add(
				`filter:${fate.rule}`,
				`filtered by ${FILTER_RULE_LABEL[fate.rule]}`,
				"filter",
				1,
				{ title, company },
			);
		else if (fate.kind === "below_score")
			add("below_score", "scored below your minimum", "score", 1, {
				title,
				company,
			});
		else if (fate.kind === "hidden_company")
			add("hidden_company", "from a company you hid", "filter", 1, {
				title,
				company,
			});
	}
	return [...groups.values()].sort((a, b) => b.count - a.count);
}

/* ---------------------------------------------------------------- outcome */

export interface OutcomeSource {
	report: SourceReport;
	fates: JobFate[];
	/** Unused by the outcome (it groups the drops itself); kept for callers that pass them. */
	drops?: DropGroup[];
}

export type RunState =
	| "queued"
	| "running"
	| "done"
	| "errored"
	/** The run ended without finishing: no runner run left, or a row from before the history. */
	| "interrupted";

const STATUS_PHRASE: Record<SourceStatus, string> = {
	ok: "ran",
	waiting: "waits for its next read",
	paused_check: "paused for a check",
	needs_sign_in: "needs you to sign in",
	retrying: "is waiting to retry",
	off: "is off",
	not_set_up: "is not set up",
	error: "stopped with a problem",
};

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

/** "Remotive", "Remotive and Remote OK", "Remotive, Remote OK and 2 more". */
function inWords(names: string[]): string {
	if (names.length <= 2) return names.join(" and ");
	if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
	return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/** "Indeed stopped: Page cap of 8 reached", "Glassdoor paused for a check". */
function problemPhrase(r: SourceReport): string {
	if (r.status === "error" && r.problem) {
		const first = r.problem.split(/(?<=[^\d])[.;](?:\s|$)/)[0]?.trim() ?? "";
		return `${r.label} stopped: ${first.length > 70 ? `${first.slice(0, 69)}…` : first}`;
	}
	return `${r.label} ${STATUS_PHRASE[r.status]}`;
}

/** Whether a source recorded any work: searches, pages, postings, new jobs or drops. */
function worked(s: OutcomeSource): boolean {
	const r = s.report;
	return (
		r.queries > 0 ||
		r.read > 0 ||
		(r.results ?? 0) > 0 ||
		(r.pagesRead ?? 0) > 0 ||
		(r.duplicates ?? 0) > 0 ||
		r.dropped.some((d) => d.count > 0) ||
		s.fates.length > 0
	);
}

/**
 * The run's one-line outcome, from the data: new matches first; otherwise the biggest reason
 * nothing new came of it (the largest count wins; ties go to the order the checks run in: the
 * source, the filter, the score). Every source's recorded work and drops count, whatever its
 * status; its problem is named after. A count a source did not report is unknown, never zero:
 * "returned no jobs" is said only when a source reported 0 results.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep scan outcome precedence explicit so holds and failures remain ordered before summary fallbacks.
export function scanOutcome(
	sources: OutcomeSource[],
	run: { status: RunState; error?: string | null },
): string {
	if (run.status === "queued") return "Waiting to start";
	const fates = sources.flatMap((s) => s.fates);
	const listed = fates.filter((f) => f.kind === "listed").length;
	const checking = fates.filter((f) => f.kind === "checking").length;
	const fresh = fates.length;
	if (run.status === "running")
		return fresh > 0
			? `Scanning: ${plural(fresh, "new job")} so far`
			: "Scanning…";
	const tail =
		run.status === "interrupted"
			? "; interrupted before it finished"
			: run.status === "errored"
				? `; the scan stopped: ${run.error?.split("\n")[0]?.slice(0, 100) ?? "an error"}`
				: "";
	if (listed > 0)
		return `Found ${plural(listed, "new match", "new matches")}${checking ? `, ${checking} still being checked` : ""}${tail}`;
	if (checking > 0)
		return `${plural(checking, "new job")} found, still being checked${tail}`;
	const active = sources.filter(
		(s) =>
			s.report.status !== "off" &&
			s.report.status !== "not_set_up" &&
			s.report.status !== "waiting",
	);
	const working = active.filter(worked);
	// A source not due in this scan (LinkedIn's wait) is no trouble.
	const troubled = sources.filter(
		(s) =>
			s.report.status !== "ok" &&
			s.report.status !== "off" &&
			s.report.status !== "waiting",
	);
	if (working.length === 0) {
		if (run.status === "errored")
			return `The scan stopped: ${run.error?.split("\n")[0]?.slice(0, 120) ?? "an error"}`;
		if (run.status === "interrupted") return "Interrupted before it finished";
		if (troubled.length === 0) {
			// Sources on but not due in this scan (a feed's or LinkedIn's pace) are not "off".
			const waiting = sources
				.filter((s) => s.report.status === "waiting")
				.map((s) => s.report.label);
			if (active.length === 0 && waiting.length > 0)
				return `Nothing searched: ${inWords(waiting)} ${waiting.length === 1 ? "is" : "are"} not due yet`;
			return active.length === 0
				? "Nothing searched: every source is off"
				: "Nothing searched: no searches to run";
		}
		return `Nothing searched: ${troubled
			.slice(0, 3)
			.map((s) => problemPhrase(s.report))
			.join(", ")}`;
	}
	const problems =
		(troubled.length
			? `; ${troubled
					.slice(0, 2)
					.map((s) => problemPhrase(s.report))
					.join(", ")}`
			: "") + tail;

	// The drops of every source that worked, whatever its status, grouped by reason.
	const groups = new Map<
		string,
		{ label: string; count: number; stage: DropGroup["stage"] }
	>();
	let seen = 0;
	const finders = new Set<string>();
	for (const s of working) {
		const own = dropGroups(
			s.report,
			s.fates.map((fate) => ({ fate, title: "", company: "" })),
		);
		const count =
			s.fates.length +
			(s.report.duplicates ?? 0) +
			s.report.dropped.reduce((m, d) => m + d.count, 0);
		if (count > 0) finders.add(s.report.label);
		seen += count;
		for (const d of own) {
			const g = groups.get(d.key) ?? {
				label: d.label,
				count: 0,
				stage: d.stage,
			};
			g.count += d.count;
			groups.set(d.key, g);
		}
	}
	const stageOrder = { source: 0, filter: 1, score: 2 };
	const top = [...groups.values()].sort(
		(a, b) => b.count - a.count || stageOrder[a.stage] - stageOrder[b.stage],
	)[0];
	if (top && top.count > 0 && seen > 0) {
		const [only] = finders.size === 1 ? [...finders] : [];
		const who = only ? `${only} found ${seen}` : `${plural(seen, "job")} found`;
		const share = top.count === seen ? "all" : String(top.count);
		return `Nothing new: ${who}, ${share} ${top.label}${problems}`;
	}

	// No reason recorded: say only what is known.
	const searches = working.reduce((n, s) => n + s.report.queries, 0);
	const read = working.reduce((n, s) => n + s.report.read, 0);
	const did = searches > 0 ? plural(searches, "search", "searches") : null;
	if (read > 0)
		return `Nothing new: ${did ? `${did} read ` : ""}${plural(read, "posting")}, none new${problems}`;
	const knownEmpty = working.every(
		(s) => s.report.results === 0 && s.report.read === 0,
	);
	if (knownEmpty && did)
		return `Nothing found: ${did} returned no jobs${problems}`;
	return `Nothing new: ${did ?? "the sources"} found no new postings${problems}`;
}

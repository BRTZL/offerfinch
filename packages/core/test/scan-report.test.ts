import { describe, expect, it } from "vitest";
import type { FlowStep, PipelineDeps } from "../src/pipeline/ports";
import type { ScanProvider } from "../src/pipeline/providers";
import { runScanFlow } from "../src/pipeline/scan-flow";
import {
	dropGroups,
	type JobFate,
	jobFate,
	type OutcomeSource,
	type ScanLog,
	type SourceReport,
	scanOutcome,
	scanTotals,
	sourceReport,
	sourceStatus,
} from "../src/pipeline/scan-report";

const report = (
	id: string,
	label: string,
	fields: Partial<SourceReport> = {},
): SourceReport => ({
	id,
	label,
	status: "ok",
	searches: [],
	queries: 1,
	pagesRead: null,
	results: null,
	read: 0,
	duplicates: null,
	newJobIds: [],
	dropped: [],
	...fields,
});

/** A source with its new jobs' fates and its drop groups worked out. */
function source(r: SourceReport, fates: JobFate[] = []): OutcomeSource {
	return {
		report: r,
		fates,
		drops: dropGroups(
			r,
			fates.map((fate, i) => ({ fate, title: `Job ${i}`, company: "Acme" })),
		),
	};
}

const done = { status: "done" as const };
const filtered = (rule: "location" | "language"): JobFate => ({
	kind: "filtered",
	rule,
	message: `${rule} rule`,
});

describe("source status from stored data", () => {
	it("reads held checks, sign-ins and transient stops, never the problem's wording", () => {
		expect(sourceStatus({}, null)).toEqual({ status: "ok" });
		expect(sourceStatus({ problem: "Page cap reached" }, null)).toEqual({
			status: "error",
		});
		expect(sourceStatus({ problem: "x" }, { kind: "login_wall" })).toEqual({
			status: "needs_sign_in",
		});
		expect(sourceStatus({ problem: "x" }, { kind: "captcha" })).toEqual({
			status: "paused_check",
		});
		expect(
			sourceStatus(
				{ problem: "x" },
				{ kind: "blocked", retryAt: "2026-11-02T13:59:00.000Z" },
			),
		).toEqual({ status: "retrying", retryAt: "2026-11-02T13:59:00.000Z" });
		// A provider's own status wins.
		expect(sourceStatus({ status: "not_set_up" }, { kind: "captcha" })).toEqual(
			{
				status: "not_set_up",
			},
		);
	});

	it("keeps the contract fields and caps the dropped examples at 20 in all", () => {
		const examples = Array.from({ length: 15 }, (_, i) => ({ title: `T${i}` }));
		const r = sourceReport(
			{
				provider: "indeed",
				queries: 2,
				fetched: 9,
				newJobIds: ["j1"],
				searches: ["frontend engineer", "react developer"],
				pagesRead: 4,
				results: 30,
				duplicates: 12,
				dropped: [
					{ reason: "expired", count: 15, examples },
					{ reason: "not_a_job", count: 15, examples },
					{ reason: "other", count: 0 },
				],
			},
			"Indeed",
			null,
		);
		expect(r).toMatchObject({
			id: "indeed",
			label: "Indeed",
			status: "ok",
			queries: 2,
			pagesRead: 4,
			results: 30,
			read: 9,
			duplicates: 12,
		});
		expect(
			r.dropped.map((d) => [d.reason, d.count, d.examples.length]),
		).toEqual([
			["expired", 15, 15],
			["not_a_job", 15, 5],
		]);
		expect(scanTotals([r])).toEqual({
			searches: 2,
			read: 9,
			newJobs: 1,
			duplicates: 12,
			dropped: 30,
		});
	});
});

describe("what became of a new job", () => {
	it("reads the filter's rejecting rule and the score's reason from the application", () => {
		expect(jobFate(null)).toEqual({ kind: "checking" });
		expect(
			jobFate({ state: "found", filterResult: null, endedReason: null }),
		).toEqual({
			kind: "checking",
		});
		expect(
			jobFate({
				state: "rejected_by_filter",
				endedReason: null,
				filterResult: {
					decision: "reject",
					summary: "Outside your locations",
					flags: [],
					reasons: [
						{ rule: "language", outcome: "pass", message: "ok" },
						{
							rule: "location",
							outcome: "reject",
							message: "On-site in Berlin",
						},
					],
				},
			}),
		).toEqual({
			kind: "filtered",
			rule: "location",
			message: "On-site in Berlin",
		});
		expect(
			jobFate({
				state: "scored",
				filterResult: null,
				endedReason: "Fit score 41 is below the minimum of 60.",
			}),
		).toEqual({
			kind: "below_score",
			message: "Fit score 41 is below the minimum of 60.",
		});
		expect(
			jobFate({ state: "scored", filterResult: null, endedReason: null }),
		).toEqual({
			kind: "listed",
		});
	});

	it("counts a job from a hidden company as set aside, and a match the user dismissed as listed", () => {
		expect(
			jobFate({
				state: "dismissed",
				filterResult: null,
				endedReason: "company_hidden",
			}),
		).toEqual({ kind: "hidden_company" });
		expect(
			jobFate({
				state: "dismissed",
				filterResult: null,
				endedReason: "not_interested",
			}),
		).toEqual({ kind: "listed" });
		const groups = dropGroups(
			{
				id: "job_board_search",
				label: "Job-board search",
				status: "ok",
				searches: [],
				queries: 1,
				pagesRead: null,
				results: null,
				read: 2,
				duplicates: 0,
				newJobIds: ["a", "b"],
				dropped: [],
			},
			[
				{
					fate: { kind: "hidden_company" },
					title: "Engineer",
					company: "Acme",
				},
				{ fate: { kind: "listed" }, title: "Other", company: "Nimbus" },
			],
		);
		expect(groups).toEqual([
			{
				key: "hidden_company",
				label: "from a company you hid",
				count: 1,
				stage: "filter",
				examples: [{ title: "Engineer", company: "Acme" }],
			},
		]);
	});
});

describe("the outcome line names the biggest cause", () => {
	it("new matches first, with the ones still being checked", () => {
		expect(
			scanOutcome(
				[
					source(report("indeed", "Indeed", { newJobIds: ["a", "b", "c"] }), [
						{ kind: "listed" },
						{ kind: "listed" },
						{ kind: "checking" },
					]),
				],
				done,
			),
		).toBe("Found 2 new matches, 1 still being checked");
		expect(
			scanOutcome(
				[source(report("indeed", "Indeed"), [{ kind: "checking" }])],
				done,
			),
		).toBe("1 new job found, still being checked");
	});

	it("nothing new because one source's jobs were all already seen", () => {
		expect(
			scanOutcome(
				[
					source(report("linkedin", "LinkedIn", { read: 12, duplicates: 12 })),
					source(report("indeed", "Indeed", { read: 0 })),
				],
				done,
			),
		).toBe("Nothing new: LinkedIn found 12, all already seen");
	});

	it("the biggest drop wins over smaller ones, across sources", () => {
		expect(
			scanOutcome(
				[
					source(report("indeed", "Indeed", { duplicates: 1 }), [
						filtered("location"),
						filtered("location"),
						filtered("location"),
					]),
					source(report("glassdoor", "Glassdoor", { duplicates: 1 }), [
						filtered("language"),
					]),
				],
				done,
			),
		).toBe("Nothing new: 6 jobs found, 3 filtered by location");
	});

	it("ties go to the earlier stage: the source before the filter", () => {
		expect(
			scanOutcome(
				[
					source(
						report("indeed", "Indeed", {
							dropped: [{ reason: "expired", count: 1, examples: [] }],
						}),
						[filtered("location")],
					),
				],
				done,
			),
		).toBe("Nothing new: Indeed found 2, 1 expired");
	});

	it("all scored below the minimum", () => {
		expect(
			scanOutcome(
				[
					source(report("job-board-search", "Job-board search"), [
						{ kind: "below_score", message: "x" },
						{ kind: "below_score", message: "y" },
					]),
				],
				done,
			),
		).toBe(
			"Nothing new: Job-board search found 2, all scored below your minimum",
		);
	});

	it("nothing searched: each source that could not run, and why", () => {
		expect(
			scanOutcome(
				[
					source(
						report("indeed", "Indeed", { status: "paused_check", queries: 0 }),
					),
					source(
						report("glassdoor", "Glassdoor", {
							status: "needs_sign_in",
							queries: 0,
						}),
					),
					source(report("linkedin", "LinkedIn", { status: "off", queries: 0 })),
				],
				done,
			),
		).toBe(
			"Nothing searched: Indeed paused for a check, Glassdoor needs you to sign in",
		);
		expect(
			scanOutcome(
				[source(report("indeed", "Indeed", { status: "off" }))],
				done,
			),
		).toBe("Nothing searched: every source is off");
	});

	it("searches that returned nothing, with a source that is waiting to retry", () => {
		expect(
			scanOutcome(
				[
					source(
						report("job-board-search", "Job-board search", {
							queries: 4,
							results: 0,
						}),
					),
					source(
						report("indeed", "Indeed", { status: "retrying", queries: 0 }),
					),
				],
				done,
			),
		).toBe(
			"Nothing found: 4 searches returned no jobs; Indeed is waiting to retry",
		);
	});

	it("a count a source did not report is unknown, never zero (Codex review)", () => {
		// Job-board search before it reports results: nothing new, and nothing claimed about why.
		const unknown = sourceReport(
			{ provider: "job-board-search", queries: 3, fetched: 0, newJobIds: [] },
			"Job-board search",
			null,
		);
		expect(scanOutcome([source(unknown)], done)).toBe(
			"Nothing new: 3 searches found no new postings",
		);
		// It read a posting but did not say why it was not new.
		const read = sourceReport(
			{ provider: "job-board-search", queries: 3, fetched: 1, newJobIds: [] },
			"Job-board search",
			null,
		);
		expect(scanOutcome([source(read)], done)).toBe(
			"Nothing new: 3 searches read 1 posting, none new",
		);
		// With the counts the provider now reports, the cause is named.
		const known = sourceReport(
			{
				provider: "job-board-search",
				queries: 3,
				fetched: 0,
				newJobIds: [],
				results: 1,
				duplicates: 1,
			},
			"Job-board search",
			null,
		);
		expect(scanOutcome([source(known)], done)).toBe(
			"Nothing new: Job-board search found 1, all already seen",
		);
	});

	it("a source that stopped part way counts its work and its drops (Codex review)", () => {
		// One search and five postings read, then the page cap: something was searched.
		const capped = sourceReport(
			{
				provider: "indeed",
				queries: 1,
				fetched: 5,
				newJobIds: [],
				problem: "Page cap of 8 reached; the rest waits for the next scan",
			},
			"Indeed",
			null,
		);
		expect(scanOutcome([{ report: capped, fates: [] }], done)).toBe(
			"Nothing new: 1 search read 5 postings, none new; Indeed stopped: Page cap of 8 reached",
		);
		// A retrying source's ten expired postings outweigh another source's one already seen.
		const retrying = sourceReport(
			{
				provider: "indeed",
				queries: 1,
				fetched: 10,
				newJobIds: [],
				status: "retrying",
				dropped: [{ reason: "expired", count: 10 }],
			},
			"Indeed",
			null,
		);
		const glassdoor = sourceReport(
			{
				provider: "glassdoor",
				queries: 1,
				fetched: 1,
				newJobIds: [],
				duplicates: 1,
			},
			"Glassdoor",
			null,
		);
		expect(
			scanOutcome(
				[
					{ report: retrying, fates: [], drops: [] },
					{ report: glassdoor, fates: [] },
				],
				done,
			),
		).toBe(
			"Nothing new: 11 jobs found, 10 expired; Indeed is waiting to retry",
		);
	});

	it("an interrupted run says so, with what it found", () => {
		expect(scanOutcome([], { status: "interrupted" })).toBe(
			"Interrupted before it finished",
		);
		expect(
			scanOutcome([source(report("indeed", "Indeed"), [{ kind: "listed" }])], {
				status: "interrupted",
			}),
		).toBe("Found 1 new match; interrupted before it finished");
	});

	it("a queued, running or errored scan says so", () => {
		expect(scanOutcome([], { status: "queued" })).toBe("Waiting to start");
		expect(scanOutcome([], { status: "running" })).toBe("Scanning…");
		expect(
			scanOutcome([], {
				status: "errored",
				error: "database is locked\nstack",
			}),
		).toBe("The scan stopped: database is locked");
	});
});

describe("the scan flow records each source", () => {
	it("calls the history hooks in order, and a failing hook never stops the scan", async () => {
		const calls: string[] = [];
		const log: ScanLog = {
			start: async (sources) => {
				calls.push(`start ${sources.map((s) => s.id).join(",")}`);
			},
			progress: async (p) => {
				calls.push(`progress ${p ? p.source : "done"}`);
			},
			source: async (run, label) => {
				calls.push(
					`source ${run.provider} ${label} ${run.searches?.join("|")}`,
				);
				if (run.provider === "b") throw new Error("disk full");
			},
		};
		const provider = (id: string, run: object): ScanProvider => ({
			id,
			label: id.toUpperCase(),
			run: async () => ({
				provider: id,
				queries: 1,
				found: 0,
				fetched: 0,
				newJobIds: [],
				...run,
			}),
		});
		const step: FlowStep = {
			do: (_name, fn) => fn(),
			waitForEvent: async () => {
				throw new Error("no waits");
			},
		};
		const deps = {
			providers: async () => [
				provider("a", { searches: ["react remote"] }),
				provider("b", { searches: ["vue"] }),
			],
			scanLog: log,
			repo: { listUnstartedJobIds: async () => [] },
			workflows: {
				startBatch: async () => ({ created: [], existing: [], failed: [] }),
			},
			log: () => {},
		} as unknown as PipelineDeps;
		const result = await runScanFlow(step, deps, {
			userId: "u1",
			trigger: "manual",
		}).catch((e: Error) => e);
		// The sweep needs a fuller repository; the history calls before it are what count here.
		expect(calls).toEqual([
			"start a,b",
			"progress a",
			"source a A react remote",
			"progress b",
			"source b B vue",
			"progress done",
		]);
		expect(result).toBeDefined();
	});
});

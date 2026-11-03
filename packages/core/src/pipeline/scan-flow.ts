import type { CompanyRef, JobSourceKind } from "../domain/types";
import { LlmPausedError } from "../scoring/llm";
import { meteredFor } from "../scoring/metered";
import { type PlanResult, rulesPlan } from "../search/plan";
import {
	BoardNotFoundError,
	RobotsDisallowedError,
	SourceBlockedError,
} from "../sources/types";
import {
	type ScanWorkflowParams,
	WORKFLOW_BATCH_SIZE,
} from "../workflow/types";
import { type ClosedSweepResult, sweepClosedPostings } from "./closed";
import type { FlowStep, PipelineDeps, StartBatchResult } from "./ports";
import type { ProviderRun, ScanProvider } from "./providers";
import { type SweepResult, sweepStuckApplications } from "./sweep";

export interface CompanyScanResult {
	companyId: string;
	name: string;
	source: JobSourceKind;
	fetched: number;
	newJobIds: string[];
	/** Set when the source is blocked, disallowed or missing; the scan moves on. */
	problem?: string;
}

export interface ScanFlowResult {
	companies: CompanyScanResult[];
	/** Each provider's run, when the scan runs providers (PLAN A). */
	providers?: ProviderRun[];
	jobsFetched: number;
	jobsInserted: number;
	failedCompanies: { companyId: string; name: string; error: string }[];
	workflows: StartBatchResult;
	sweep?: SweepResult;
	/** The re-check of listed board matches for closed postings, when it ran. */
	closedPostings?: ClosedSweepResult;
}

/**
 * Fetches one source and saves its new jobs. Known terminal problems (block, robots, missing board)
 * are recorded on the company and returned; anything else throws so the step is retried.
 */
export async function scanCompany(
	deps: PipelineDeps,
	userId: string,
	company: CompanyRef,
): Promise<CompanyScanResult> {
	const result: CompanyScanResult = {
		companyId: company.id,
		name: company.name,
		source: company.source,
		fetched: 0,
		newJobIds: [],
	};
	const source = deps.sources[company.source];
	if (!source) {
		result.problem = `no ${company.source} source configured`;
		return result;
	}
	let jobs: Awaited<ReturnType<typeof source.listJobs>>;
	try {
		jobs = await source.listJobs({
			sourceKey: company.sourceKey,
			parser: company.scrapeParser,
			companyName: company.name,
			// Careers-page extraction is spend for this user, with no application yet.
			llm: meteredFor(deps.llm, deps.spend, userId, null),
		});
	} catch (error) {
		if (error instanceof LlmPausedError) {
			// Not the source's fault: its health stays, and the next scan with room tries again.
			result.problem = error.message;
			return result;
		}
		if (error instanceof SourceBlockedError) {
			await deps.repo.setCompanyHealth(
				userId,
				company.id,
				"needs_human",
				error.reason,
			);
		} else if (error instanceof RobotsDisallowedError) {
			await deps.repo.setCompanyHealth(
				userId,
				company.id,
				"robots_disallowed",
				error.message,
			);
		} else if (error instanceof BoardNotFoundError) {
			await deps.repo.setCompanyHealth(
				userId,
				company.id,
				"error",
				error.message,
			);
		} else {
			throw error;
		}
		result.problem = error.message;
		return result;
	}
	result.fetched = jobs.length;
	if (company.source === "scrape" && jobs.length === 0) {
		result.problem =
			"no jobs found on the careers page; it may need a site parser";
		await deps.repo.setCompanyHealth(
			userId,
			company.id,
			"error",
			result.problem,
		);
		return result;
	}
	for (const job of jobs) {
		const { jobId, inserted } = await deps.repo.upsertJob(
			userId,
			company.id,
			job,
		);
		if (inserted) result.newJobIds.push(jobId);
	}
	await deps.repo.setCompanyHealth(userId, company.id, "ok", null);
	return result;
}

/**
 * One provider as its own retryable step, then its record (Sources) and history (Scans): its
 * own row, and one per part of its run (LinkedIn's Top picks). A provider's failure is its
 * problem, never the scan's, except a paused model, which pauses the scan.
 */
async function runProvider(
	step: FlowStep,
	deps: PipelineDeps,
	userId: string,
	provider: ScanProvider,
	scan: {
		plan: PlanResult | undefined;
		history: (
			what: string,
			fn: () => Promise<void> | undefined,
		) => Promise<void>;
	},
): Promise<ProviderRun> {
	const { plan, history } = scan;
	await history("progress", () =>
		deps.scanLog?.progress({ source: provider.id, label: provider.label }),
	);
	let run: ProviderRun;
	try {
		run = await step.do(
			`provider ${provider.id}`,
			async (signal) =>
				provider.run(
					deps,
					userId,
					signal,
					plan,
					await deps.providerCursor?.(userId, provider.id),
				),
			{ retries: 2, timeoutSeconds: provider.timeoutSeconds ?? 900 },
		);
	} catch (error) {
		if (error instanceof LlmPausedError) throw error;
		run = {
			provider: provider.id,
			queries: 0,
			found: 0,
			fetched: 0,
			newJobIds: [],
			problem: (error instanceof Error ? error.message : String(error)).slice(
				0,
				500,
			),
		};
	}
	await step.do(`record provider ${provider.id}`, async () => {
		await deps.recordProviderRun?.(userId, run);
	});
	await history("source", () => deps.scanLog?.source(run, provider.label));
	for (const part of run.parts ?? [])
		await history("source", () => deps.scanLog?.source(part, part.label));
	deps.log?.("provider ran", {
		provider: provider.id,
		queries: run.queries,
		found: run.found,
		new: run.newJobIds.length,
		problem: run.problem,
	});
	return run;
}

/**
 * The scan's search plan. `deps.searchPlan` never throws by contract; should it anyway (a
 * database error), the rules' plan from Job search stands in. Never stops the scan.
 */
async function searchPlanFor(
	deps: PipelineDeps,
	userId: string,
): Promise<PlanResult> {
	try {
		if (deps.searchPlan) return await deps.searchPlan(userId);
	} catch (error) {
		deps.log?.("search plan failed", { error: String(error) });
	}
	try {
		const searches = rulesPlan(
			await deps.repo.getFilterSettings(userId),
			await deps.repo.getProfile(userId),
		).map((s) => ({ ...s, by: "rules" as const }));
		return { searches, generatedAt: null, basis: "rules" };
	} catch (error) {
		// Each provider reads Job search itself and says when there is nothing to search.
		deps.log?.("search plan failed", { error: String(error) });
		return { searches: [], generatedAt: null, basis: null };
	}
}

/**
 * A few listed board matches older than a week are checked for a closed posting, last in the
 * scan so nothing waits on it. Bounded (3 postings, 10 s each, 2 s apart), never retried, and
 * never fails the scan: an error here is logged and the scan ends as it would have. The postings
 * picked and each finished check are steps of their own, so a replay after a crash re-uses them
 * and the per-scan cap holds.
 */
async function checkClosedPostings(
	step: FlowStep,
	deps: PipelineDeps,
	userId: string,
): Promise<ClosedSweepResult | undefined> {
	const store = deps.closedPostings;
	if (!store) return undefined;
	try {
		return await sweepClosedPostings(
			{
				store,
				sources: deps.sources,
				now: deps.now,
				sleep: deps.sleep,
				log: deps.log,
				journal: (name, fn) =>
					step.do(name, fn, { retries: 0, timeoutSeconds: 30 }),
			},
			userId,
		);
	} catch (error) {
		deps.log?.("closed posting check failed", { error: String(error) });
		return undefined;
	}
}

function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size)
		chunks.push(items.slice(i, i + size));
	return chunks;
}

/**
 * ScanWorkflow body: each source is its own retryable step, then one ApplicationWorkflow is
 * started per new job, in batches of 100. Instance ids come from job ids, so a retry cannot
 * start a job twice; jobs a failed run left unstarted are picked up here too.
 */
export async function runScanFlow(
	step: FlowStep,
	deps: PipelineDeps,
	params: ScanWorkflowParams,
): Promise<ScanFlowResult> {
	const { userId } = params;
	const result: ScanFlowResult = {
		companies: [],
		jobsFetched: 0,
		jobsInserted: 0,
		failedCompanies: [],
		workflows: { created: [], existing: [], failed: [] },
	};
	// Providers search the internet; the company watchlist is never scanned alongside them.
	const providers = deps.providers ? await deps.providers(userId) : null;
	if (providers) result.providers = [];
	// History never stops a scan: a failed write is logged and the scan goes on.
	const history = async (what: string, fn: () => Promise<void> | undefined) => {
		try {
			await fn();
		} catch (error) {
			deps.log?.("scan history not written", { what, error: String(error) });
		}
	};
	if (providers)
		await history("start", () =>
			deps.scanLog?.start(providers.map((p) => ({ id: p.id, label: p.label }))),
		);
	// One plan for every source, written before any of them runs (once a day by the model).
	const plan =
		providers && providers.length > 0
			? await step.do("search plan", () => searchPlanFor(deps, userId))
			: undefined;
	if (plan?.note) deps.log?.("search plan", { note: plan.note });
	for (const provider of providers ?? []) {
		const run = await runProvider(step, deps, userId, provider, {
			plan,
			history,
		});
		result.providers?.push(run);
		for (const r of [run, ...(run.parts ?? [])]) {
			result.jobsFetched += r.fetched;
			result.jobsInserted += r.newJobIds.length;
		}
	}
	if (providers) await history("progress", () => deps.scanLog?.progress(null));
	const companies = providers
		? []
		: await step.do("list companies", () =>
				deps.repo.listActiveCompanies(userId, params.companyIds),
			);

	for (const company of companies) {
		try {
			const scanned = await step.do(
				`scan ${company.source} ${company.id}`,
				() => scanCompany(deps, userId, company),
				{
					retries: 3,
					timeoutSeconds: 300,
				},
			);
			result.companies.push(scanned);
			result.jobsFetched += scanned.fetched;
			result.jobsInserted += scanned.newJobIds.length;
			deps.log?.("company scanned", {
				name: company.name,
				fetched: scanned.fetched,
				new: scanned.newJobIds.length,
				problem: scanned.problem,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result.failedCompanies.push({
				companyId: company.id,
				name: company.name,
				error: message,
			});
			await step.do(`record failure ${company.id}`, () =>
				deps.repo.setCompanyHealth(
					userId,
					company.id,
					"error",
					message.slice(0, 500),
				),
			);
			deps.log?.("company scan failed", { name: company.name, error: message });
		}
	}

	const unstarted = await step.do("list unstarted jobs", () =>
		deps.repo.listUnstartedJobIds(userId, 5_000),
	);
	for (const [index, jobIds] of chunk(
		unstarted,
		WORKFLOW_BATCH_SIZE,
	).entries()) {
		const batch = await step.do(
			`start application workflows ${index}`,
			async () => {
				const started = await deps.workflows.startBatch(
					jobIds.map((jobId) => ({ userId, jobId })),
				);
				await deps.repo.markWorkflowsStarted(
					userId,
					[...started.created, ...started.existing],
					deps.workflows.runtime,
				);
				return started;
			},
		);
		result.workflows.created.push(...batch.created);
		result.workflows.existing.push(...batch.existing);
		result.workflows.failed.push(...batch.failed);
	}
	// Applications whose workflow failed and left the job in `found` get their instance restarted.
	result.sweep = await step.do("sweep stuck applications", () =>
		sweepStuckApplications(deps, userId),
	);
	result.closedPostings = await checkClosedPostings(step, deps, userId);
	deps.log?.("scan finished", {
		userId,
		fetched: result.jobsFetched,
		inserted: result.jobsInserted,
		started: result.workflows.created.length,
		swept: result.sweep.restarted.length,
	});
	return result;
}

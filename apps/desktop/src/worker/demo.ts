import type { NormalizedJob } from "@offerfinch/core/domain/types";
import type { PipelineDeps } from "@offerfinch/core/pipeline/ports";
import type {
	ProviderRun,
	ScanProvider,
} from "@offerfinch/core/pipeline/providers";
import { recordsFromStructured } from "@offerfinch/core/profile/records";
import { fakeStructureResponder } from "@offerfinch/core/profile/structure";
import {
	type GenerateObjectRequest,
	LlmPausedError,
	type LlmProvider,
} from "@offerfinch/core/scoring/llm";
import {
	DashboardRepository,
	type Database,
	replaceRecords,
	SqliteSearchStore,
	saveFilterSettings,
} from "@offerfinch/db";
import { SETUP_STEPS } from "../shared/setup-steps";
import { SAMPLE_JOBS, SAMPLE_RESUME, SAMPLE_RULES } from "./demo-data";
import { LOCAL_USER_ID, SettingsStore } from "./settings";
import type { CliState, Subscriptions } from "./subscriptions";

/**
 * Try-it mode (docs/decisions.md, 2026-11-05): the worker runs on a demo folder of its own with
 * the test models on every role, the sample profile and rules, notifications off, and one
 * in-process source that hands out the eight sample jobs. No real source, CLI or network.
 */

/** The sample source's id and name in the scan history. */
export const SAMPLE_PROVIDER_ID = "sample";

/** Where the sample jobs point: a reserved name (RFC 2606), so no link ever reaches a site. */
const SAMPLE_ORIGIN = "https://jobs.sample.invalid";

/** The source of try-it mode: the eight sample jobs, inserted directly, never fetched. */
export class SampleJobsProvider implements ScanProvider {
	readonly id = SAMPLE_PROVIDER_ID;
	readonly label = "Sample jobs";
	readonly timeoutSeconds = 60;

	constructor(private readonly db: Database) {}

	async run(deps: PipelineDeps, userId: string): Promise<ProviderRun> {
		const store = new SqliteSearchStore(this.db);
		const out: ProviderRun = {
			provider: this.id,
			queries: 1,
			found: 0,
			fetched: SAMPLE_JOBS.length,
			newJobIds: [],
			results: SAMPLE_JOBS.length,
			duplicates: 0,
			searches: ["The sample jobs"],
		};
		deps.scanProgress?.(userId, { source: this.id, label: this.label });
		for (const sample of SAMPLE_JOBS) {
			if (await store.hasPosting(userId, "sample", sample.id)) {
				out.duplicates = (out.duplicates ?? 0) + 1;
				continue;
			}
			const companyId = await store.companyFor(userId, {
				name: sample.company,
				source: "sample",
				sourceKey: `sample:${sample.company.toLowerCase()}`,
			});
			const job: NormalizedJob = {
				source: "sample",
				externalId: sample.id,
				url: `${SAMPLE_ORIGIN}/${sample.id}`,
				title: sample.title,
				locations: sample.locations,
				workplaceType: sample.workplaceType,
				descriptionText: sample.description,
				companyName: sample.company,
			};
			const { jobId, inserted } = await deps.repo.upsertJob(
				userId,
				companyId,
				job,
			);
			if (inserted) {
				out.found++;
				out.newJobIds.push(jobId);
			} else out.duplicates = (out.duplicates ?? 0) + 1;
		}
		return out;
	}
}

/**
 * Fills a new demo database once: the sample profile (structured without a model), the sample
 * rules, the test models on every role, every notification off, setup finished and What's new
 * seen. A database that already has a profile is left as it is.
 */
export async function seedDemo(db: Database, version: string): Promise<void> {
	const repo = new DashboardRepository(db);
	if (await repo.profileFiles(LOCAL_USER_ID)) return;
	const structured = fakeStructureResponder({
		context: { text: SAMPLE_RESUME },
	} as GenerateObjectRequest<unknown>);
	await replaceRecords(
		db,
		LOCAL_USER_ID,
		recordsFromStructured(structured, "sample data"),
	);
	await saveFilterSettings(db, LOCAL_USER_ID, SAMPLE_RULES);
	const settings = new SettingsStore(db);
	await settings.set("ai", {
		scoring: { mode: "fake" },
		tailoring: { mode: "fake" },
		claims: { mode: "fake" },
	});
	await settings.set("notifications", {
		match: false,
		question: false,
		review: false,
		stopped: false,
		followup: false,
	});
	await settings.set("onboarding", {
		done: [...SETUP_STEPS],
		skipped: [],
		dismissed: false,
		completedAt: new Date().toISOString(),
	});
	await settings.set("whatsNewSeen", version);
	if (!(await repo.profileFiles(LOCAL_USER_ID)))
		throw new Error("The sample profile was not saved");
}

const NOT_IN_DEMO =
	"Claude Code and Codex are not used with sample data. Leave demo to connect your AI.";

/** A plan in try-it mode: never found, never run; the demo uses the test models. */
class DemoCli implements LlmProvider {
	readonly billing = "subscription" as const;
	constructor(readonly name: string) {}
	async generateObject<T>(_request: GenerateObjectRequest<T>): Promise<T> {
		throw new LlmPausedError(NOT_IN_DEMO);
	}
}

const absent: CliState = {
	path: null,
	version: null,
	tested: "demo",
	login: { state: "logged_out", detail: NOT_IN_DEMO },
	command: null,
	fix: null,
};

/**
 * `Subscriptions` in try-it mode: no CLI on this Mac is looked for, run or asked, and no login
 * shell is started. Every check reads as not installed.
 */
export function demoSubscriptions(): Subscriptions {
	return {
		refresh: async () => "",
		usePath: () => {},
		factory: ({ provider, model }) => new DemoCli(`${provider}:${model ?? ""}`),
		claude: async () => absent,
		codex: async () => absent,
	};
}

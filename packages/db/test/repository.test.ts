import {
	ApprovalRequiredError,
	hashDocuments,
} from "@offerfinch/core/domain/approval";
import { InvalidTransitionError } from "@offerfinch/core/domain/states";
import type { NormalizedJob } from "@offerfinch/core/domain/types";
import type { ExportInput, ExportResult } from "@offerfinch/core/export/export";
import { NoopNotifier } from "@offerfinch/core/notify/ntfy";
import { runApplicationFlow } from "@offerfinch/core/pipeline/application-flow";
import {
	LocalStep,
	LocalWorkflowStarter,
} from "@offerfinch/core/pipeline/local";
import type { PipelineDeps } from "@offerfinch/core/pipeline/ports";
import { runScanFlow } from "@offerfinch/core/pipeline/scan-flow";
import { loadProfileFromDir } from "@offerfinch/core/profile/load-node";
import { FakeLlmProvider } from "@offerfinch/core/scoring/fake";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type Database,
	DrizzlePipelineRepository,
	ensureUser,
	importProfile,
	removeCompany,
	saveFilterSettings,
	seedCompanies,
} from "../src/index";
import { documents } from "../src/schema/pipeline";
import { execute, testDb } from "./setup";

let db: Database;
let repo: DrizzlePipelineRepository;

const job = (
	n: number,
	overrides: Partial<NormalizedJob> = {},
): NormalizedJob => ({
	source: "greenhouse",
	externalId: String(n),
	url: `https://boards.greenhouse.io/acme/jobs/${n}`,
	title: "Senior Software Engineer",
	locations: ["Ankara, Turkey"],
	workplaceType: "hybrid",
	descriptionText: "Requirements\n- TypeScript and React\n- PostgreSQL",
	...overrides,
});

const count = async (table: string) =>
	Number(
		(
			await execute<{ n: number }>(
				db,
				sql.raw(`select count(*) as n from ${table}`),
			)
		)[0]?.n,
	);

beforeAll(async () => {
	db = await testDb();
	repo = new DrizzlePipelineRepository(db);
	await saveFilterSettings(db, "u1", {
		// The fabricated persona's rules; the product's defaults name no country.
		rightToWork: ["Turkey"],
		keepOnsiteIn: ["Turkey"],
		languages: ["English", "Turkish"],
	});
	await importProfile(
		db,
		"u1",
		await loadProfileFromDir(
			new URL("../../core/test/fixtures/tailor-profile", import.meta.url)
				.pathname,
		),
		"test",
	);
});

/** A new job's application, moved to scored, for tests that drive transitions by hand. */
let freshJob = 1000;
async function scoredApp(): Promise<{ id: string; job_id: string }> {
	const [company] = await execute<{ id: string }>(
		db,
		sql`select id from companies where user_id = 'u1' and status = 'active' limit 1`,
	);
	freshJob += 1;
	const { jobId } = await repo.upsertJob(
		"u1",
		company?.id ?? "",
		job(freshJob),
	);
	const app = await repo.getApplicationByJob("u1", jobId);
	if (!app) throw new Error("no app");
	await repo.transition("u1", app.applicationId, {
		from: ["found"],
		to: "scored",
		reason: "test",
		actor: "workflow",
	});
	return { id: app.applicationId, job_id: jobId };
}

/** Records what would be exported and finds no ATS problems (the real export has its own test). */
const noopExporter = async (input: ExportInput): Promise<ExportResult> => ({
	records: input.documents.map((d) => ({
		kind: d.kind,
		format: "pdf" as const,
		sourceVersion: d.version,
		storageKey: `test/${d.kind}-v${d.version}.pdf`,
		meta: { pages: 1 },
	})),
	atsIssues: [],
});

afterAll(async () => {
	db.$close();
});

describe("watchlist", () => {
	it("seeds idempotently and never re-adds a removed company", async () => {
		const seeds = [
			{
				name: "Acme",
				source: "greenhouse" as const,
				sourceKey: "acme",
				discoveredFrom: "test",
			},
			{
				name: "Removed Co",
				source: "lever" as const,
				sourceKey: "removedco",
				discoveredFrom: "test",
			},
		];
		expect((await seedCompanies(db, "u1", seeds)).inserted).toEqual([
			"Acme",
			"Removed Co",
		]);
		expect(await removeCompany(db, "u1", "Removed Co")).toBe(1);
		const again = await seedCompanies(db, "u1", [
			...seeds,
			{
				name: "Removed Co",
				source: "ashby",
				sourceKey: "removed-co",
				discoveredFrom: "test",
			},
		]);
		expect(again.inserted).toEqual([]);
		expect(again.existing).toEqual(["Acme"]);
		expect(again.skippedRemoved).toEqual(["Removed Co", "Removed Co"]);
		const statuses = await execute<{ name: string; status: string }>(
			db,
			sql`select name, status from companies order by name`,
		);
		expect(statuses.map((r) => `${r.name}:${r.status}`)).toEqual([
			"Acme:active",
			"Removed Co:removed",
		]);
		expect((await repo.listActiveCompanies("u1")).map((c) => c.name)).toEqual([
			"Acme",
		]);
	});
});

describe("scan against Postgres", () => {
	it("stores jobs once and repeats nothing on a second scan", async () => {
		const notifier = new NoopNotifier();
		const workflows = new LocalWorkflowStarter();
		const postings = [
			job(1),
			job(2, {
				externalId: "2",
				url: "https://boards.greenhouse.io/acme/jobs/1?gh_src=linkedin",
			}),
			job(3, { title: "Account Executive" }),
		];
		// This test follows a match through drafting: every match counts as prepared (Prepare on
		// demand is covered in prepare.test.ts and the runner's flow test).
		const prepared = Object.assign(
			Object.create(Object.getPrototypeOf(repo)) as DrizzlePipelineRepository,
			repo,
			{
				prepareRequested: async () => true,
				// Nor is a stored Prepare request needed to start drafting.
				transition: (
					...[userId, applicationId, input]: Parameters<
						DrizzlePipelineRepository["transition"]
					>
				) =>
					repo.transition(userId, applicationId, {
						...input,
						requirePrepareRequest: false,
					}),
			},
		);
		const deps: PipelineDeps = {
			repo: prepared,
			sources: {
				greenhouse: { kind: "greenhouse", listJobs: async () => postings },
			},
			llm: new FakeLlmProvider(),
			claimsLlm: new FakeLlmProvider(),
			exporter: noopExporter,
			notifier,
			workflows,
		};
		workflows.bind(deps);

		const first = await runScanFlow(new LocalStep(), deps, {
			userId: "u1",
			trigger: "cli",
		});
		expect(first.jobsInserted).toBe(2); // job 2 is job 1 under a tracking URL
		expect(await count("jobs")).toBe(2);
		const states = await execute<{ state: string }>(
			db,
			sql`select state from applications order by state`,
		);
		// SQLite stores the states as text: ordered alphabetically.
		expect(states.map((r) => r.state)).toEqual([
			"ready_for_review",
			"rejected_by_filter",
		]);
		// The kept job was drafted, reviewed and exported, all recorded in Postgres.
		expect(await count("documents")).toBe(6);
		const [review] = await execute<{ passed: boolean; ats: boolean }>(
			db,
			sql`select passed, ats_checked_at is not null as ats from review_checks`,
		);
		expect(review).toEqual({ passed: 1, ats: 1 }); // SQLite booleans are 0/1 in raw SQL
		expect(notifier.sent).toHaveLength(1);

		const before = {
			jobs: await count("jobs"),
			apps: await count("applications"),
			transitions: await count("application_transitions"),
		};
		const second = await runScanFlow(new LocalStep(), deps, {
			userId: "u1",
			trigger: "cli",
		});
		expect(second.jobsInserted).toBe(0);
		expect(second.workflows.created).toEqual([]);
		expect({
			jobs: await count("jobs"),
			apps: await count("applications"),
			transitions: await count("application_transitions"),
		}).toEqual(before);
		expect(notifier.sent).toHaveLength(1);

		const unstarted = await repo.listUnstartedJobIds("u1", 10);
		expect(unstarted).toEqual([]);
		const ids = await execute<{
			workflow_instance_id: string;
			job_id: string;
		}>(db, sql`select workflow_instance_id, job_id from applications`);
		for (const row of ids)
			expect(row.workflow_instance_id).toBe(`job-${row.job_id}`);
	});

	it("enforces the state machine in Postgres", async () => {
		const app = await scoredApp();
		await expect(
			repo.transition("u1", app.id, {
				from: ["scored"],
				to: "approved",
				reason: "x",
				actor: "user",
			}),
		).rejects.toBeInstanceOf(InvalidTransitionError);
		expect(
			await repo.transition("u1", app.id, {
				from: ["ready_for_review"],
				to: "approved",
				reason: "x",
				actor: "user",
			}),
		).toBe(false);
		expect(await repo.getState("u1", app.id)).toBe("scored");
	});

	it("records user actions once per idempotency key and consumes events once", async () => {
		const app = await scoredApp();
		const first = await repo.recordUserAction({
			userId: "u1",
			applicationId: app.id,
			idempotencyKey: "start-prep-1",
			transition: { from: ["scored"], to: "preparing", reason: "user asked" },
		});
		const again = await repo.recordUserAction({
			userId: "u1",
			applicationId: app.id,
			idempotencyKey: "start-prep-1",
			transition: { from: ["scored"], to: "preparing", reason: "user asked" },
		});
		expect(first.created).toBe(true);
		expect(again).toEqual({ ...first, created: false });
		expect(first.instanceId).toBe(`job-${app.job_id}`);
		expect(await repo.getState("u1", app.id)).toBe("preparing");
		expect(await repo.consumeEvent("u1", app.id, first.eventId)).toBe(true);
		expect(await repo.consumeEvent("u1", app.id, first.eventId)).toBe(false);
	});
});

describe("owner scoping in Postgres", () => {
	it("fails a workflow given user A with user B's job and leaves B's rows untouched", async () => {
		await ensureUser(db, { id: "u2", name: "Other", email: "u2@example.test" });
		const seeded = await seedCompanies(db, "u2", [
			{
				name: "Other Co",
				source: "greenhouse",
				sourceKey: "otherco",
				discoveredFrom: "test",
			},
		]);
		expect(seeded.inserted).toEqual(["Other Co"]);
		const [company] = await execute<{ id: string }>(
			db,
			sql`select id from companies where user_id = 'u2'`,
		);
		if (!company) throw new Error("no company");
		const { jobId } = await repo.upsertJob(
			"u2",
			company.id,
			job(900, { url: "https://boards.greenhouse.io/otherco/jobs/900" }),
		);
		const snapshot = async () =>
			execute(
				db,
				sql`select a.state, a.filter_result, a.score, a.alerted_at, a.updated_at, (select count(*) from application_transitions t where t.application_id = a.id) as transitions from applications a where a.user_id = 'u2'`,
			);
		const before = await snapshot();
		const workflows = new LocalWorkflowStarter();
		const deps: PipelineDeps = {
			repo,
			sources: {},
			llm: new FakeLlmProvider(),
			notifier: new NoopNotifier(),
			workflows,
		};
		await expect(
			runApplicationFlow(new LocalStep(), deps, { userId: "u1", jobId }),
		).rejects.toThrow(/owned by user u1/);
		expect(await snapshot()).toEqual(before);

		const [app] = await execute<{ id: string }>(
			db,
			sql`select id from applications where user_id = 'u2'`,
		);
		if (!app) throw new Error("no app");
		expect(await repo.getApplicationByJob("u1", jobId)).toBeNull();
		expect(await repo.getState("u1", app.id)).toBeNull();
		expect(await repo.claimAlert("u1", app.id)).toBe(false);
		expect(
			await repo.transition("u1", app.id, {
				from: ["found"],
				to: "scored",
				reason: "x",
				actor: "workflow",
			}),
		).toBe(false);
		await expect(repo.upsertJob("u1", company.id, job(901))).rejects.toThrow(
			/not owned/,
		);
		expect(await snapshot()).toEqual(before);
	});
});

describe("approval in Postgres", () => {
	it("refuses applying unless an unrevoked approval matches the current document hashes", async () => {
		const appId = (await scoredApp()).id;
		await repo.transition("u1", appId, {
			from: ["scored"],
			to: "preparing",
			reason: "test",
			actor: "workflow",
		});
		const addDoc = (version: number, content: string) =>
			db.insert(documents).values({
				userId: "u1",
				applicationId: appId,
				kind: "cv",
				format: "markdown",
				version,
				content,
			});
		await addDoc(1, "# CV v1");
		// preparing can no longer hand off to needs_human (a route into applying around approval).
		await expect(
			repo.transition("u1", appId, {
				from: ["preparing"],
				to: "needs_human",
				reason: "x",
				actor: "workflow",
			}),
		).rejects.toBeInstanceOf(InvalidTransitionError);
		await repo.transition("u1", appId, {
			from: ["preparing"],
			to: "ready_for_review",
			reason: "prepared",
			actor: "workflow",
		});
		const [posting] = await execute<{
			title: string;
			description: string;
			company: string;
		}>(
			db,
			sql`select j.title as title, j.description_text as description, c.name as company
				from applications a join jobs j on j.id = a.job_id join companies c on c.id = j.company_id
				where a.id = ${appId}`,
		);
		const v1 = await hashDocuments(
			[{ kind: "cv", content: "# CV v1" }],
			posting,
		);
		const passReview = async (hashes: typeof v1) => {
			const id = await repo.recordReview("u1", appId, {
				documentHashes: hashes,
				provider: "test",
				passed: true,
				issues: [],
				claims: [],
			});
			await repo.completeReview("u1", id, []);
		};
		// Approval needs a passed review of these exact documents.
		await expect(
			repo.recordUserAction({
				userId: "u1",
				applicationId: appId,
				idempotencyKey: "approve-unreviewed",
				transition: {
					from: ["ready_for_review"],
					to: "approved",
					reason: "ok",
				},
				approvedHashes: v1,
			}),
		).rejects.toThrow(/have not been reviewed/);
		await passReview(v1);
		// Approving hashes the user did not see is refused.
		await expect(
			repo.recordUserAction({
				userId: "u1",
				applicationId: appId,
				idempotencyKey: "approve-stale",
				transition: {
					from: ["ready_for_review"],
					to: "approved",
					reason: "ok",
				},
				approvedHashes: await hashDocuments(
					[{ kind: "cv", content: "old" }],
					posting,
				),
			}),
		).rejects.toBeInstanceOf(ApprovalRequiredError);
		await repo.recordUserAction({
			userId: "u1",
			applicationId: appId,
			idempotencyKey: "approve-1",
			transition: { from: ["ready_for_review"], to: "approved", reason: "ok" },
			approvedHashes: v1,
		});
		expect((await repo.checkApproval("u1", appId)).ok).toBe(true);

		await addDoc(2, "# CV v2 with an edit");
		expect(await repo.checkApproval("u1", appId)).toEqual({
			ok: false,
			reason: "cv changed after approval",
		});
		await expect(
			repo.transition("u1", appId, {
				from: ["approved"],
				to: "applying",
				reason: "x",
				actor: "workflow",
			}),
		).rejects.toBeInstanceOf(ApprovalRequiredError);
		expect(await repo.getState("u1", appId)).toBe("approved");

		// Sending it back to review revokes the approval.
		await repo.transition("u1", appId, {
			from: ["approved"],
			to: "ready_for_review",
			reason: "cv edited",
			actor: "user",
		});
		const [approval] = await execute<{ revoked_reason: string }>(
			db,
			sql`select revoked_reason from approvals where application_id = ${appId}`,
		);
		expect(approval?.revoked_reason).toBe("cv edited");
		expect((await repo.checkApproval("u1", appId)).ok).toBe(false);

		const v2 = await hashDocuments(
			[{ kind: "cv", content: "# CV v2 with an edit" }],
			posting,
		);
		await expect(
			repo.recordUserAction({
				userId: "u1",
				applicationId: appId,
				idempotencyKey: "approve-2-unreviewed",
				transition: {
					from: ["ready_for_review"],
					to: "approved",
					reason: "ok",
				},
				approvedHashes: v2,
			}),
		).rejects.toThrow(/not passed review in their current version/);
		await passReview(v2);
		await repo.recordUserAction({
			userId: "u1",
			applicationId: appId,
			idempotencyKey: "approve-2",
			transition: { from: ["ready_for_review"], to: "approved", reason: "ok" },
			approvedHashes: await hashDocuments(
				[{ kind: "cv", content: "# CV v2 with an edit" }],
				posting,
			),
		});
		expect(
			await repo.transition("u1", appId, {
				from: ["approved"],
				to: "applying",
				reason: "submit",
				actor: "workflow",
			}),
		).toBe(true);
	});
});

describe("sweep query in Postgres", () => {
	it("lists only found applications whose workflow started before the cutoff", async () => {
		const [company] = await execute<{ id: string }>(
			db,
			sql`select id from companies where user_id = 'u1' and status = 'active' limit 1`,
		);
		const { jobId } = await repo.upsertJob("u1", company?.id ?? "", job(4242));
		expect(
			await repo.listStuckFoundJobIds("u1", new Date(Date.now() + 60_000), 10),
		).not.toContain(jobId);
		await repo.markWorkflowsStarted("u1", [jobId], "cloudflare");
		expect(
			await repo.listStuckFoundJobIds("u1", new Date(Date.now() + 60_000), 10),
		).toContain(jobId);
		expect(
			await repo.listStuckFoundJobIds("u1", new Date(Date.now() - 60_000), 10),
		).not.toContain(jobId);
		expect(
			await repo.listStuckFoundJobIds("u2", new Date(Date.now() + 60_000), 10),
		).not.toContain(jobId);
	});
});

describe("a job added by hand", () => {
	it("is stored with the manual source and its company is never scanned", async () => {
		await seedCompanies(db, "u1", [
			{
				name: "Hand Added Co",
				source: "manual",
				sourceKey: "dev-fixture-hand-added-co",
				discoveredFrom: "dev:seed-job",
			},
		]);
		const [company] = await execute<{ id: string; source: string }>(
			db,
			sql`select id, source from companies where name = 'Hand Added Co'`,
		);
		expect(company?.source).toBe("manual");
		const { jobId } = await repo.upsertJob("u1", company?.id ?? "", {
			...job(900),
			source: "manual",
		});
		const [stored] = await execute<{ source: string }>(
			db,
			sql`select source from jobs where id = ${jobId}`,
		);
		expect(stored?.source).toBe("manual");
		expect(
			(await repo.listActiveCompanies("u1")).map((c) => c.name),
		).not.toContain("Hand Added Co");
	});
});

import type { NormalizedJob } from "@offerfinch/core/domain/types";
import {
	findApplicationStep,
	scoreStep,
} from "@offerfinch/core/pipeline/application-flow";
import type { PipelineDeps } from "@offerfinch/core/pipeline/ports";
import { jobFate } from "@offerfinch/core/pipeline/scan-report";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	DashboardRepository,
	type Database,
	DismissalStore,
	seedCompanies,
} from "../src/index";
import { execute, testDb } from "./setup";

let db: Database;
let repo: DashboardRepository;
let store: DismissalStore;
const companyIds: Record<string, string> = {};
let n = 0;

beforeAll(async () => {
	db = await testDb();
	repo = new DashboardRepository(db);
	store = new DismissalStore(db);
	await seedCompanies(db, "u1", [
		{
			name: "Lockheed Martin",
			source: "greenhouse",
			sourceKey: "lockheed",
			discoveredFrom: "t",
		},
		// The same employer through another source: hiding one hides both.
		{
			name: "Lockheed Martin Inc.",
			source: "lever",
			sourceKey: "lockheedmartin",
			discoveredFrom: "t",
		},
		{
			name: "Nimbus",
			source: "greenhouse",
			sourceKey: "nimbus",
			discoveredFrom: "t",
		},
		// The same Latin word after different names in another script: two companies.
		{
			name: "東京Tech",
			source: "greenhouse",
			sourceKey: "tokyotech",
			discoveredFrom: "t",
		},
		{
			name: "大阪Tech",
			source: "greenhouse",
			sourceKey: "osakalabs",
			discoveredFrom: "t",
		},
		{
			name: "Meta",
			source: "greenhouse",
			sourceKey: "meta",
			discoveredFrom: "t",
		},
		{
			name: "Metabase",
			source: "greenhouse",
			sourceKey: "metabase",
			discoveredFrom: "t",
		},
		{
			name: "Société Générale",
			source: "greenhouse",
			sourceKey: "socgen",
			discoveredFrom: "t",
		},
		{
			name: "Societe Generale SA",
			source: "lever",
			sourceKey: "societegenerale",
			discoveredFrom: "t",
		},
		// Names with no letters or digits at all normalize to an empty key.
		{ name: "—", source: "greenhouse", sourceKey: "dash", discoveredFrom: "t" },
		{ name: "…", source: "greenhouse", sourceKey: "dots", discoveredFrom: "t" },
		{
			name: "Lumen",
			source: "manual",
			sourceKey: "manual:lumen",
			discoveredFrom: "t",
		},
	]);
	for (const row of await execute<{ id: string; source_key: string }>(
		db,
		sql`select id, source_key from companies where user_id = 'u1'`,
	))
		companyIds[row.source_key] = row.id;
});
afterAll(() => db.$close());

const job = (source: NormalizedJob["source"] = "greenhouse"): NormalizedJob => {
	n += 1;
	return {
		source,
		externalId: `job-${n}`,
		url: `https://jobs.example/${n}`,
		title: `Engineer ${n}`,
		locations: ["Remote"],
		workplaceType: "remote",
		descriptionText: "React",
	};
};

async function add(
	companyKey: string,
	state: "found" | "scored" = "scored",
	source?: NormalizedJob["source"],
): Promise<string> {
	const { jobId } = await repo.upsertJob(
		"u1",
		companyIds[companyKey] ?? "",
		job(source),
	);
	const app = await repo.getApplicationByJob("u1", jobId);
	if (!app) throw new Error("no application");
	if (state === "scored" && app.state === "found")
		await repo.transition("u1", app.applicationId, {
			from: ["found"],
			to: "scored",
			reason: "Fit score 70",
			actor: "workflow",
		});
	return app.applicationId;
}

async function stateOf(id: string) {
	const [row] = await execute<{ state: string; ended_reason: string | null }>(
		db,
		sql`select state, ended_reason from applications where id = ${id}`,
	);
	return row;
}

const dismissalRows = (id: string) =>
	execute<{ reasons: string; note: string | null; company_id: string }>(
		db,
		sql`select reasons, note, company_id from dismissals where application_id = ${id}`,
	);

describe("Not interested", () => {
	it("dismisses a listed match with the user's reasons, and undo restores it and drops the reasons", async () => {
		const id = await add("nimbus");
		const result = await store.dismiss({
			userId: "u1",
			applicationIds: [id],
			reasons: ["location", "salary", "location"],
			note: "  Too far  ",
		});
		expect(result.dismissed).toEqual([id]);
		expect(result.skipped).toEqual([]);
		expect(result.events).toHaveLength(1);
		expect(await stateOf(id)).toEqual({
			state: "dismissed",
			ended_reason: "not_interested",
		});
		const [row] = await dismissalRows(id);
		expect(JSON.parse(row?.reasons ?? "")).toEqual(["location", "salary"]);
		expect(row?.note).toBe("Too far");
		expect(row?.company_id).toBe(companyIds.nimbus);

		const undone = await store.undo({ userId: "u1", applicationIds: [id] });
		expect(undone.restored).toEqual([id]);
		expect(undone.events).toHaveLength(1);
		expect(await stateOf(id)).toEqual({ state: "scored", ended_reason: null });
		expect(await dismissalRows(id)).toEqual([]);
		// A match is listed again, and can be prepared.
		await repo.requestPrepare({ userId: "u1", applicationId: id });
	});

	it("allows no reasons, and refuses anything that is not an open match", async () => {
		const plain = await add("nimbus");
		await store.dismiss({ userId: "u1", applicationIds: [plain], reasons: [] });
		const [row] = await dismissalRows(plain);
		expect(JSON.parse(row?.reasons ?? "")).toEqual([]);
		expect(row?.note).toBeNull();

		const found = await add("nimbus", "found");
		const prepared = await add("nimbus");
		await repo.requestPrepare({ userId: "u1", applicationId: prepared });
		const low = await add("nimbus", "found");
		await repo.transition("u1", low, {
			from: ["found"],
			to: "scored",
			reason: "low",
			actor: "workflow",
		});
		await execute(
			db,
			sql`update applications set ended_reason = 'Fit score 30 is below the minimum of 60.' where id = ${low}`,
		);
		for (const id of [found, prepared, low, "missing", plain])
			await expect(
				store.dismiss({ userId: "u1", applicationIds: [id], reasons: [] }),
			).rejects.toThrow(/only a listed match/);
		expect((await stateOf(low))?.ended_reason).toMatch(/below the minimum/);
		// Another user cannot dismiss it.
		const other = await add("nimbus");
		await expect(
			store.dismiss({ userId: "u2", applicationIds: [other], reasons: [] }),
		).rejects.toThrow(/only a listed match/);
		expect((await stateOf(other))?.state).toBe("scored");
	});

	it("dismisses several at once and skips the ones that moved on", async () => {
		const a = await add("nimbus");
		const b = await add("nimbus");
		const c = await add("nimbus");
		await repo.requestPrepare({ userId: "u1", applicationId: c });
		const result = await store.dismiss({
			userId: "u1",
			applicationIds: [a, b, c],
			reasons: ["stack"],
		});
		expect(result.dismissed.sort()).toEqual([a, b].sort());
		expect(result.skipped).toEqual([c]);
		const undone = await store.undo({ userId: "u1", applicationIds: [a, b] });
		expect(undone.restored.sort()).toEqual([a, b].sort());
	});
});

describe("hidden companies", () => {
	it("hides a company: its other open matches and checking jobs go, nothing past a match is touched, and undo brings all back", async () => {
		const picked = await add("lockheed");
		const sibling = await add("lockheed");
		const otherSource = await add("lockheedmartin");
		const checking = await add("lockheed", "found");
		const preparing = await add("lockheed");
		await repo.transition("u1", preparing, {
			from: ["scored"],
			to: "preparing",
			reason: "Prepare",
			actor: "workflow",
		});
		const requested = await add("lockheed");
		await repo.requestPrepare({ userId: "u1", applicationId: requested });
		const earlier = await add("lockheed");
		await store.dismiss({
			userId: "u1",
			applicationIds: [earlier],
			reasons: ["seniority"],
		});
		const unrelated = await add("nimbus");

		const result = await store.dismiss({
			userId: "u1",
			applicationIds: [picked],
			reasons: ["company"],
			hideCompanyId: companyIds.lockheed,
		});
		expect(result.dismissed).toEqual([picked]);
		expect(result.autoDismissed.sort()).toEqual(
			[sibling, otherSource, checking].sort(),
		);
		expect(result.hiddenCompanyId).toBe(companyIds.lockheed);
		expect(result.events).toHaveLength(4);
		for (const id of [sibling, otherSource, checking])
			expect(await stateOf(id)).toEqual({
				state: "dismissed",
				ended_reason: "company_hidden",
			});
		// No reasons recorded for the app's own dismissals: they are not the user's signal.
		expect(await dismissalRows(sibling)).toEqual([]);
		expect((await stateOf(preparing))?.state).toBe("preparing");
		expect((await stateOf(requested))?.state).toBe("scored");
		expect((await stateOf(unrelated))?.state).toBe("scored");
		expect(await store.listHidden("u1")).toEqual([
			expect.objectContaining({
				companyId: companyIds.lockheed,
				name: "Lockheed Martin",
				dismissed: 3,
			}),
		]);

		const undone = await store.undo({
			userId: "u1",
			applicationIds: [picked],
			unhideCompanyId: result.hiddenCompanyId,
		});
		expect(undone.restored.sort()).toEqual(
			[picked, sibling, otherSource, checking].sort(),
		);
		expect((await stateOf(picked))?.state).toBe("scored");
		expect((await stateOf(sibling))?.state).toBe("scored");
		// Back where it was: still being checked.
		expect(await stateOf(checking)).toEqual({
			state: "found",
			ended_reason: null,
		});
		// The match the user dismissed earlier, for its own reasons, stays dismissed.
		expect(await stateOf(earlier)).toEqual({
			state: "dismissed",
			ended_reason: "not_interested",
		});
		expect(await store.listHidden("u1")).toEqual([]);
	});

	it("dismisses a hidden company's new jobs as they are found, without a model, and Settings can show it again", async () => {
		const first = await add("lockheed");
		const hid = await store.dismiss({
			userId: "u1",
			applicationIds: [first],
			reasons: [],
			hideCompanyId: companyIds.lockheed,
		});

		// The next scan saves a new posting from it, through either source.
		const fresh = await add("lockheed", "found");
		const viaLever = await add("lockheedmartin", "found", "lever");
		for (const id of [fresh, viaLever])
			expect(await stateOf(id)).toEqual({
				state: "dismissed",
				ended_reason: "company_hidden",
			});
		// A job the user adds by link from that company is theirs to keep.
		const manual = await repo.upsertJob(
			"u1",
			companyIds["manual:lumen"] ?? "",
			job("manual"),
		);
		expect((await repo.getApplicationByJob("u1", manual.jobId))?.state).toBe(
			"found",
		);

		// Its run ends at the score step without reading the model.
		const [jobRow] = await execute<{ job_id: string }>(
			db,
			sql`select job_id from applications where id = ${fresh}`,
		);
		const jobId = jobRow?.job_id ?? "";
		const deps = {
			repo,
			llm: {
				complete: () => {
					throw new Error("the model must not be called");
				},
			},
		} as unknown as PipelineDeps;
		expect(await findApplicationStep(deps, "u1", jobId)).toEqual({
			applicationId: fresh,
		});
		expect(await scoreStep(deps, "u1", jobId)).toMatchObject({ ended: true });
		const usage = await execute<{ n: number }>(
			db,
			sql`select count(*) n from llm_usage where application_id = ${fresh}`,
		);
		expect(usage[0]?.n).toBe(0);
		// The scan history counts it as set aside for the hidden company.
		const [app] = await execute<{
			state: string;
			ended_reason: string | null;
		}>(
			db,
			sql`select state, ended_reason from applications where id = ${fresh}`,
		);
		expect(
			jobFate({
				state: app?.state ?? "",
				filterResult: null,
				endedReason: app?.ended_reason ?? null,
			}),
		).toEqual({ kind: "hidden_company" });

		// Show again from Settings: its jobs the app dismissed come back where they were.
		const shown = await store.unhideCompany({
			userId: "u1",
			companyId: companyIds.lockheedmartin ?? "",
		});
		expect(shown.restored.sort()).toEqual(
			[...hid.autoDismissed, fresh, viaLever].sort(),
		);
		expect((await stateOf(fresh))?.state).toBe("found");
		expect(await store.listHidden("u1")).toEqual([]);
		// The match the user dismissed stays dismissed.
		expect((await stateOf(first))?.state).toBe("dismissed");
		// A new job after that is kept.
		expect((await stateOf(await add("lockheed", "found")))?.state).toBe(
			"found",
		);
	});
});

describe("hidden companies named in other scripts", () => {
	it("hides 東京Tech, not 大阪Tech", async () => {
		const keys = await execute<{ name_key: string }>(
			db,
			sql`select name_key from companies where source_key in ('tokyotech', 'osakalabs') order by source_key`,
		);
		expect(keys.map((k) => k.name_key)).toEqual(["大阪tech", "東京tech"]);
		const tokyo = await add("tokyotech");
		const osaka = await add("osakalabs");
		const hid = await store.dismiss({
			userId: "u1",
			applicationIds: [tokyo],
			reasons: [],
			hideCompanyId: companyIds.tokyotech,
		});
		expect(hid.autoDismissed).toEqual([]);
		expect((await stateOf(osaka))?.state).toBe("scored");
		// A new job from the other company is kept; one from the hidden company is not.
		expect((await stateOf(await add("osakalabs", "found")))?.state).toBe(
			"found",
		);
		const fresh = await add("tokyotech", "found");
		expect((await stateOf(fresh))?.state).toBe("dismissed");
		expect(
			(await store.listHidden("u1")).find(
				(h) => h.companyId === companyIds.tokyotech,
			)?.dismissed,
		).toBe(1);
		const shown = await store.unhideCompany({
			userId: "u1",
			companyId: companyIds.tokyotech ?? "",
		});
		expect(shown.restored).toEqual([fresh]);
	});
});

describe("which companies a hide covers", () => {
	it("Meta is not Metabase; Société Générale is Societe Generale SA on another source", async () => {
		const meta = await add("meta");
		const metabase = await add("metabase");
		const hidMeta = await store.dismiss({
			userId: "u1",
			applicationIds: [meta],
			reasons: [],
			hideCompanyId: companyIds.meta,
		});
		expect(hidMeta.autoDismissed).toEqual([]);
		expect((await stateOf(metabase))?.state).toBe("scored");

		const accented = await add("socgen");
		const plain = await add("societegenerale");
		const hid = await store.dismiss({
			userId: "u1",
			applicationIds: [accented],
			reasons: [],
			hideCompanyId: companyIds.socgen,
		});
		expect(hid.autoDismissed).toEqual([plain]);
	});
});

describe("hidden companies whose names normalize to nothing", () => {
	it("hides only that company, not every other company with an empty key", async () => {
		const keys = await execute<{ name_key: string }>(
			db,
			sql`select name_key from companies where source_key in ('dash', 'dots')`,
		);
		expect(keys.map((k) => k.name_key)).toEqual(["", ""]);
		const dash = await add("dash");
		const dots = await add("dots");
		const hid = await store.dismiss({
			userId: "u1",
			applicationIds: [dash],
			reasons: [],
			hideCompanyId: companyIds.dash,
		});
		expect(hid.autoDismissed).toEqual([]);
		expect((await stateOf(dots))?.state).toBe("scored");
		expect((await stateOf(await add("dots", "found")))?.state).toBe("found");
		expect((await stateOf(await add("dash", "found")))?.state).toBe(
			"dismissed",
		);
	});
});

describe("Inbox views", () => {
	it("lists and counts each view with the same rule", async () => {
		const counts = await repo.inboxCounts("u1");
		for (const view of [
			"matches",
			"drafting",
			"review",
			"approved",
			"closed",
			"all",
		] as const) {
			const rows = await repo.listApplications("u1", { view, limit: 500 });
			expect(rows.length, view).toBe(counts[view]);
		}
		const matches = await repo.listApplications("u1", {
			view: "matches",
			limit: 500,
		});
		expect(
			matches.every(
				(r) =>
					r.state === "scored" &&
					r.endedReason === null &&
					r.prepareRequestedAt === null,
			),
		).toBe(true);
		const closed = await repo.listApplications("u1", {
			view: "closed",
			limit: 500,
		});
		// Turned down by the user (not interested, rejected): on the Rejected page, never in the Inbox.
		const all = await repo.listApplications("u1", { view: "all", limit: 500 });
		for (const rows of [closed, all])
			expect(
				rows.some((r) => r.state === "dismissed" || r.state === "rejected"),
			).toBe(false);
		const rejected = await repo.listRejected("u1");
		expect(rejected.some((r) => r.state === "dismissed")).toBe(true);
		// Scored below the minimum is closed, not a match.
		expect(
			closed.some((r) => r.state === "scored" && r.endedReason !== null),
		).toBe(true);
		const drafting = await repo.listApplications("u1", {
			view: "drafting",
			limit: 500,
		});
		expect(drafting.some((r) => r.prepareRequestedAt !== null)).toBe(true);
		// The normalized name groups an employer; an empty one (another script) falls back to the id.
		expect(matches.some((r) => r.companyKey === "lockheedmartin")).toBe(true);
	});
});

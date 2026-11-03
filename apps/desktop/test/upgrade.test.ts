/**
 * Upgrades of populated databases: for each schema point, a database as an earlier version left
 * it (support/upgrade-fixture.ts: every kind of row, every app setting set), then the worker's
 * real start (`WorkerApp.open` + `start`, as worker/index.ts runs it: migrations, sweeps, the
 * moves of earlier versions' settings, the queue's start-up steps, the runner's start with the
 * recovery of interrupted runs) with no network, twice; only a run's body is not run. Every row
 * is compared by its key: none may go or change but what start-up is documented to change.
 * Fresh test databases never take the paths old rows take (issue #60).
 *
 * When a migration lands, add the name of the one before it to POINTS (the schema the installed
 * app has now). If the new migration adds a table or columns, add rows or fields for them to
 * the fixture; the check that every table has rows says when one is missing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GHOST_AFTER_DAYS, localDay } from "@offerfinch/core/domain/tracking";
import { applicationInstanceId } from "@offerfinch/core/workflow/types";
import { listProviders, openSqlite } from "@offerfinch/db";
import { MIGRATIONS } from "@offerfinch/db/migrations/index";
import {
	afterAll,
	beforeAll,
	describe,
	type ExpectStatic,
	it,
	vi,
} from "vitest";

import type { WorkerInit } from "../src/shared/worker-protocol";
import { WorkerApp } from "../src/worker/app";
import { LOCAL_USER_ID, SettingsStore } from "../src/worker/settings";
import {
	addedRows,
	rowChanges,
	rowsAdded,
	type Snapshot,
	snapshot,
} from "./support/row-diff";
import {
	buildDatabaseAt,
	FIXTURE_TABLES,
	INTERRUPTED,
	LAPSED_WAIT,
	type SettingName,
	settingsFor,
} from "./support/upgrade-fixture";

const LATEST = MIGRATIONS.at(-1)?.name ?? "";
/** Schema points, oldest first: the migration each database stopped at. */
const POINTS = [
	"20261102025634_profile_records", // before Sources (source_providers) existed
	"20261102213756_match_rank", // before the shared search plan
	"20261103021635_search_plans", // before closed postings
	"20261103032954_closed_postings", // before stages and notes after Applied
	LATEST,
];

/** What the login shell's PATH reads as in these tests (no shell is started). */
const SHELL_PATH = "/opt/fixture/new/bin:/usr/bin:/bin";

vi.mock("../src/worker/subscriptions", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/worker/subscriptions")>();
	return {
		...actual,
		subscriptions: (input: Parameters<typeof actual.subscriptions>[0]) => {
			const real = actual.subscriptions(input);
			return {
				...real,
				refresh: async () => {
					real.usePath(SHELL_PATH);
					return SHELL_PATH;
				},
			};
		},
	};
});

/** A run as the runner claimed it (its row, as Drizzle reads it). */
interface ClaimedRun {
	id: string;
	status: string;
	leaseOwner: string | null;
	leaseUntil: Date | null;
	executions: number;
}

/** The runner's parts the test stops a run's body at (private in FlowRunner). */
interface RunnerInternals {
	execute(run: ClaimedRun): Promise<void>;
	unclaim(id: string): Promise<void>;
	ticking: Promise<void> | null;
}

/** Each start's re-read of stored postings (start() does not await it), by app. */
const cleaning = new Map<unknown, Promise<number>>();
vi.mock("../src/worker/add-job", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/worker/add-job")>();
	return {
		...actual,
		cleanStoredPostings: (
			app: Parameters<typeof actual.cleanStoredPostings>[0],
		) => {
			const done = actual.cleanStoredPostings(app);
			cleaning.set(app, done);
			return done;
		},
	};
});

/** Storage keys that differ from the setting's name. */
const STORED_AS: Partial<Record<SettingName, string>> = {
	paused: "scansPaused",
};

const fetchSpy = vi.fn(async () => {
	throw new Error("No network in upgrade tests");
});
// Once for the file: the points run concurrently, so a per-test unstub would put the real
// fetch back while other points still start.
beforeAll(() => {
	vi.stubGlobal("fetch", fetchSpy);
	// One clock for every run: start-up's follow-up sweep judges the fixture's fixed dates by
	// it (a8, sent 2026-10-26, is Ghosted 21 days on). It ticks, for leases and waits.
	vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true, now: NOW });
});
afterAll(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

interface Logged {
	level: string;
	message: string;
	data?: unknown;
}

/** The worker's start as worker/index.ts runs it, then its stop. Returns what it logged. */
async function startWorker(userData: string, dbFile: string) {
	const logs: Logged[] = [];
	const init: WorkerInit = {
		type: "init",
		userData,
		dbFile,
		version: "0.0.0-upgrade-test",
		claudeHost: path.join(userData, "no-claude-host.js"),
		secrets: {},
		test: { fakeModels: true, noSchedule: true },
	};
	const app = await WorkerApp.open(init, {
		exit: (code) => logs.push({ level: "error", message: `exit ${code}` }),
		status: () => {},
		notify: () => {},
		site: async () => {
			throw new Error("No site tabs in upgrade tests");
		},
		log: (level, message, data) => logs.push({ level, message, data }),
	});
	// The queue starts for real (recovery of interrupted runs, lapsed waits, the claim of the
	// first ready run); only the run's body does not: it hands the run back unstarted and the
	// runner takes no more (flows call the models and boards, and are tested elsewhere).
	const runner = app.runner as unknown as RunnerInternals;
	const executed: ClaimedRun[] = [];
	vi.spyOn(runner, "execute").mockImplementation(async (run) => {
		executed.push({ ...run });
		app.runner.stopTaking();
		await runner.unclaim(run.id);
	});
	await app.start();
	await app.pathRefresh;
	await app.background;
	// The runner's first pass, started by its start() and not awaited by it.
	await vi.waitFor(() => {
		if (runner.ticking !== null || app.runner.busy > 0)
			throw new Error("runner still busy");
	});
	// Not awaited by start() either.
	await cleaning.get(app);
	await app.stop();
	return { logs, executed, owner: app.runner.owner };
}

async function readSettings(dbFile: string) {
	const db = openSqlite(dbFile);
	const store = new SettingsStore(db);
	const names = Object.keys(settingsFor(true)) as SettingName[];
	const values: Record<string, unknown> = {};
	for (const name of names) values[name] = await store.get(name);
	const raw = db.$client
		.prepare("select key, value from app_settings")
		.all() as { key: string; value: string | null }[];
	const linkedin = (await listProviders(db, LOCAL_USER_ID)).find(
		(p) => p.provider === "linkedin",
	);
	const plan = db.$client
		.prepare("select user from search_plans where user_id = ?")
		.get(LOCAL_USER_ID) as { user: string } | undefined;
	const providers = db.$client
		.prepare("select provider, config, last_run from source_providers")
		.all() as { provider: string; config: string; last_run: string | null }[];
	const linkedinSettings = db.$client
		.prepare("select search_urls, daily_page_cap from linkedin_settings")
		.all();
	db.$close();
	return { values, raw, linkedin, plan, providers, linkedinSettings };
}

/**
 * The rows start-up adds, by what they say (their ids are generated): the added job back to
 * the Inbox (its transition, and the event that wakes its run, as a workflow event and the flow
 * event it is delivered as), the plan the moved searches go into when the schema had none, and
 * LinkedIn's Sources row for the old switch when the schema had no Sources.
 */
function expectedAdditions(before: Snapshot) {
	const added: Record<string, unknown>[] = [
		{
			table: "application_transitions",
			application_id: "a10",
			from_state: "rejected_by_filter",
			to_state: "found",
			reason: "Added by you",
			actor: "user",
		},
		{
			table: "flow_events",
			run_id: applicationInstanceId("j10"),
			type: "application_updated",
			delivered_to: null,
		},
		{
			table: "workflow_events",
			application_id: "a10",
			type: "application_updated",
			idempotency_key: "added-by-you-a10",
			payload: JSON.stringify({ action: "added_by_you" }),
			consumed_at: null,
		},
	];
	if (!before.search_plans)
		added.push({ table: "search_plans", user_id: LOCAL_USER_ID, ai: "[]" });
	if (!before.source_providers)
		added.push({
			table: "source_providers",
			user_id: LOCAL_USER_ID,
			provider: "linkedin",
			enabled: 1,
			config: "{}",
		});
	return added.sort((a, b) => String(a.table).localeCompare(String(b.table)));
}

/**
 * The stage entries start-up adds, in order (`core/domain/tracking.ts`): where the schema had no
 * stages, the sent application a8's Applied entry on the day it was sent (a board's
 * confirmation: the local day), and Ghosted on NOW's day, 22 days on with no news.
 * Where it had them, none: a8 is interviewing, a stage that never waits.
 */
/** The test's "now": 22 days after a8 was sent, at an hour that is no time zone's midnight. */
const NOW = Date.parse("2026-11-17T10:30:00Z");

function expectedStages(before: Snapshot): Record<string, unknown>[] {
	if (before.application_stages) return [];
	const sentAt = Number(before.applications?.get("id=a8")?.applied_at);
	const stages: Record<string, unknown>[] = [
		{
			application_id: "a8",
			seq: 1,
			stage: "applied",
			occurred_on: localDay(new Date(sentAt)),
			automatic: 0,
		},
	];
	// More than 21 days without news by NOW: Ghosted, on NOW's day.
	if (NOW - sentAt <= GHOST_AFTER_DAYS * 86_400_000)
		throw new Error("NOW must be over 21 days after a8 was sent");
	stages.push({
		application_id: "a8",
		seq: 2,
		stage: "ghosted",
		occurred_on: localDay(new Date(NOW)),
		automatic: 1,
	});
	return stages;
}

/**
 * The applications a re-filter looks at again (`refilterApplications`): only when the stored job
 * filter version is older, and only listed matches not set aside, prepared, ended, chosen anyway
 * or added by hand. Of the fixture: a1 (found), and a3 (scored) where the schema predates
 * `chosen_anyway_at`, so the user's "show anyway" on it cannot be stored. Every other
 * application must come through unchanged (a10 apart, see allowedChanges).
 */
function refilteredApps(before: Snapshot, latest: boolean): string[] {
	if (latest) return [];
	const chosenAnyway = before.applications?.get("id=a3")?.chosen_anyway_at;
	return chosenAnyway === undefined ? ["a1", "a3"] : ["a1"];
}

/** The values start-up is meant to change, as "table [key] column" patterns. */
function allowedChanges(refiltered: string[]): RegExp[] {
	const j10 = applicationInstanceId("j10");
	return [
		// Settings it moves or refreshes.
		/^app_settings \[key=(movedSearches|shellPath|jobSearchVersion)\] value$/,
		// The added job set aside by the filter: back to the Inbox, chosen anyway, run again.
		/^applications \[id=a10\] (state|state_changed_at|chosen_anyway_at)$/,
		new RegExp(
			`^flow_runs \\[id=${j10}\\] (status|executions|priority|result|run_after|ended_at)$`,
		),
		// Recovery: the interrupted run is queued again without its dead owner's lease.
		new RegExp(
			`^flow_runs \\[id=${applicationInstanceId(INTERRUPTED)}\\] (status|lease_owner|lease_until|run_after)$`,
		),
		// A wait whose time ran out while the app was closed: queued to time out.
		new RegExp(
			`^flow_runs \\[id=${applicationInstanceId(LAPSED_WAIT)}\\] (status|run_after)$`,
		),
		// The reply the last worker left unanswered says so.
		/^chat_messages \[id=m4\] (status|content)$/,
		// Per-source settings of earlier versions, retired into the shared plan.
		/^linkedin_settings \[user_id=local\] (search_urls|daily_page_cap|min_gap_seconds|max_gap_seconds)$/,
		/^source_providers \[user_id=local, provider=(job-board-search|web-search)\] config$/,
		/^source_providers \[user_id=local, provider=linkedin\] enabled$/,
		/^search_plans \[user_id=local\] user$/,
		// A newer job filter: these matches' filter result and flags are computed again.
		...refiltered.map(
			(id) => new RegExp(`^applications \\[id=${id}\\] (filter_result|flags)$`),
		),
	];
}

/** The run a start claimed: this runner's live lease then; queued and unleased after. */
function expectClaimed(
	expect: ExpectStatic,
	start: { executed: ClaimedRun[]; owner: string },
	after: Snapshot,
) {
	const [claimed] = start.executed;
	expect(claimed).toMatchObject({ status: "running", leaseOwner: start.owner });
	expect(claimed?.leaseUntil?.getTime()).toBeGreaterThan(Date.now());
	const stored = after.flow_runs?.get(`id=${claimed?.id}`);
	expect(stored).toMatchObject({
		status: "queued",
		lease_owner: null,
		lease_until: null,
		executions: (claimed?.executions ?? 0) - 1,
	});
}

/** What start-up logs when one of its steps failed (it goes on, so only the log says so). */
function failures(logs: Logged[]) {
	return logs.filter(
		(l) =>
			l.level === "error" ||
			(l.level === "warn" && !l.message.startsWith("login shell PATH")) ||
			l.message === "runner tick failed",
	);
}

// Concurrent: most of each start is the queue's 1.5 s delay, which the points can share.
describe.concurrent.each(POINTS)("upgrade from schema %s", (point) => {
	it("starts, keeps every row and setting, and starts again as a no-op", async ({
		expect,
	}) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-upgrade-"));
		const dbFile = path.join(dir, "offerfinch.sqlite");
		await buildDatabaseAt(dbFile, point);
		const before = snapshot(dbFile);
		const seeded = settingsFor(point === LATEST);

		const startedAt = Date.now();
		const first = await startWorker(dir, dbFile);
		expect(failures(first.logs)).toEqual([]);
		const after = snapshot(dbFile);

		// The fixture fills every table this schema has (a new table needs fixture rows).
		for (const [table, rows] of Object.entries(before))
			expect(rows.size, `fixture rows in ${table}`).toBeGreaterThan(0);
		if (point === LATEST)
			expect(Object.keys(before).sort()).toEqual([...FIXTURE_TABLES].sort());
		const changes = rowChanges(before, after);
		// No row lost but the two documented ones, and no value changed but what start-up is
		// meant to change (everything else: documents, profile, jobs, notes, states, ...).
		expect(changes.lost).toEqual([
			// The old LinkedIn switch, moved to Sources.
			"app_settings [key=linkedinEnabled]",
			// The steps of a run started again (`restartRun`): a job added by link that the filter
			// set aside goes back to the Inbox.
			`flow_steps [run_id=${applicationInstanceId("j10")}, key=score#1]`,
		]);
		const refiltered = refilteredApps(before, point === LATEST);
		const allowed = allowedChanges(refiltered);
		expect(
			changes.changed.filter((c) => !allowed.some((a) => a.test(c))),
		).toEqual([]);
		// Said once more for the applications: none changes but a10 and the re-filtered ones
		// (a9, needs_human and added by hand, keeps its flags, for one).
		const touched = new Set(["a10", ...refiltered]);
		expect(
			changes.changed.filter((c) => {
				const id = /^applications \[id=(\w+)\]/.exec(c)?.[1];
				return id !== undefined && !touched.has(id);
			}),
		).toEqual([]);
		// The re-filtered matches pass the current rules; their old "unclear" flag is gone.
		const verdicts: Record<string, string> = { a1: "remote_home", a3: "home" };
		for (const id of refiltered) {
			const app = after.applications?.get(`id=${id}`);
			expect(JSON.parse(String(app?.filter_result)), id).toMatchObject({
				decision: "keep",
				locationVerdict: verdicts[id],
			});
			expect(app?.flags, id).toBe("[]");
		}
		// Exactly the rows start-up is meant to add, and the flow event is the workflow event's.
		const all = addedRows(before, after);
		// Stage entries by their order of record (their ids are random).
		expect(
			all
				.filter((a) => a.table === "application_stages")
				.map((a) => a.row)
				.sort((x, y) => Number(x.seq) - Number(y.seq)),
		).toEqual(expectedStages(before).map((e) => expect.objectContaining(e)));
		const added = all.filter((a) => a.table !== "application_stages");
		expect(added.map((a) => ({ table: a.table, ...a.row }))).toEqual(
			expectedAdditions(before).map((e) => expect.objectContaining(e)),
		);
		const event = added.find((a) => a.table === "workflow_events")?.row;
		const delivered = added.find((a) => a.table === "flow_events")?.row;
		expect(JSON.parse(String(delivered?.payload))).toEqual({
			eventId: event?.id,
		});

		// The wait whose time ran out while the app was closed is queued to time out, due now,
		// with what it waits for kept (its replay reaches the wait and times it out).
		const lapsed = after.flow_runs?.get(
			`id=${applicationInstanceId(LAPSED_WAIT)}`,
		);
		const lapsedBefore = before.flow_runs?.get(
			`id=${applicationInstanceId(LAPSED_WAIT)}`,
		);
		expect(lapsed).toMatchObject({
			status: "queued",
			wait_step: lapsedBefore?.wait_step,
			wait_event_type: lapsedBefore?.wait_event_type,
			wait_until: lapsedBefore?.wait_until,
			lease_owner: null,
		});
		expect(Number(lapsed?.run_after)).toBeGreaterThanOrEqual(startedAt);
		expect(Number(lapsed?.run_after)).toBeLessThanOrEqual(Date.now());

		// The interrupted run was recovered (queued again, its dead owner's lease dropped) before
		// the runner took its first run.
		expect(first.logs).toContainEqual(
			expect.objectContaining({
				message: "run recovered",
				data: { runId: applicationInstanceId(INTERRUPTED) },
			}),
		);
		// The one run the runner took: claimed with this runner's lease, then handed back
		// unstarted (queued, no lease, its start not counted).
		expect(first.executed).toHaveLength(1);
		expectClaimed(expect, first, after);
		const interrupted = after.flow_runs?.get(
			`id=${applicationInstanceId(INTERRUPTED)}`,
		);
		expect(interrupted).toMatchObject({
			status: "queued",
			lease_owner: null,
			lease_until: null,
		});

		const s = await readSettings(dbFile);
		// Every stored setting is a value its schema reads (no NULL, no fallback).
		for (const row of s.raw) {
			expect(row.value, row.key).not.toBeNull();
			const name = (Object.keys(seeded) as SettingName[]).find(
				(n) => (STORED_AS[n] ?? n) === row.key,
			);
			expect(name, `known setting ${row.key}`).toBeDefined();
			if (name) expect(s.values[name]).toEqual(JSON.parse(row.value ?? ""));
		}
		expect(s.raw.map((r) => r.key)).not.toContain("linkedinEnabled");
		expect(s.values).toEqual({
			...seeded,
			// Moved to Sources' LinkedIn row, then cleared.
			linkedinEnabled: null,
			// The note of what moved, after the earlier one.
			movedSearches: expect.stringMatching(
				/^An earlier note the user has not dismissed\. \S/,
			),
			shellPath: SHELL_PATH,
			jobSearchVersion: 1,
		});
		// The old switch's choice (on) is LinkedIn's Sources row now.
		expect(s.linkedin?.enabled).toBe(true);
		// LinkedIn's searches and web search's own searches are the user's searches in the plan.
		const plan = JSON.parse(s.plan?.user ?? "[]") as { keywords: string }[];
		const moved = ["frontend engineer", "typescript"];
		// Web search's own searches are in its Sources row, which a point before Sources lacks.
		if ("source_providers" in before) moved.push("react developer Lisbon");
		expect(plan.map((p) => p.keywords)).toEqual(expect.arrayContaining(moved));
		for (const p of s.providers) {
			const config = JSON.parse(p.config) as Record<string, unknown>;
			expect(config, p.provider).not.toHaveProperty("backend");
			expect(config, p.provider).not.toHaveProperty("searxngUrl");
			expect(config, p.provider).not.toHaveProperty("queries");
		}
		expect(s.linkedinSettings).toEqual([
			{ search_urls: "[]", daily_page_cap: 15 },
		]);

		// A second start changes nothing: no row lost, changed or added.
		const second = await startWorker(dir, dbFile);
		expect(failures(second.logs)).toEqual([]);
		expect(second.executed).toHaveLength(1);
		const again = snapshot(dbFile);
		expectClaimed(expect, second, again);
		expect(rowChanges(after, again)).toEqual({ lost: [], changed: [] });
		expect(rowsAdded(after, again)).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
		// Nothing the starts left running logged a failure after they stopped.
		expect(failures([...first.logs, ...second.logs])).toEqual([]);

		const db = openSqlite(dbFile);
		expect(db.$client.pragma("integrity_check", { simple: true })).toBe("ok");
		expect(db.$client.pragma("foreign_key_check")).toEqual([]);
		db.$close();
	}, 30_000);
});

describe("the row comparison", () => {
	it("sees a row deleted while another is added, and a value overwritten", async ({
		expect,
	}) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-upgrade-"));
		const dbFile = path.join(dir, "offerfinch.sqlite");
		await buildDatabaseAt(dbFile, LATEST);
		const before = snapshot(dbFile);
		const db = openSqlite(dbFile);
		db.$client.exec(`
			delete from application_transitions where id = 'tr2';
			insert into application_transitions (id, user_id, application_id, to_state, reason, actor, created_at)
				values ('tr-new', 'local', 'a2', 'found', 'test', 'system', 0);
			update documents set content = 'overwritten' where id = 'a6-cv2';
		`);
		db.$close();
		const after = snapshot(dbFile);
		expect(rowChanges(before, after)).toEqual({
			lost: ["application_transitions [id=tr2]"],
			changed: ["documents [id=a6-cv2] content"],
		});
		expect(rowsAdded(before, after)).toEqual([
			"application_transitions [id=tr-new]",
		]);
	});
});

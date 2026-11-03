import type { LinkedInListing } from "@offerfinch/core/linkedin/parse";
import {
	LINKEDIN_PACE,
	type LinkedInBrowser,
	runLinkedIn,
} from "@offerfinch/core/linkedin/runner";

const CAP = LINKEDIN_PACE.dailyPageCap;

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	type Database,
	DrizzleLinkedInStore,
	DrizzlePipelineRepository,
	ensureUser,
	removeCompany,
	seedCompanies,
} from "../src/index";
import { execute, testDb } from "./setup";

let db: Database;
let store: DrizzleLinkedInStore;

const listing = (
	overrides: Partial<LinkedInListing> = {},
): LinkedInListing => ({
	jobId: "4100000001",
	title: "Senior Full-Stack Engineer",
	company: "Acme Robotics",
	locations: ["Remote"],
	workplaceType: "remote",
	descriptionText: "Build fleet software.",
	easyApply: false,
	externalApplyUrl: null,
	...overrides,
});
const view = (id: string) => `https://www.linkedin.com/jobs/view/${id}/`;

beforeAll(async () => {
	db = await testDb();
	store = new DrizzleLinkedInStore(db);
	await ensureUser(db, { id: "u2", name: "Other", email: "u2@example.test" });
});

afterAll(async () => {
	db.$close();
});

describe("LinkedIn store in Postgres", () => {
	it("dedupes against a Greenhouse posting by the employer's apply link", async () => {
		await seedCompanies(db, "u1", [
			{
				name: "Orbit Freight",
				source: "lever",
				sourceKey: "orbit",
				discoveredFrom: "t",
			},
		]);
		const [company] = await execute<{ id: string }>(
			db,
			sql`select id from companies where user_id = 'u1' and source_key = 'orbit'`,
		);
		await new DrizzlePipelineRepository(db).upsertJob("u1", company?.id ?? "", {
			source: "lever",
			externalId: "abc-123",
			url: "https://jobs.lever.co/orbit-freight/abc-123",
			title: "Backend Engineer (Routing)",
			locations: ["Remote"],
			workplaceType: "remote",
			descriptionText: "x",
		});
		expect(
			await store.saveListing(
				"u1",
				listing({
					jobId: "3",
					company: "Orbit Freight Ltd",
					title: "Senior Backend Engineer",
					externalApplyUrl: "https://jobs.lever.co/orbit-freight/abc-123",
				}),
				view("3"),
			),
		).toEqual({ outcome: "duplicate", jobId: null });
		// Read once: a later run does not open its page again.
		expect(await store.isKnown("u1", "3")).toBe(true);
	});

	it("saves a new listing as a linkedin job under its employer, with the apply link", async () => {
		const outcome = await store.saveListing(
			"u1",
			listing({ externalApplyUrl: "https://acme.example/careers/1" }),
			view("4100000001"),
		);
		expect(outcome.outcome).toBe("inserted");
		expect(outcome.jobId).toEqual(expect.any(String));
		const [row] = await execute<{
			source: string;
			apply_url: string;
			company_source: string;
		}>(
			db,
			sql`select j.source, j.apply_url, c.source as company_source from jobs j join companies c on c.id = j.company_id where j.user_id = 'u1' and j.external_id = '4100000001'`,
		);
		expect(row).toMatchObject({
			source: "linkedin",
			apply_url: "https://acme.example/careers/1",
			company_source: "linkedin",
		});
		expect(await store.isKnown("u1", "4100000001")).toBe(true);
		expect(await store.isKnown("u2", "4100000001")).toBe(false);
		// The same role under another LinkedIn id: same employer and title.
		expect(
			(await store.saveListing("u1", listing({ jobId: "99" }), view("99")))
				.outcome,
		).toBe("duplicate");
		// LinkedIn employers are never scanned as boards.
		const active = await new DrizzlePipelineRepository(db).listActiveCompanies(
			"u1",
		);
		expect(active.map((c) => c.source)).not.toContain("linkedin");
	});

	it("skips an employer the user removed from the watchlist", async () => {
		await removeCompany(db, "u1", "Nimbus Labs");
		await seedCompanies(db, "u1", [
			{
				name: "Nimbus Labs",
				source: "ashby",
				sourceKey: "nimbus",
				discoveredFrom: "t",
			},
		]);
		await removeCompany(db, "u1", "Nimbus Labs");
		expect(
			await store.saveListing(
				"u1",
				listing({
					jobId: "2",
					company: "Nimbus Labs",
					title: "Frontend Engineer",
				}),
				view("2"),
			),
		).toEqual({ outcome: "removed_company", jobId: null });
	});

	it("blocks until cleared and counts pages over a rolling 24 hours", async () => {
		const run = await store.startRun("u1", "test");
		for (let i = 0; i < 4; i++)
			expect(await store.reservePage("u1", run)).toEqual({ ok: true });
		expect(
			await store.pagesUsedSince("u1", new Date(Date.now() - 86_400_000)),
		).toBe(4);
		expect(
			await store.pagesUsedSince("u2", new Date(Date.now() - 86_400_000)),
		).toBe(0);
		await store.block("u1", { kind: "captcha", reason: "CAPTCHA on the page" });
		expect((await store.blocked("u1"))?.kind).toBe("captcha");
		expect(await store.reservePage("u1", run)).toMatchObject({
			ok: false,
			reason: "blocked",
		});
		expect(await store.blocked("u2")).toBe(null);
		expect(await store.clear("u2")).toBe(false);
		expect(await store.clear("u1")).toBe(true);
		expect(await store.blocked("u1")).toBe(null);
	});
});

/**
 * Codex review, finding 3: pages were counted by their run's start, and each run read its
 * allowance once. A run on Monday 10:00-10:30 fell out of Tuesday 10:01's window whole, and two
 * runners with separate Chrome profiles each spent the full cap. Each page is now reserved with
 * its own timestamp, in one locked transaction that re-reads the stop and the rolling cap.
 */
describe("LinkedIn page cap across runs", () => {
	const ORIGIN = "https://www.linkedin.com";
	const SEARCH = `${ORIGIN}/jobs/search/?keywords=cap`;
	const card = (id: string) =>
		`<li data-occludable-job-id="${id}"><a class="job-card-container__link" href="/jobs/view/${id}/">Role ${id}</a><div class="artdeco-entity-lockup__subtitle">Co ${id}</div><div class="artdeco-entity-lockup__caption">Remote</div></li>`;
	const results = (ids: string[]) =>
		`<html><body><div class="scaffold-layout__list"><ul>${ids.map(card).join("")}</ul></div></body></html>`;
	const jobView = (id: string) =>
		`<html><body><h1 class="job-details-jobs-unified-top-card__job-title">Role ${id}</h1><div class="job-details-jobs-unified-top-card__company-name">Co ${id}</div><div class="job-details-jobs-unified-top-card__tertiary-description-container">Ankara, Türkiye · 2 days ago</div><div class="job-details-fit-level-preferences">Hybrid Full-time</div><button class="jobs-apply-button"><span>Easy Apply</span></button><div id="job-details"><p>Build things.</p></div></body></html>`;
	/** LinkedIn job ids are numeric: `base` keeps each test's ids apart. */
	const ids = (base: number, n: number) =>
		Array.from({ length: n }, (_, i) => String(base + i + 1));
	const browser = (jobIds: string[], onOpen?: (n: number) => Promise<void>) => {
		const opened: string[] = [];
		const value: LinkedInBrowser = {
			async open(url) {
				opened.push(url);
				await onOpen?.(opened.length);
				if (url === SEARCH) return { url, status: 200, html: results(jobIds) };
				const id = /\/jobs\/view\/([^/]+)\//.exec(url)?.[1] ?? "";
				return { url, status: 200, html: jobView(id) };
			},
		};
		return { value, opened };
	};
	const run = (
		s: DrizzleLinkedInStore,
		userId: string,
		b: LinkedInBrowser,
		clock?: { now: Date },
		/** 0: the shortest gap (20 s), 1: the longest (60 s). */
		gap = 0,
	) =>
		runLinkedIn(
			{
				store: s,
				browser: b,
				alert: async () => {},
				sleep: async (ms) => {
					if (clock) clock.now = new Date(clock.now.getTime() + ms);
					await new Promise((r) => setImmediate(r));
				},
				// A fixed gap, so the clock below is exact.
				random: () => gap,
			},
			// The cap is under test here, not the per-list limit or a read's share.
			{
				userId,
				trigger: "test",
				lists: [{ kind: "search", label: "cap", url: SEARCH }],
				perList: 100,
				maxPages: 100,
			},
		);

	it("counts Monday's pages that are still within 24 hours on Tuesday", async () => {
		await ensureUser(db, { id: "mon", name: "Mon", email: "mon@example.test" });
		const clock = { now: new Date("2026-10-26T10:00:00Z") };
		const timed = new DrizzleLinkedInStore(db, () => clock.now);
		// Monday: the day's pages (the cap), 60 s apart from 10:00.
		const monday = browser(ids(5100, CAP - 1));
		expect(await run(timed, "mon", monday.value, clock, 1)).toMatchObject({
			outcome: "done",
			pagesUsed: CAP,
		});
		// Tuesday 10:01, 20 s apart: all but Monday's first page are inside the window, then one
		// fewer beside Tuesday's first, then that many beside Tuesday's two: the cap.
		clock.now = new Date("2026-10-27T10:01:00Z");
		const tuesday = browser(ids(5200, 10));
		expect(await run(timed, "mon", tuesday.value, clock)).toMatchObject({
			outcome: "page_cap",
			pagesUsed: 2,
		});
		expect(tuesday.opened).toHaveLength(2);
	});

	it("shares one allowance between runners started at the same time", async () => {
		await ensureUser(db, { id: "two", name: "Two", email: "two@example.test" });
		// Each could read most of the day's pages alone; together they hold to one cap.
		const a = browser(ids(5300, CAP - 2));
		const b = browser(ids(5400, CAP - 2));
		const results = await Promise.all([
			run(new DrizzleLinkedInStore(db), "two", a.value),
			run(new DrizzleLinkedInStore(db), "two", b.value),
		]);
		expect(a.opened.length + b.opened.length).toBe(CAP);
		expect(results.map((r) => r.pagesUsed).reduce((x, y) => x + y)).toBe(CAP);
		expect(
			await store.pagesUsedSince("two", new Date(Date.now() - 86_400_000)),
		).toBe(CAP);
	});

	it("opens no further page once another runner has stopped", async () => {
		await ensureUser(db, {
			id: "stop",
			name: "Stop",
			email: "stop@example.test",
		});
		const other = new DrizzleLinkedInStore(db);
		const b = browser(ids(5500, 3), async (n) => {
			if (n === 2)
				await other.block("stop", {
					kind: "captcha",
					reason: "CAPTCHA in the other profile",
				});
		});
		const result = await run(new DrizzleLinkedInStore(db), "stop", b.value);
		expect(b.opened).toHaveLength(2);
		expect(result.outcome).toBe("refused_blocked");
		expect((await store.blocked("stop"))?.kind).toBe("captcha");
	});
});

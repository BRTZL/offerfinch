import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateHardRequirements } from "@offerfinch/core/filter/rules";
import { parseFilterSettings } from "@offerfinch/core/filter/settings";
import type { PipelineDeps } from "@offerfinch/core/pipeline/ports";
import { FakeLlmProvider } from "@offerfinch/core/scoring/fake";
import { scoreFit } from "@offerfinch/core/scoring/fit";
import {
	DashboardRepository,
	type Database,
	DrizzlePipelineRepository,
	ensureUser,
	listRecords,
	openSqlite,
} from "@offerfinch/db";
import { migrate } from "@offerfinch/db/migrate";
import { appSettings } from "@offerfinch/db/schema/jobs";
import { jobs } from "@offerfinch/db/schema/pipeline";
import { describe, expect, it } from "vitest";
import { DB_FILE } from "../src/main/database-file";
import {
	DEMO_DIR,
	type DemoState,
	demoFolder,
	enterDemo,
	eraseDemo,
	leaveDemo,
} from "../src/main/demo";
import {
	demoSubscriptions,
	SAMPLE_PROVIDER_ID,
	SampleJobsProvider,
	seedDemo,
} from "../src/worker/demo";
import { SAMPLE_JOBS, SAMPLE_RULES } from "../src/worker/demo-data";
import { LOCAL_USER_ID, SettingsStore } from "../src/worker/settings";

const tempDir = (name: string) =>
	fs.mkdtempSync(path.join(os.tmpdir(), `offerfinch-demo-${name}-`));

async function demoDb(): Promise<Database> {
	const db = openSqlite(path.join(tempDir("db"), DB_FILE));
	await migrate(db);
	await ensureUser(db, {
		id: LOCAL_USER_ID,
		name: "You",
		email: "local@localhost.invalid",
	});
	return db;
}

/** A database file as bytes on disk: never opened, so reading it changes nothing. */
function fingerprint(file: string) {
	const side = (suffix: string) => {
		const f = `${file}${suffix}`;
		return fs.existsSync(f) ? fs.statSync(f).size : null;
	};
	return {
		sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
		mtimeMs: fs.statSync(file).mtimeMs,
		wal: side("-wal"),
		shm: side("-shm"),
	};
}

describe("try-it mode's sample data", () => {
	it("seeds the sample profile, rules, test models, notifications off and setup done, once", async () => {
		const db = await demoDb();
		await seedDemo(db, "9.9.9");
		const records = await listRecords(db, LOCAL_USER_ID);
		expect(records.find((r) => r.kind === "about")).toBeTruthy();
		expect(records.filter((r) => r.kind === "experience").length).toBe(4);
		expect(
			await new DashboardRepository(db).profileFiles(LOCAL_USER_ID),
		).toBeTruthy();
		const settings = new SettingsStore(db);
		const ai = await settings.get("ai");
		expect([ai.scoring.mode, ai.tailoring.mode, ai.claims.mode]).toEqual([
			"fake",
			"fake",
			"fake",
		]);
		expect(Object.values(await settings.get("notifications"))).toEqual([
			false,
			false,
			false,
			false,
			false,
		]);
		const onboarding = await settings.get("onboarding");
		expect(onboarding.completedAt).not.toBeNull();
		expect(await settings.get("whatsNewSeen")).toBe("9.9.9");
		const rules = await new DrizzlePipelineRepository(db).getFilterSettings(
			LOCAL_USER_ID,
		);
		expect(rules.livesIn).toBe("Netherlands");
		// A second start of the same demo database changes nothing.
		const before = await db.select().from(appSettings);
		await seedDemo(db, "9.9.10");
		expect(await db.select().from(appSettings)).toEqual(before);
	});

	it("has eight jobs: three set aside by a rule, the rest kept; one of those scores low", async () => {
		const db = await demoDb();
		await seedDemo(db, "1.0.0");
		const repo = new DrizzlePipelineRepository(db);
		const profile = await repo.getProfile(LOCAL_USER_ID);
		if (!profile) throw new Error("no sample profile");
		const rules = parseFilterSettings(SAMPLE_RULES);
		expect(SAMPLE_JOBS).toHaveLength(8);
		const llm = new FakeLlmProvider();
		const outcome: Record<string, string> = {};
		for (const job of SAMPLE_JOBS) {
			const filtered = evaluateHardRequirements(
				{
					title: job.title,
					locations: job.locations,
					workplaceType: job.workplaceType,
					descriptionText: job.description,
				},
				rules,
			);
			if (filtered.decision === "reject") {
				outcome[job.id] = "rule";
				continue;
			}
			const fit = await scoreFit(llm, {
				job: {
					title: job.title,
					companyName: job.company,
					locations: job.locations,
					workplaceType: job.workplaceType,
					descriptionText: job.description,
				} as never,
				profile,
			});
			outcome[job.id] = fit.score >= rules.minScore ? "match" : "low-score";
		}
		expect(outcome).toEqual(
			Object.fromEntries(SAMPLE_JOBS.map((j) => [j.id, j.shows])),
		);
	});

	it("the sample source inserts the eight jobs once, from no network", async () => {
		const db = await demoDb();
		const deps = {
			repo: new DrizzlePipelineRepository(db),
		} as unknown as PipelineDeps;
		const source = new SampleJobsProvider(db);
		const first = await source.run(deps, LOCAL_USER_ID);
		expect(first.provider).toBe(SAMPLE_PROVIDER_ID);
		expect(first.newJobIds).toHaveLength(8);
		const second = await source.run(deps, LOCAL_USER_ID);
		expect(second.newJobIds).toHaveLength(0);
		expect(second.duplicates).toBe(8);
		const rows = await db.select().from(jobs);
		expect(rows).toHaveLength(8);
		expect(new Set(rows.map((r) => r.source))).toEqual(new Set(["sample"]));
		expect(
			rows.every((r) => r.url.startsWith("https://jobs.sample.invalid/")),
		).toBe(true);
	});

	it("looks for no CLI and runs none", async () => {
		const subs = demoSubscriptions();
		expect(await subs.refresh()).toBe("");
		expect((await subs.claude()).path).toBeNull();
		expect((await subs.codex()).path).toBeNull();
		const provider = subs.factory({
			role: "scoring",
			provider: "claude-subscription",
			model: "",
			ownerUserId: LOCAL_USER_ID,
		});
		await expect(provider.generateObject({} as never)).rejects.toThrow(
			/not used with sample data/,
		);
	});
});

describe("entering and leaving try-it mode", () => {
	/** The real data folder of a used install: a database with a row in it, closed. */
	async function realInstall() {
		const userData = tempDir("userdata");
		const realDb = path.join(userData, DB_FILE);
		const db = openSqlite(realDb);
		await migrate(db);
		await new SettingsStore(db).set("whatsNewSeen", "real");
		db.$close();
		fs.mkdirSync(path.join(userData, "files"));
		fs.writeFileSync(path.join(userData, "files", "cv.pdf"), "real file");
		return { userData, realDb };
	}

	/** A worker stand-in: opens `state.databaseFile` as the worker does (migrate, seed in demo). */
	function workerOn(state: DemoState) {
		let open: Database | null = null;
		const opened: string[] = [];
		return {
			opened,
			current: () => open,
			stopWorker: async () => {
				open?.$close();
				open = null;
			},
			startWorker: async () => {
				const db = openSqlite(state.databaseFile);
				await migrate(db);
				if (state.demo) {
					await ensureUser(db, {
						id: LOCAL_USER_ID,
						name: "You",
						email: "local@localhost.invalid",
					});
					await seedDemo(db, "1.0.0");
				}
				opened.push(state.databaseFile);
				open = db;
			},
		};
	}

	it("runs on the demo folder only, deletes it on leaving, and never touches the real data", async () => {
		const { userData, realDb } = await realInstall();
		const realBefore = fingerprint(realDb);
		const fileBefore = fs.readFileSync(path.join(userData, "files", "cv.pdf"));
		const state: DemoState = {
			demo: false,
			databaseFile: realDb,
			realDatabaseFile: null,
		};
		const worker = workerOn(state);
		await enterDemo(state, { userData, ...worker });
		expect(state.demo).toBe(true);
		expect(state.databaseFile).toBe(path.join(userData, DEMO_DIR, DB_FILE));
		expect(state.realDatabaseFile).toBe(realDb);
		// Demo work: the sample jobs go into the demo database.
		const db = worker.current() as Database;
		await new SampleJobsProvider(db).run(
			{ repo: new DrizzlePipelineRepository(db) } as unknown as PipelineDeps,
			LOCAL_USER_ID,
		);
		expect(await db.select().from(jobs)).toHaveLength(8);
		expect(fingerprint(realDb)).toEqual(realBefore);

		await leaveDemo(state, { userData, ...worker });
		expect(state).toEqual({
			demo: false,
			databaseFile: realDb,
			realDatabaseFile: null,
		});
		expect(fs.existsSync(demoFolder(userData))).toBe(false);
		expect(worker.opened).toEqual([
			path.join(userData, DEMO_DIR, DB_FILE),
			realDb,
		]);
		await worker.stopWorker();
		// The real database and files: the same bytes, never written.
		expect(fingerprint(realDb)).toEqual(realBefore);
		expect(fs.readFileSync(path.join(userData, "files", "cv.pdf"))).toEqual(
			fileBefore,
		);
	});

	it("starts each demo fresh", async () => {
		const { userData, realDb } = await realInstall();
		const state: DemoState = {
			demo: false,
			databaseFile: realDb,
			realDatabaseFile: null,
		};
		const worker = workerOn(state);
		await enterDemo(state, { userData, ...worker });
		const db = worker.current() as Database;
		await new SampleJobsProvider(db).run(
			{ repo: new DrizzlePipelineRepository(db) } as unknown as PipelineDeps,
			LOCAL_USER_ID,
		);
		await leaveDemo(state, { userData, ...worker });
		await enterDemo(state, { userData, ...worker });
		expect(await (worker.current() as Database).select().from(jobs)).toEqual(
			[],
		);
		await leaveDemo(state, { userData, ...worker });
		await worker.stopWorker();
	});

	it("goes back to the real data when the demo worker does not start", async () => {
		const { userData, realDb } = await realInstall();
		const state: DemoState = {
			demo: false,
			databaseFile: realDb,
			realDatabaseFile: null,
		};
		const starts: boolean[] = [];
		await expect(
			enterDemo(state, {
				userData,
				stopWorker: async () => {},
				startWorker: async () => {
					starts.push(state.demo);
					if (state.demo) throw new Error("did not start");
				},
			}),
		).rejects.toThrow("did not start");
		expect(starts).toEqual([true, false]);
		expect(state).toEqual({
			demo: false,
			databaseFile: realDb,
			realDatabaseFile: null,
		});
		expect(fs.existsSync(demoFolder(userData))).toBe(false);
	});

	it("erases only the demo folder", async () => {
		const { userData, realDb } = await realInstall();
		fs.mkdirSync(path.join(userData, DEMO_DIR, "files"), { recursive: true });
		fs.writeFileSync(path.join(userData, DEMO_DIR, DB_FILE), "demo");
		expect(eraseDemo(userData)).toBe(true);
		expect(eraseDemo(userData)).toBe(false);
		expect(fs.existsSync(realDb)).toBe(true);
		expect(fs.existsSync(path.join(userData, "files", "cv.pdf"))).toBe(true);
	});
});

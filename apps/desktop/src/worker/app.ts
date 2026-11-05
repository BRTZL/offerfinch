import fs from "node:fs";
import path from "node:path";
import { FsBlobStore } from "@offerfinch/core/export/fs-blob";
import type { Notifier } from "@offerfinch/core/notify/ntfy";
import { runApplicationFlow } from "@offerfinch/core/pipeline/application-flow";
import type { PipelineDeps } from "@offerfinch/core/pipeline/ports";
import { runScanFlow } from "@offerfinch/core/pipeline/scan-flow";
import { PlanUsageTracker } from "@offerfinch/core/scoring/plan-usage";
import type {
	ApplicationWorkflowParams,
	ScanWorkflowParams,
} from "@offerfinch/core/workflow/types";
import {
	beginScanRun,
	DashboardRepository,
	type Database,
	DrizzleClosedPostingStore,
	DrizzlePlanUsageStore,
	ensureLocationDefaults,
	ensureUser,
	listProviders,
	openSqlite,
	type PendingEvent,
	retirePerSourceSettings,
	retireSearchBackends,
	sweepWorkingMessages,
	updateProvider,
} from "@offerfinch/db";
import { migrate } from "@offerfinch/db/migrate";
import { user } from "@offerfinch/db/schema/auth";
import { flowRuns } from "@offerfinch/db/schema/jobs";
import {
	applications,
	applicationTransitions,
	companies,
	jobs,
} from "@offerfinch/db/schema/pipeline";
import {
	APPLICATION_KIND,
	DurableWorkflowStarter,
	ensureHourlyScan,
	FlowRunner,
	recentScans,
	SCAN_KIND,
	type StalledAttempt,
	startManualScan,
} from "@offerfinch/runner";
import { and, desc, eq, gt, inArray, isNotNull } from "drizzle-orm";
import type { SecretName, SiteTabId } from "../shared/bridge";
import {
	type NativeNotice,
	type NoticeOutcome,
	type TrayStatus,
	WORKER_STALL_EXIT,
	type WorkerInit,
} from "../shared/worker-protocol";
import { cleanStoredPostings, readPostingForJob } from "./add-job";
import { localChromeProvider } from "./browser";
import type { CheckStop, SiteTabHost } from "./checks";
import { demoSubscriptions, seedDemo } from "./demo";
import { fakeSubscriptions } from "./fake-clis";
import { FakeCodexSubscription } from "./fake-codex";
import {
	FOLLOW_UP_EVERY_MS,
	FollowUpDelivery,
	runFollowUps,
} from "./follow-ups";
import { movedSearchesNote, upgradeJobSearch } from "./job-search";
import { linkedinScanDeps } from "./linkedin";
import { NoticeBatcher } from "./notices";
import { buildPipeline, type RoleState } from "./pipeline";
import { scanLogFor } from "./scan-history";
import {
	LOCAL_USER_EMAIL,
	LOCAL_USER_ID,
	type NotificationSettings,
	SettingsStore,
} from "./settings";
import type { SiteCaller } from "./site-tab";
import {
	queueTestStall,
	recordStall,
	STALL_LIMIT,
	TEST_STALL_KIND,
	testStallHandler,
} from "./stalls";
import { type Subscriptions, subscriptions } from "./subscriptions";

export interface WorkerHooks {
	/** Ends the worker process with this code, after its last messages went out. */
	exit: (code: number) => void;
	status: (status: TrayStatus) => void;
	notify: (notice: NativeNotice) => void;
	/** One operation on a site's hidden tab, answered by main. */
	site: SiteCaller;
	log: (
		level: "info" | "warn" | "error",
		message: string,
		data?: unknown,
	) => void;
}

const SCHEDULE_EVERY_MS = 5 * 60_000;
const QUEUE_START_DELAY_MS = 1_500;

const SITE_LABEL: Record<SiteTabId, string> = {
	linkedin: "LinkedIn",
	indeed: "Indeed",
	glassdoor: "Glassdoor",
	duckduckgo: "DuckDuckGo",
	web: "Web",
};

/** No-op: strong matches are announced from the database (they need the application id). */
const quietNotifier: Notifier = { notifyStrongMatch: async () => {} };

/**
 * Everything the worker process runs: the database (with a backup before each migration), the
 * durable runner with the scan and application flows, the hourly scheduler, notifications and
 * the state the tray shows. The oRPC API reads `deps` and `db` from here.
 */
export class WorkerApp {
	readonly db: Database;
	readonly settings: SettingsStore;
	readonly blobs: FsBlobStore;
	readonly starter: DurableWorkflowStarter;
	readonly runner: FlowRunner;
	deps!: PipelineDeps;
	roles: RoleState[] = [];
	private secrets: Partial<Record<SecretName, string>>;
	/** Whether a key is stored (never the key itself). */
	hasSecret(name: SecretName): boolean {
		return Boolean(this.secrets[name]);
	}
	/** The stored keys, for building a provider in this process. */
	secretValues(): Partial<Record<SecretName, string>> {
		return this.secrets;
	}
	private notifications!: NotificationSettings;
	private readonly batcher: NoticeBatcher;
	private readonly followUpDelivery: FollowUpDelivery;
	private scheduleTimer: NodeJS.Timeout | null = null;
	private statusTimer: NodeJS.Timeout | null = null;
	private followUpTimer: NodeJS.Timeout | null = null;
	private browsersOpen = 0;
	private lastStatusJson = "";
	readonly subscriptions: Subscriptions;
	/** What each plan has used of its windows, and OfferFinch's share (Settings › Models). */
	readonly planUsage: PlanUsageTracker;

	private constructor(
		readonly init: WorkerInit,
		private readonly hooks: WorkerHooks,
		db: Database,
	) {
		this.db = db;
		// Try-it mode never holds a key, whatever main sends (setSecrets refuses them too).
		this.secrets = init.demo ? {} : init.secrets;
		this.settings = new SettingsStore(db);
		this.planUsage = new PlanUsageTracker({
			userId: LOCAL_USER_ID,
			store: new DrizzlePlanUsageStore(db),
			// Claude reports one window as it answers; the full report needs a probe once the
			// batch is over, so its weekly share is OfferFinch's too. Codex reads after each call.
			onIdle: (vendor) => {
				if (vendor !== "anthropic") return;
				void this.subscriptions
					.claude({ fresh: true })
					.catch((error) =>
						hooks.log("warn", "plan usage not read after calls", String(error)),
					);
			},
			log: (message, data) => hooks.log("warn", message, data),
		});
		const planUsage = (vendor: "anthropic" | "openai") =>
			this.planUsage.sink(vendor);
		// Try-it mode looks for no CLI at all, whatever the test flags say: the real subscriptions
		// are never built (building them searches this Mac's PATH for `claude` and `codex`).
		// Test runs never reach the CLIs on this Mac: their state is the test's (fake-clis.ts).
		// Main sets `fakeClis` only for an unpackaged build, so a shipped app never reads it.
		if (init.demo) this.subscriptions = demoSubscriptions();
		else {
			const local = subscriptions({
				hostScript: init.claudeHost,
				log: (message, data) => hooks.log("info", message, data),
				planUsage,
			});
			this.subscriptions = init.test?.fakeClis
				? fakeSubscriptions(init.userData, local, planUsage)
				: local;
		}
		this.blobs = new FsBlobStore(path.join(init.userData, "files"));
		this.followUpDelivery = new FollowUpDelivery({
			db,
			userId: LOCAL_USER_ID,
			send: (notice) => hooks.notify(notice),
			log: (message, data) => hooks.log("warn", message, data),
		});
		this.batcher = new NoticeBatcher({
			// A follow-up waits for main's answer before it counts as shown.
			emit: (notice, items) =>
				notice.kind === "followup"
					? void this.followUpDelivery.emit(notice, items)
					: hooks.notify(notice),
			settings: () => this.notifications,
		});
		this.runner = new FlowRunner({
			db,
			// A running scan holds one slot; the others score its jobs as they come in.
			concurrency: 3,
			onStalled: (stall) => void this.onStalled(stall),
			stopGraceMs: init.test?.stallProbe ? 300 : undefined,
			handlers: {
				...(init.test?.stallProbe
					? { [TEST_STALL_KIND]: testStallHandler(init.userData) }
					: {}),
				// Each scan gets its own history hooks, bound to its run.
				[SCAN_KIND]: (step, params, run) =>
					runScanFlow(
						step,
						{ ...this.deps, ...scanLogFor(this, run, params) },
						params as unknown as ScanWorkflowParams,
					),
				[APPLICATION_KIND]: (step, params) =>
					runApplicationFlow(
						step,
						this.deps,
						params as unknown as ApplicationWorkflowParams,
					),
			},
			log: (message, data) => hooks.log("info", message, data),
			onRunEnd: (run) => {
				// A scan's matches are scored in the application runs it starts: they are held
				// until the queue has nothing queued or running, then go out as one notification.
				void this.endScanningWhenIdle();
				if (run.kind === SCAN_KIND) {
					if (run.status === "errored")
						this.batcher.add({
							kind: "stopped",
							title: "The scan stopped",
							detail:
								"The last scan stopped with an error. Open the app for details.",
						});
				}
				void this.collectNotices();
				void this.pushStatus();
			},
		});
		this.starter = new DurableWorkflowStarter(db, this.runner);
	}

	static async open(init: WorkerInit, hooks: WorkerHooks): Promise<WorkerApp> {
		fs.mkdirSync(path.dirname(init.dbFile), { recursive: true });
		const db = openSqlite(init.dbFile);
		const migrated = await migrate(db, {
			backupDir: path.join(init.userData, "backups"),
		});
		if (migrated.applied.length > 0)
			hooks.log("info", "migrations applied", migrated);
		// Try-it mode: a new demo database gets the sample profile, rules and test models.
		if (init.demo) {
			await ensureUser(db, {
				id: LOCAL_USER_ID,
				name: "You",
				email: LOCAL_USER_EMAIL,
			});
			await seedDemo(db, init.version);
		}
		// A chat reply the last worker left unanswered says so instead of waiting forever.
		await sweepWorkingMessages(db);
		// Brave Search or SearXNG settings of earlier versions: job-board search uses DuckDuckGo now.
		const retired = await retireSearchBackends(db);
		if (retired > 0)
			hooks.log("info", "job-board search settings moved to DuckDuckGo", {
				rows: retired,
			});
		const app = new WorkerApp(init, hooks, db);
		await app.ensureLocalUser();
		await app.planUsage.load();
		await app.retirePerSourceSettings();
		app.notifications = await app.settings.get("notifications");
		// Last start's login-shell PATH, so `claude` and `codex` are found without waiting for
		// the shell (seconds); start() reads it again in the background.
		const cachedPath = init.demo ? "" : await app.settings.get("shellPath");
		if (cachedPath) app.subscriptions.usePath(cachedPath);
		if ((await app.settings.get("noticeWatermark")) === 0)
			await app.settings.set("noticeWatermark", Date.now());
		await app.rebuild();
		return app;
	}

	/**
	 * Sources have no settings of their own (2026-11-03): LinkedIn's custom searches and web
	 * search's own searches move into the shared plan; what can't move, and what is dropped, is
	 * said once in Settings › Job search. The old LinkedIn switch becomes its Sources row.
	 */
	private async retirePerSourceSettings() {
		const enabled = await this.settings.get("linkedinEnabled");
		if (enabled !== null) {
			const row = (await listProviders(this.db, LOCAL_USER_ID)).find(
				(p) => p.provider === "linkedin",
			);
			if (row && enabled !== row.enabled)
				await updateProvider(this.db, LOCAL_USER_ID, "linkedin", { enabled });
			await this.settings.set("linkedinEnabled", null);
		}
		const moved = await retirePerSourceSettings(this.db);
		const said = movedSearchesNote(moved);
		if (!said) return;
		this.hooks.log("info", "per-source settings moved", moved);
		const earlier = await this.settings.get("movedSearches");
		await this.settings.set(
			"movedSearches",
			earlier ? `${earlier} ${said}` : said,
		);
	}

	private async ensureLocalUser() {
		await ensureUser(this.db, {
			id: LOCAL_USER_ID,
			name: "You",
			email: LOCAL_USER_EMAIL,
		});
		// One local user: verified, so the scan treats it as active once it has a profile.
		await this.db
			.update(user)
			.set({ emailVerified: true })
			.where(eq(user.id, LOCAL_USER_ID));
	}

	/** After an erase: the local user again, default settings, a fresh pipeline. */
	async reopen(): Promise<void> {
		await this.ensureLocalUser();
		this.notifications = await this.settings.get("notifications");
		await this.settings.set("noticeWatermark", Date.now());
		await this.rebuild();
	}

	/** (Re)builds the pipeline after a settings or key change. Running steps keep their deps. */
	async rebuild(): Promise<void> {
		const built = buildPipeline({
			local: this.init.test?.fakeCodex
				? (input) =>
						input.provider === "codex-subscription"
							? new FakeCodexSubscription(input.ownerUserId, this.init.userData)
							: this.subscriptions.factory(input)
				: this.subscriptions.factory,
			ownerUserId: LOCAL_USER_ID,
			userData: this.init.userData,
			siteHost: this.siteHost(),
			test: Boolean(this.init.test),
			db: this.db,
			ai: await this.settings.get("ai"),
			secrets: this.secrets,
			workflows: this.starter,
			browser: localChromeProvider((open) => {
				this.browsersOpen = open;
				void this.pushStatus();
			}),
			blobs: this.blobs,
			notifier: quietNotifier,
			fakeModels: Boolean(this.init.demo || this.init.test?.fakeModels),
			demo: Boolean(this.init.demo),
			fakeDelayMs: this.init.test?.fakeDelayMs,
			boardBases: this.init.test?.boardBases,
			standInHosts: Object.keys(this.init.test?.fetchRewrite ?? {}),
			linkedin: linkedinScanDeps(this),
			log: (message, data) => this.hooks.log("info", message, data),
		});
		this.deps = {
			...built.deps,
			// Jobs added by link: read as the first step of their run (see add-job.ts).
			postingReader: (userId, jobId) => readPostingForJob(this, userId, jobId),
			// The scan's re-check of listed board matches for closed postings (it reads the
			// boards: never with sample data).
			...(this.init.demo
				? {}
				: { closedPostings: new DrizzleClosedPostingStore(this.db) }),
		};
		this.roles = built.roles;
	}

	async setSecrets(secrets: Partial<Record<SecretName, string>>) {
		// Try-it mode's worker takes no key: main sends none, and one that arrives is dropped.
		if (this.init.demo) {
			this.hooks.log("warn", "keys refused: sample data", {
				names: Object.keys(secrets),
			});
			return;
		}
		this.secrets = secrets;
		await this.rebuild();
		// Work paused for want of a model can go on now.
		this.runner.poke();
	}

	async setNotifications(value: NotificationSettings) {
		await this.settings.set("notifications", value);
		this.notifications = value;
	}

	log(level: "info" | "warn" | "error", message: string, data?: unknown) {
		this.hooks.log(level, message, data);
	}

	private async endScanningWhenIdle(): Promise<void> {
		// Waiting runs (questions, review) are idle; only queued and running ones count.
		if ((await this.runner.pendingCount()) > 0) return;
		await this.collectNotices();
		this.batcher.setScanning(false);
	}

	/**
	 * The site tabs for the readers: main's tabs, and what a check does here. A check notifies at
	 * once (not batched: the run is waiting) unless stop notifications are off, and a sign-in wall
	 * marks the site "Sign in needed" until a run gets past it.
	 */
	siteHost(): SiteTabHost {
		return {
			site: this.hooks.site,
			checkTimeoutMs: this.init.test?.checkTimeoutMs,
			checkPollMs: this.init.test ? 250 : undefined,
			onCheck: async (site, stop) => {
				if (stop.kind === "login_wall")
					await this.markSession(site, { needsSignIn: true });
				if (!this.notifications.stopped) return;
				const label = SITE_LABEL[site];
				this.hooks.notify({
					kind: "check",
					title: `${label} needs you`,
					body:
						stop.kind === "login_wall"
							? `Sign in to ${label} in OfferFinch. The run waits for you.`
							: "Solve the check in OfferFinch. The run waits for you.",
					path: `/settings/sources?live=${site}`,
				});
			},
			onCheckDone: async (site, stop: CheckStop, outcome) => {
				if (stop.kind === "login_wall" && outcome === "cleared")
					await this.markSession(site, {
						needsSignIn: false,
						signedInAt: new Date().toISOString(),
					});
				this.hooks.log("info", "site check ended", {
					site,
					kind: stop.kind,
					outcome,
				});
			},
		};
	}

	/** Records a site's sign-in state (see the `siteSessions` setting). */
	async markSession(
		site: SiteTabId,
		value: Partial<{ signedInAt: string | null; needsSignIn: boolean }>,
	) {
		const all = await this.settings.get("siteSessions");
		const current = all[site] ?? { signedInAt: null, needsSignIn: false };
		await this.settings.set("siteSessions", {
			...all,
			[site]: { ...current, ...value },
		});
	}

	private stalling = false;
	/**
	 * A step attempt ran past its timeout and did not stop: this process can't free its slot, so
	 * it ends itself (see stalls.ts). It takes no more work, counts the stall (failing the step
	 * at the limit), then exits with WORKER_STALL_EXIT; main starts a new worker. If the count
	 * can't be written within 5 s (the database is held), it exits as a crash instead, which
	 * main's crash limit bounds.
	 */
	private async onStalled(stall: StalledAttempt) {
		this.hooks.log(
			"error",
			"step stalled: still running past its time limit and ignoring its stop; the worker ends so crash recovery runs it again",
			stall,
		);
		if (this.stalling) return;
		this.stalling = true;
		this.runner.stopTaking();
		const recorded = await Promise.race([
			recordStall(this.db, this.settings, stall).catch((error) => {
				this.hooks.log("error", "stall not recorded", String(error));
				return null;
			}),
			new Promise<null>((r) => setTimeout(() => r(null), 5_000)),
		]);
		if (recorded)
			this.hooks.log(
				"error",
				recorded.failed
					? `step marked failed after ${recorded.stalls} stalls`
					: `stall ${recorded.stalls} of ${STALL_LIMIT}`,
				stall,
			);
		this.hooks.exit(recorded ? WORKER_STALL_EXIT : 1);
	}

	/** Main's answer about a notice the worker asked after: what macOS did with a follow-up. */
	noticeResult(id: string, outcome: NoticeOutcome): Promise<void> {
		return this.followUpDelivery.result(id, outcome);
	}

	/** After Applied: Ghosted and follow-up reminders (`follow-ups.ts`); a failure is only logged. */
	async followUps(): Promise<void> {
		try {
			await runFollowUps({
				db: this.db,
				userId: LOCAL_USER_ID,
				add: (item) => this.batcher.add(item),
				inFlight: (stageId) => this.followUpDelivery.inFlight(stageId),
				log: (message, data) => this.hooks.log("info", message, data),
			});
		} catch (error) {
			this.hooks.log("warn", "follow-ups not checked", String(error));
		}
	}

	/** A stop the user must look at (a board, the LinkedIn runner), as a notification. */
	notifyStop(title: string, detail: string) {
		this.batcher.add({ kind: "stopped", title, detail });
	}

	/** Reads PATH from the login shell again; rebuilds the pipeline when it changed. */
	async refreshClis(options: { always?: boolean } = {}): Promise<void> {
		const before = await this.settings.get("shellPath");
		const pathEnv = await this.subscriptions.refresh();
		// Same PATH: a CLI installed since is found again only by a rebuild (`always`).
		if (pathEnv === before && !options.always) return;
		await this.settings.set("shellPath", pathEnv);
		await this.rebuild();
		this.runner.poke();
	}

	/** The queue's delayed start (see start()). */
	background: Promise<void> = Promise.resolve();

	/** The background PATH refresh started by start(). */
	pathRefresh: Promise<void> = Promise.resolve();

	async start(): Promise<void> {
		// Try-it mode starts no login shell: no CLI is looked for.
		if (!this.init.demo)
			this.pathRefresh = this.refreshClis().catch((error) =>
				this.hooks.log("warn", "login shell PATH not read", String(error)),
			);
		// The window's first queries go first: the queue (recovery, replays, the hourly scan)
		// starts a moment later, so a busy queue does not hold the first screen back.
		this.background = new Promise<void>((resolve) => {
			const timer = setTimeout(async () => {
				try {
					// Jobs added by link that an earlier version set aside: back to the Inbox.
					for (const event of await new DashboardRepository(
						this.db,
					).migrateAddedJobs(LOCAL_USER_ID))
						await this.starter.sendEvent(event);
					// Flags an older claims check raised that the current one clears on the
					// stored claims: no model call. The last one cleared resumes the export.
					// A failure here never holds the queue back.
					try {
						const stale = await new DashboardRepository(
							this.db,
						).clearStaleFlags(LOCAL_USER_ID);
						if (stale.cleared > 0)
							this.hooks.log("info", "stale flags cleared", {
								n: stale.cleared,
							});
						for (const event of stale.events)
							await this.starter.sendEvent(event);
					} catch (error) {
						this.hooks.log("warn", "stale flags not cleared", String(error));
					}
					// A new job filter: location settings from the profile, then the stored
					// matches filtered once more (no model call). Never holds the queue back.
					try {
						await upgradeJobSearch(this, LOCAL_USER_ID, {
							get: () => this.settings.get("jobSearchVersion"),
							set: (value) => this.settings.set("jobSearchVersion", value),
						});
					} catch (error) {
						this.hooks.log("warn", "job search not upgraded", String(error));
					}
					await this.starter.adoptOrphans(LOCAL_USER_ID);
					// Whole-page descriptions an earlier version stored: read once more, cleaned.
					void cleanStoredPostings(this)
						.then((n) => n && this.hooks.log("info", "postings re-read", { n }))
						.catch((error) =>
							this.hooks.log("warn", "postings not re-read", String(error)),
						);
					if (this.init.test?.stallProbe)
						await queueTestStall(this.db, LOCAL_USER_ID);
					await this.runner.start();
					await this.startScans();
				} catch (error) {
					this.hooks.log("error", "queue start failed", String(error));
				}
				resolve();
			}, QUEUE_START_DELAY_MS);
			timer.unref?.();
		});
		this.statusTimer = setInterval(() => {
			void this.collectNotices();
			void this.pushStatus();
		}, 10_000);
		void this.followUps();
		this.followUpTimer = setInterval(
			() => void this.followUps(),
			FOLLOW_UP_EVERY_MS,
		);
		await this.pushStatus();
	}

	/**
	 * The hourly scans, after the queue started. Try-it mode instead searches the sample jobs
	 * once, at once (a new demo), and never on a timer.
	 */
	private async startScans(): Promise<void> {
		if (this.init.demo) {
			if ((await recentScans(this.db, LOCAL_USER_ID, 1)).length === 0)
				await this.scanNow();
			return;
		}
		if (this.init.test?.noSchedule) return;
		await this.scheduleTick("start");
		this.scheduleTimer = setInterval(
			() => void this.scheduleTick("timer"),
			SCHEDULE_EVERY_MS,
		);
	}

	async stop(): Promise<void> {
		await this.background;
		if (this.scheduleTimer) clearInterval(this.scheduleTimer);
		if (this.statusTimer) clearInterval(this.statusTimer);
		if (this.followUpTimer) clearInterval(this.followUpTimer);
		await this.runner.stop(3_000);
		this.db.$close();
	}

	/** Hourly scan: this hour's scan unless paused, not onboarded, or already run. */
	async scheduleTick(reason: string): Promise<void> {
		if (await this.settings.get("paused")) return;
		const repo = new DashboardRepository(this.db);
		if (!(await repo.profileFiles(LOCAL_USER_ID))) return;
		// A profile imported since the last start: where the user lives, before the scan filters.
		await ensureLocationDefaults(this.db, LOCAL_USER_ID);
		// The history row first (with how it started), then the runner takes the run.
		const id = await ensureHourlyScan(this.db, null, LOCAL_USER_ID);
		if (id) {
			await beginScanRun(this.db, {
				userId: LOCAL_USER_ID,
				flowRunId: id,
				trigger: reason === "start" ? "start" : "timer",
			}).catch(() => {});
			this.runner.poke();
			this.batcher.setScanning(true);
			this.hooks.log("info", "scheduled scan", { id, reason });
		}
	}

	async scanNow(companyIds?: string[]) {
		await ensureLocationDefaults(this.db, LOCAL_USER_ID);
		const result = await startManualScan(
			this.db,
			null,
			LOCAL_USER_ID,
			new Date(),
			companyIds,
		);
		if (result.started) {
			await beginScanRun(this.db, {
				userId: LOCAL_USER_ID,
				flowRunId: result.id,
				trigger: "manual",
			}).catch(() => {});
			this.runner.poke();
			this.batcher.setScanning(true);
		}
		await this.pushStatus();
		return result;
	}

	async setPaused(paused: boolean) {
		await this.settings.set("paused", paused);
		await this.pushStatus();
		return paused;
	}

	sendEvent = async (event: PendingEvent) => {
		await this.starter.sendEvent(event);
	};

	/** New strong matches, questions, reviews and stopped boards since the last look. */
	async collectNotices(): Promise<void> {
		const since = new Date(await this.settings.get("noticeWatermark"));
		const now = new Date();
		const matches = await this.db
			.select({
				id: applications.id,
				score: applications.score,
				alertedAt: applications.alertedAt,
				title: jobs.title,
				company: companies.name,
			})
			.from(applications)
			.innerJoin(jobs, eq(jobs.id, applications.jobId))
			.innerJoin(companies, eq(companies.id, jobs.companyId))
			.where(
				and(
					eq(applications.userId, LOCAL_USER_ID),
					isNotNull(applications.alertedAt),
					gt(applications.alertedAt, since),
				),
			);
		for (const m of matches)
			this.batcher.add({
				kind: "match",
				applicationId: m.id,
				title: m.title,
				company: m.company,
				score: m.score ?? undefined,
			});
		const moved = await this.db
			.select({
				id: applications.id,
				to: applicationTransitions.toState,
				title: jobs.title,
				company: companies.name,
			})
			.from(applicationTransitions)
			.innerJoin(
				applications,
				eq(applications.id, applicationTransitions.applicationId),
			)
			.innerJoin(jobs, eq(jobs.id, applications.jobId))
			.innerJoin(companies, eq(companies.id, jobs.companyId))
			.where(
				and(
					eq(applicationTransitions.userId, LOCAL_USER_ID),
					gt(applicationTransitions.createdAt, since),
					inArray(applicationTransitions.toState, [
						"needs_answers",
						"ready_for_review",
					]),
				),
			);
		for (const m of moved)
			this.batcher.add({
				kind: m.to === "needs_answers" ? "question" : "review",
				applicationId: m.id,
				title: m.title,
				company: m.company,
			});
		const blocked = await this.db
			.select({ name: companies.name, reason: companies.healthReason })
			.from(companies)
			.where(
				and(
					eq(companies.userId, LOCAL_USER_ID),
					inArray(companies.health, ["needs_human", "robots_disallowed"]),
					gt(companies.updatedAt, since),
				),
			);
		for (const b of blocked)
			this.batcher.add({
				kind: "stopped",
				title: `${b.name}: stopped`,
				detail: `${b.name}'s board asked for a person (or robots.txt refused). Nothing was bypassed; the scan history says more.`,
			});
		await this.announceAdded();
		await this.settings.set("noticeWatermark", now.getTime());
	}

	/**
	 * Jobs added by link, once each, when their posting has been read and scored (or could not
	 * be read). Main shows it only when the window is not in front. Kept in the database, so a
	 * restart neither loses nor repeats it.
	 */
	private async announceAdded(): Promise<void> {
		const ready = await this.db
			.select({
				id: applications.id,
				state: applications.state,
				score: applications.score,
				filter: applications.filterDecision,
				title: jobs.title,
				company: companies.name,
				readStatus: jobs.readStatus,
				readError: jobs.readError,
			})
			.from(applications)
			.innerJoin(jobs, eq(jobs.id, applications.jobId))
			.innerJoin(companies, eq(companies.id, jobs.companyId))
			.where(
				and(
					eq(applications.userId, LOCAL_USER_ID),
					eq(applications.announceReady, true),
				),
			);
		for (const r of ready) {
			const failed = r.readStatus === "failed";
			if (!failed && (r.readStatus !== null || r.state === "found")) continue;
			await this.db
				.update(applications)
				.set({ announceReady: false })
				.where(eq(applications.id, r.id));
			if (!this.notifications.match) continue;
			this.hooks.notify({
				kind: "added",
				onlyIfUnfocused: true,
				path: `/applications/${r.id}?view=all`,
				title: failed
					? "Couldn't read a job you added"
					: `${r.title} at ${r.company}`,
				body: failed
					? `${r.readError ?? "The page could not be read"}. Open it to retry or paste the posting.`
					: `Added by you. Fit ${r.score ?? "?"}${r.filter === "reject" ? ", outside your job search" : ""}.`,
			});
		}
	}

	async status(): Promise<TrayStatus> {
		const repo = new DashboardRepository(this.db);
		const counts = await repo.countsByState(LOCAL_USER_ID);
		const questions = await repo.listQuestions(LOCAL_USER_ID, "open");
		const [last] = await recentScans(this.db, LOCAL_USER_ID, 1);
		const [running] = await this.db
			.select({ id: flowRuns.id })
			.from(flowRuns)
			.where(
				and(
					eq(flowRuns.kind, SCAN_KIND),
					inArray(flowRuns.status, ["queued", "running"]),
				),
			)
			.orderBy(desc(flowRuns.createdAt))
			.limit(1);
		const paused = await this.settings.get("paused");
		const summary = last?.result
			? (() => {
					try {
						const r = JSON.parse(last.result) as {
							jobsFetched?: number;
							jobsInserted?: number;
						};
						return r.jobsFetched === undefined
							? null
							: `${r.jobsInserted ?? 0} new of ${r.jobsFetched} jobs`;
					} catch {
						return null;
					}
				})()
			: null;
		return {
			state: running ? "scanning" : paused ? "paused" : "idle",
			paused,
			scanId: running?.id ?? null,
			lastScanAt: (last?.endedAt ?? last?.createdAt)?.toISOString() ?? null,
			lastScanSummary:
				last?.status === "errored" ? "Last scan stopped" : summary,
			counts: {
				review: (counts.ready_for_review ?? 0) + (counts.needs_human ?? 0),
				questions: questions.length,
				applied: counts.applied ?? 0,
				new: counts.scored ?? 0,
			},
		};
	}

	async pushStatus(): Promise<void> {
		try {
			const status = await this.status();
			const json = JSON.stringify({ ...status, browsers: this.browsersOpen });
			if (json === this.lastStatusJson) return;
			this.lastStatusJson = json;
			this.hooks.status(status);
		} catch (error) {
			this.hooks.log("warn", "status failed", String(error));
		}
	}
}

import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { NormalizedJob } from "../src/domain/types";
import { NoopNotifier } from "../src/notify/ntfy";
import { runApplicationFlow } from "../src/pipeline/application-flow";
import { LocalStep, LocalWorkflowStarter } from "../src/pipeline/local";
import type { PipelineDeps } from "../src/pipeline/ports";
import { runScanFlow } from "../src/pipeline/scan-flow";
import { sweepStuckApplications } from "../src/pipeline/sweep";
import { loadProfileFromDir } from "../src/profile/load-node";
import { FakeLlmProvider, FakeSubscriptionProvider } from "../src/scoring/fake";
import {
	type GenerateObjectRequest,
	type LlmProvider,
	SUBSCRIPTION_PAUSE_PREFIX,
	SubscriptionUnavailableError,
} from "../src/scoring/llm";
import {
	DEFAULT_SUBSCRIPTION_DAILY_CALLS,
	MeteredLlm,
	paidBasis,
	type SpendStore,
	SUBSCRIPTION_BASIS,
} from "../src/scoring/metered";
import { FIXTURES, fakeExporter } from "./helpers";
import { MemoryRepo } from "./memory-repo";

/**
 * Subscription providers: every call is a $0 row marked `subscription` with the tokens the CLI
 * reported, however it ended, the cap neither refuses nor counts them, and a usage limit or a
 * logout pauses the application (no step retries, never `failed`) until the sweep wakes it. Only
 * a call the vendor said was paid is priced (`api`), and it stops that vendor until resumed.
 */

const PROFILE = await loadProfileFromDir(join(FIXTURES, "tailor-profile"));
const POSTING: NormalizedJob = {
	source: "greenhouse",
	externalId: "42",
	url: "https://boards.greenhouse.io/acme/jobs/42",
	title: "Senior Full-Stack Engineer",
	locations: ["Ankara, Turkey"],
	workplaceType: "hybrid",
	descriptionText:
		"Requirements\n- TypeScript and React with Next.js\n- Node.js and PostgreSQL",
};

interface Row {
	id: string;
	task: string;
	billing: string;
	status: "reserved" | "settled";
	estimate: number;
	cost: number;
	basis?: string;
	tokens?: number;
	error?: string | null;
	modelCalls?: number;
}

/**
 * Mirrors DrizzleSpendStore: open API reservations count at their worst case until settled;
 * settled spend counts only `api` rows; subscription calls never count against the cap, and a
 * vendor stopped after a paid call takes no new call until resumed.
 */
class MemorySpend implements SpendStore {
	rows: Row[] = [];
	pausedJobIds: string[] = [];
	extraUsageOff = true;
	stopped = new Set<string>();
	budget = 40;
	constructor(public capMicros: number) {}
	async subscriptionBudget() {
		return {
			budget: this.budget,
			used: this.rows.reduce((n, r) => n + (r.modelCalls ?? 0), 0),
			resetsAt: null,
		};
	}
	private used() {
		return this.rows.reduce(
			(n, r) =>
				n +
				(r.billing !== "api"
					? 0
					: r.status === "reserved"
						? r.estimate
						: r.cost),
			0,
		);
	}
	async reserveSpend(input: Parameters<SpendStore["reserveSpend"]>[0]) {
		const billing = input.billing ?? "api";
		const vendor = input.provider.startsWith("codex-subscription:")
			? "openai"
			: "anthropic";
		if (billing === "subscription" && this.stopped.has(vendor))
			return {
				ok: false as const,
				reason: "vendor_stopped" as const,
				detail: `${vendor} is stopped after a paid call; resume it in Settings > Models.`,
			};
		const budget = await this.subscriptionBudget();
		if (
			billing === "subscription" &&
			budget.used + (input.modelCalls ?? 0) > budget.budget
		)
			return { ok: false as const, reason: "call_budget" as const, ...budget };
		if (
			billing === "api" &&
			this.used() + input.estimateMicros > this.capMicros
		)
			return {
				ok: false as const,
				reason: "cap" as const,
				spentMicros: this.used(),
				capMicros: this.capMicros,
			};
		const id = String(this.rows.length + 1);
		this.rows.push({
			id,
			task: input.task,
			billing,
			status: "reserved",
			estimate: input.estimateMicros,
			cost: 0,
			modelCalls: input.modelCalls ?? 0,
		});
		return { ok: true as const, id };
	}
	async recordRefusal(input: Parameters<SpendStore["recordRefusal"]>[0]) {
		this.rows.push({
			id: String(this.rows.length + 1),
			task: input.task,
			billing: "subscription",
			status: "settled",
			estimate: 0,
			cost: 0,
			error: input.error,
		});
	}
	async recordPaidStop(_userId: string, vendor: string) {
		this.stopped.add(vendor);
		if (vendor === "anthropic") this.extraUsageOff = false;
	}
	async listCapPausedJobIds() {
		return this.pausedJobIds;
	}
	async spendingStatus() {
		return {
			enabled: true,
			capMicros: this.capMicros,
			spentMicros: this.used(),
			reservedMicros: 0,
		};
	}
	async holdSpend(id: string, input: Parameters<SpendStore["holdSpend"]>[1]) {
		const row = this.rows.find((r) => r.id === id);
		if (!row) return;
		row.error = input.error;
		row.basis = input.basis;
	}
	async settleSpend(
		id: string,
		input: Parameters<SpendStore["settleSpend"]>[1],
	) {
		const row = this.rows.find((r) => r.id === id);
		if (!row) throw new Error("no reservation");
		Object.assign(row, {
			status: "settled",
			cost: input.costMicros,
			basis: input.basis,
			tokens: input.usage
				? input.usage.inputTokens + input.usage.outputTokens
				: undefined,
			error: input.error,
			...(input.billing ? { billing: input.billing } : {}),
			...(input.modelCalls !== undefined
				? { modelCalls: input.modelCalls }
				: {}),
		});
	}
}

/** A subscription provider named after a priced model, so its worst case is not $0. */
function priced(failure: () => string = () => "") {
	const inner: LlmProvider = {
		name: "inner",
		async generateObject<T>(request: GenerateObjectRequest<T>) {
			request.onUsage?.({
				model: "claude-sonnet-5-5",
				inputTokens: 10_000,
				outputTokens: 2_000,
				cachedInputTokens: 0,
				cacheWriteTokens: 0,
			});
			return { ok: true } as T;
		},
	};
	const fake = new FakeSubscriptionProvider("u1", inner, failure);
	return Object.assign(fake, {
		name: "claude-subscription:claude-sonnet-5-5",
		vendor: "anthropic",
	}) as FakeSubscriptionProvider;
}

async function setup(
	spend: MemorySpend,
	providers: { llm: LlmProvider; claimsLlm: LlmProvider },
) {
	const repo = new MemoryRepo(structuredClone(PROFILE));
	repo.addCompany({ name: "Acme", source: "greenhouse", sourceKey: "acme" });
	const workflows = new LocalWorkflowStarter();
	const deps: PipelineDeps = {
		repo,
		sources: {
			greenhouse: { kind: "greenhouse", listJobs: async () => [POSTING] },
		},
		...providers,
		exporter: fakeExporter(),
		now: () => new Date("2026-10-30T12:00:00Z"),
		notifier: new NoopNotifier(),
		workflows,
		spend,
	};
	workflows.bind(deps);
	await runScanFlow(new LocalStep(), deps, { userId: "u1", trigger: "cli" });
	const app = repo.apps[0];
	if (!app) throw new Error("no application");
	return { repo, app, deps, workflows };
}

describe("subscription billing", () => {
	it("records $0 rows marked subscription with real tokens", async () => {
		const spend = new MemorySpend(100_000_000);
		const { repo } = await setup(spend, {
			llm: new FakeSubscriptionProvider("u1", new FakeLlmProvider(), () => ""),
			claimsLlm: new FakeSubscriptionProvider(
				"u1",
				new FakeLlmProvider(),
				() => "",
			),
		});
		expect(["ready_for_review", "needs_answers"]).toContain(
			repo.apps[0]?.state,
		);
		expect(spend.rows.map((r) => r.task)).toEqual(
			expect.arrayContaining(["fit-score", "tailor", "claims-check"]),
		);
		for (const row of spend.rows) {
			expect(row).toMatchObject({
				billing: "subscription",
				status: "settled",
				cost: 0,
				basis: SUBSCRIPTION_BASIS,
				error: null,
			});
			expect(row.tokens).toBeGreaterThan(0);
		}
	});

	it("prepares on plans even when the cap is used up: the cap stops API-key work only", async () => {
		const spend = new MemorySpend(0);
		const { repo } = await setup(spend, {
			llm: new FakeSubscriptionProvider("u1", new FakeLlmProvider(), () => ""),
			claimsLlm: new FakeSubscriptionProvider(
				"u1",
				new FakeLlmProvider(),
				() => "",
			),
		});
		expect(["ready_for_review", "needs_answers"]).toContain(
			repo.apps[0]?.state,
		);
	});

	it("never refuses or counts a subscription call against the cap", async () => {
		const spend = new MemorySpend(0);
		const provider = priced();
		const metered = new MeteredLlm(provider, spend, {
			userId: "u1",
			applicationId: null,
		});
		await expect(
			metered.generateObject({
				task: "x",
				system: "",
				prompt: "x",
				schema: {} as never,
			}),
		).resolves.toEqual({ ok: true });
		expect(provider.calls).toEqual(["x"]);
		expect(spend.rows[0]).toMatchObject({
			billing: "subscription",
			status: "settled",
			cost: 0,
		});
	});

	it("refuses a subscription call for any account but its owner, before the CLI runs", async () => {
		const spend = new MemorySpend(0);
		const provider = new FakeSubscriptionProvider("owner");
		const metered = new MeteredLlm(provider, spend, {
			userId: "someone-else",
			applicationId: null,
		});
		const error = await metered
			.generateObject({
				task: "fit-score",
				system: "",
				prompt: "x",
				schema: {} as never,
			})
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SubscriptionUnavailableError);
		expect((error as SubscriptionUnavailableError).kind).toBe("not_owner");
		expect(provider.calls).toEqual([]);
		expect(spend.rows[0]).toMatchObject({ billing: "subscription", cost: 0 });
	});
});

describe("a subscription pause", () => {
	it("leaves the job found when scoring meets the usage limit, without retrying the step", async () => {
		const spend = new MemorySpend(100_000_000);
		const failing = new FakeSubscriptionProvider(
			"u1",
			new FakeLlmProvider(),
			() => "usage_limit",
		);
		const { repo } = await setup(spend, {
			llm: failing,
			claimsLlm: new FakeLlmProvider(),
		});
		expect(repo.apps[0]?.state).toBe("found");
		// One attempt: the step returned a pause instead of throwing into its 3 retries.
		expect(failing.calls).toEqual(["fit-score"]);
		expect(spend.rows[0]?.error).toMatch(
			new RegExp(`^${SUBSCRIPTION_PAUSE_PREFIX} \\(usage_limit`),
		);
	});

	it("keeps preparation waiting on a logout (never failed), and the sweep resumes it once logged in", async () => {
		const spend = new MemorySpend(100_000_000);
		let failure = "";
		const scoring = new FakeSubscriptionProvider("u1");
		const tailoring = new FakeSubscriptionProvider(
			"u1",
			new FakeLlmProvider(),
			() => failure,
		);
		const repo = new MemoryRepo(structuredClone(PROFILE));
		repo.addCompany({ name: "Acme", source: "greenhouse", sourceKey: "acme" });
		const workflows = new LocalWorkflowStarter();
		const deps: PipelineDeps = {
			repo,
			sources: {
				greenhouse: { kind: "greenhouse", listJobs: async () => [POSTING] },
			},
			llm: scoring,
			tailorLlm: tailoring,
			claimsLlm: new FakeLlmProvider(),
			exporter: fakeExporter(),
			now: () => new Date("2026-10-30T12:00:00Z"),
			notifier: new NoopNotifier(),
			workflows,
			spend,
		};
		workflows.bind(deps);
		failure = "logged_out";
		await runScanFlow(new LocalStep(), deps, { userId: "u1", trigger: "cli" });
		const app = repo.apps[0];
		expect(app?.state).toBe("preparing");
		expect(tailoring.calls).toEqual(["tailor"]);
		const paused = spend.rows.find((r) => r.task === "tailor");
		expect(paused?.error).toMatch(/logged_out/);
		expect(paused?.error).toMatch(/Settings › Models/);

		failure = "";
		spend.pausedJobIds = [app?.jobId ?? ""];
		const swept = await sweepStuckApplications(deps, "u1", {
			now: new Date("2026-10-30T15:00:00Z"),
		});
		expect(swept.resumed).toEqual([app?.jobId]);
		expect(["ready_for_review", "needs_answers"]).toContain(
			repo.apps[0]?.state,
		);
	});

	it("still runs the application flow to the end after a pause (no wake-up is lost)", async () => {
		const spend = new MemorySpend(100_000_000);
		let failure = "usage_limit";
		const provider = new FakeSubscriptionProvider(
			"u1",
			new FakeLlmProvider(),
			() => failure,
		);
		const { repo, app, deps } = await setup(spend, {
			llm: provider,
			claimsLlm: new FakeLlmProvider(),
		});
		expect(repo.apps[0]?.state).toBe("found");
		failure = "";
		await runApplicationFlow(new LocalStep(), deps, {
			userId: "u1",
			jobId: app.jobId,
		});
		expect(["ready_for_review", "needs_answers"]).toContain(
			repo.apps[0]?.state,
		);
	});
});

describe("resuming a scoring pause in a later local process", () => {
	it("the sweep of a fresh process restarts a job an earlier process left paused in found", async () => {
		const spend = new MemorySpend(100_000_000);
		let failure = "usage_limit";
		const provider = new FakeSubscriptionProvider(
			"u1",
			new FakeLlmProvider(),
			() => failure,
		);
		const { repo, app, deps, workflows } = await setup(spend, {
			llm: provider,
			claimsLlm: new FakeLlmProvider(),
		});
		expect(repo.apps[0]?.state).toBe("found");
		// The same process: its run returned a pause, so it has ended.
		expect(await workflows.status(app.jobId)).toBe("complete");
		// A later `pnpm cli scan` is a new process with its own starter.
		failure = "";
		const later = new LocalWorkflowStarter();
		const next = { ...deps, workflows: later };
		later.bind(next);
		const swept = await sweepStuckApplications(next, "u1", {
			now: new Date(Date.now() + 3 * 60 * 60_000),
		});
		expect(swept.restarted).toEqual([app.jobId]);
		expect(repo.apps[0]?.state).not.toBe("found");
	});
});

describe("paid extra usage", () => {
	const call = (metered: MeteredLlm) =>
		metered
			.generateObject({
				task: "x",
				system: "",
				prompt: "x",
				schema: {} as never,
			})
			.catch((e: unknown) => e);

	it("records a call that drew on extra usage at its API price, counted by the cap, and stops Claude until resumed", async () => {
		const spend = new MemorySpend(100_000_000);
		let failure = "extra_usage";
		const provider = priced(() => failure);
		const metered = new MeteredLlm(provider, spend, {
			userId: "u1",
			applicationId: null,
		});
		const error = await call(metered);
		expect((error as SubscriptionUnavailableError).paid).toBe(true);
		const row = spend.rows[0];
		expect(row).toMatchObject({ billing: "api", status: "settled" });
		expect(row?.cost).toBeGreaterThan(0);
		expect(row?.basis).toMatch(new RegExp(`^${paidBasis("anthropic")}`));
		expect(row?.basis).toMatch(/Claude plan/);
		expect((await spend.spendingStatus()).spentMicros).toBe(row?.cost);
		expect(spend.extraUsageOff).toBe(false);
		// The next call is refused before the CLI starts, until the user resumes Claude.
		failure = "";
		const next = await call(metered);
		expect((next as SubscriptionUnavailableError).kind).toBe("extra_usage");
		expect((next as Error).message).toMatch(
			new RegExp(`^${SUBSCRIPTION_PAUSE_PREFIX} \\(extra_usage`),
		);
		expect(provider.calls).toEqual(["x"]);
		spend.stopped.clear();
		await expect(call(metered)).resolves.toEqual({ ok: true });
	});

	it("records a paid call that reported no usage at its worst case, as api, never held", async () => {
		const spend = new MemorySpend(100_000_000);
		const provider = priced(() => "extra_usage_no_usage");
		const metered = new MeteredLlm(provider, spend, {
			userId: "u1",
			applicationId: null,
		});
		await call(metered);
		const row = spend.rows[0];
		expect(row).toMatchObject({ billing: "api", status: "settled" });
		expect(row?.estimate).toBeGreaterThan(0);
		expect(row?.cost).toBe(row?.estimate);
		expect((await spend.spendingStatus()).spentMicros).toBe(row?.estimate);
	});
});

describe("a subscription call that fails", () => {
	const usage = {
		model: "claude-sonnet-5-5",
		inputTokens: 10_000,
		outputTokens: 2_000,
		cachedInputTokens: 0,
		cacheWriteTokens: 0,
	};
	/** A subscription provider that sends (or not), reports usage (or not), then throws. */
	function failing(opts: {
		sent: boolean;
		usage?: boolean;
		error: Error;
		codex?: boolean;
	}) {
		const provider: LlmProvider = {
			name: opts.codex
				? "codex-subscription:gpt-6.1-sol"
				: "claude-subscription:claude-sonnet-5-5",
			vendor: opts.codex ? "openai" : "anthropic",
			billing: "subscription",
			ownerUserId: "u1",
			async generateObject<T>(request: GenerateObjectRequest<T>): Promise<T> {
				if (opts.sent) request.onModelCall?.();
				if (opts.usage) request.onUsage?.(usage);
				throw opts.error;
			},
		};
		return provider;
	}
	async function run(
		provider: LlmProvider,
		spend = new MemorySpend(100_000_000),
	) {
		const metered = new MeteredLlm(provider, spend, {
			userId: "u1",
			applicationId: null,
		});
		await metered
			.generateObject({
				task: "x",
				system: "",
				prompt: "x",
				schema: {} as never,
			})
			.catch(() => {});
		const row = spend.rows.at(-1);
		if (!row) throw new Error("no row");
		return { row, spent: (await spend.spendingStatus()).spentMicros };
	}

	it("settles every unpaid ending at $0 on the plan, with its tokens, and stops nothing", async () => {
		const endings: Record<string, Error> = {
			"no answer": new Error("the CLI ended without an answer"),
			"lost stream": new Error("lost response"),
			"failed the schema": new Error(
				"claude-subscription:claude-opus-5-5: no valid structured output for fit-score",
			),
			"a 429": new SubscriptionUnavailableError("usage_limit", "p", "limit"),
			"a 401": new SubscriptionUnavailableError("logged_out", "p", "logout"),
			"a boundary abort": new SubscriptionUnavailableError(
				"boundary",
				"p",
				"a tool",
			),
			"a tool attempt": new Error("the model tried to use a tool"),
		};
		for (const [ending, error] of Object.entries(endings))
			for (const codex of [false, true])
				for (const withUsage of [false, true]) {
					const spend = new MemorySpend(100_000_000);
					const { row, spent } = await run(
						failing({ sent: true, usage: withUsage, error, codex }),
						spend,
					);
					const label = `${ending} ${codex ? "codex" : "claude"} ${withUsage}`;
					expect(row, label).toMatchObject({
						status: "settled",
						billing: "subscription",
						cost: 0,
						modelCalls: 1,
						basis: SUBSCRIPTION_BASIS,
						error: error.message,
					});
					expect(row.tokens, label).toBe(withUsage ? 12_000 : undefined);
					expect(spent, label).toBe(0);
					// No stop: the confirmation stands and the next call is sent.
					expect(spend.stopped.size, label).toBe(0);
					expect(spend.extraUsageOff, label).toBe(true);
				}
	});

	it("releases a call that failed before its prompt was sent", async () => {
		const { row, spent } = await run(
			failing({ sent: false, error: new Error("mkdtemp failed") }),
		);
		expect(row).toMatchObject({ status: "settled", cost: 0, modelCalls: 0 });
		expect(spent).toBe(0);
	});

	it("releases a call refused before sending with an earlier paid call's error, stopping nothing new", async () => {
		const spend = new MemorySpend(100_000_000);
		const { row } = await run(
			failing({
				sent: false,
				error: new SubscriptionUnavailableError(
					"extra_usage",
					"p",
					"paid",
					undefined,
					true,
				),
			}),
			spend,
		);
		expect(row).toMatchObject({
			status: "settled",
			billing: "subscription",
			cost: 0,
			modelCalls: 0,
		});
		expect(spend.stopped.size).toBe(0);
		expect(spend.extraUsageOff).toBe(true);
	});

	it("records a paid Codex call as ChatGPT credits and stops Codex only: Claude and its confirmation stay", async () => {
		const spend = new MemorySpend(100_000_000);
		const paid = new SubscriptionUnavailableError(
			"extra_usage",
			"p",
			"the credit balance went down",
			undefined,
			true,
		);
		const { row, spent } = await run(
			failing({ sent: true, usage: true, error: paid, codex: true }),
			spend,
		);
		expect(row).toMatchObject({ status: "settled", billing: "api" });
		expect(row.cost).toBeGreaterThan(0);
		expect(row.basis).toMatch(/ChatGPT credits on the Codex plan/);
		expect(row.basis).not.toMatch(/Claude/);
		expect(spent).toBe(row.cost);
		expect([...spend.stopped]).toEqual(["openai"]);
		expect(spend.extraUsageOff).toBe(true);
		// Claude still runs.
		const claude = await run(
			failing({ sent: true, error: new Error("no answer") }),
			spend,
		);
		expect(claude.row).toMatchObject({ status: "settled", modelCalls: 1 });
	});
});

describe("the subscription call budget", () => {
	const call = (metered: MeteredLlm) =>
		metered
			.generateObject({
				task: "x",
				system: "",
				prompt: "x",
				schema: {} as never,
			})
			.catch((e: unknown) => e);

	it("counts the model calls a call really made, and refuses one that would pass the budget, before the CLI runs", async () => {
		const spend = new MemorySpend(100_000_000);
		spend.budget = 2;
		const provider = priced();
		const metered = new MeteredLlm(provider, spend, {
			userId: "u1",
			applicationId: null,
		});
		// Each call reserves the one prompt it sends, and settles at it.
		await expect(call(metered)).resolves.toEqual({ ok: true });
		expect(spend.rows[0]?.modelCalls).toBe(1);
		await expect(call(metered)).resolves.toEqual({ ok: true });
		// 2 used, 1 more would pass 2: refused, recorded with why, nothing sent.
		const error = await call(metered);
		expect(error).toBeInstanceOf(SubscriptionUnavailableError);
		expect((error as SubscriptionUnavailableError).kind).toBe("call_budget");
		expect(provider.calls).toEqual(["x", "x"]);
		expect(spend.rows.at(-1)?.error).toMatch(
			/^Subscription paused \(call_budget.*2 of 2 model calls in the last 24 hours.*Settings > Models/,
		);
	});

	it("leaves scoring waiting in found once the budget is used, and the sweep resumes it only when there is room", async () => {
		const spend = new MemorySpend(100_000_000);
		spend.budget = 0;
		const scoring = new FakeSubscriptionProvider("u1");
		const { repo, app, deps } = await setup(spend, {
			llm: scoring,
			claimsLlm: new FakeLlmProvider(),
		});
		expect(repo.apps[0]?.state).toBe("found");
		expect(scoring.calls).toEqual([]);
		expect(spend.rows[0]?.error).toMatch(/call_budget/);
		const later = new Date(Date.now() + 3 * 60 * 60_000);
		const held = await sweepStuckApplications(deps, "u1", { now: later });
		expect(held.restarted).toEqual([]);
		expect(held.waiting).toMatch(/model calls in the last 24 hours/);
		expect(scoring.calls).toEqual([]);
		spend.budget = 40;
		const swept = await sweepStuckApplications(deps, "u1", { now: later });
		expect(swept.restarted).toEqual([app.jobId]);
		expect(repo.apps[0]?.state).not.toBe("found");
	});

	it("queues the jobs a scan finds past the budget, and scores them as the window frees room", async () => {
		const spend = new MemorySpend(100_000_000);
		spend.budget = 2;
		const scoring = new FakeSubscriptionProvider("u1");
		const repo = new MemoryRepo(structuredClone(PROFILE));
		repo.onDemand = true;
		repo.addCompany({ name: "Acme", source: "greenhouse", sourceKey: "acme" });
		const postings = [1, 2, 3, 4, 5].map((n) => ({
			...POSTING,
			externalId: `q${n}`,
			url: `https://boards.greenhouse.io/acme/jobs/q${n}`,
		}));
		const workflows = new LocalWorkflowStarter();
		const deps: PipelineDeps = {
			repo,
			sources: {
				greenhouse: { kind: "greenhouse", listJobs: async () => postings },
			},
			llm: scoring,
			claimsLlm: new FakeLlmProvider(),
			exporter: fakeExporter(),
			now: () => new Date("2026-10-30T12:00:00Z"),
			notifier: new NoopNotifier(),
			workflows,
			spend,
		};
		workflows.bind(deps);
		await runScanFlow(new LocalStep(), deps, { userId: "u1", trigger: "cli" });
		const states = () => repo.apps.map((a) => a.state).sort();
		// Two calls of room: two scored, three wait in found, each paused on the budget.
		expect(states()).toEqual(["found", "found", "found", "scored", "scored"]);
		expect(scoring.calls).toHaveLength(2);
		expect(
			spend.rows.filter((r) => /call_budget/.test(r.error ?? "")),
		).toHaveLength(3);
		const later = new Date(Date.now() + 3 * 60 * 60_000);
		// Still used up: the sweep leaves them waiting.
		const held = await sweepStuckApplications(deps, "u1", { now: later });
		expect(held.restarted).toEqual([]);
		expect(held.waiting).toMatch(/2 of 2 model calls/);
		// The window moves on (the calls leave it): the sweep starts them; two more are scored.
		spend.rows = [];
		await sweepStuckApplications(deps, "u1", { now: later });
		expect(states()).toEqual(["found", "scored", "scored", "scored", "scored"]);
		spend.rows = [];
		await sweepStuckApplications(deps, "u1", { now: later });
		expect(states()).toEqual([
			"scored",
			"scored",
			"scored",
			"scored",
			"scored",
		]);
		expect(scoring.calls).toHaveLength(5);
	});

	it("defaults to 500 calls a day", () => {
		expect(DEFAULT_SUBSCRIPTION_DAILY_CALLS).toBe(500);
	});

	it("does not start preparation without room for a draft, and says why on the application", async () => {
		const spend = new MemorySpend(100_000_000);
		const tailoring = new FakeSubscriptionProvider("u1");
		const scoring = new FakeLlmProvider();
		const repo = new MemoryRepo(structuredClone(PROFILE));
		repo.addCompany({ name: "Acme", source: "greenhouse", sourceKey: "acme" });
		const workflows = new LocalWorkflowStarter();
		const deps: PipelineDeps = {
			repo,
			sources: {
				greenhouse: { kind: "greenhouse", listJobs: async () => [POSTING] },
			},
			llm: scoring,
			tailorLlm: tailoring,
			claimsLlm: new FakeLlmProvider(),
			exporter: fakeExporter(),
			now: () => new Date("2026-10-30T12:00:00Z"),
			notifier: new NoopNotifier(),
			workflows,
			spend,
		};
		workflows.bind(deps);
		spend.budget = 0;
		await runScanFlow(new LocalStep(), deps, { userId: "u1", trigger: "cli" });
		expect(repo.apps[0]?.state).toBe("scored");
		expect(tailoring.calls).toEqual([]);
		expect(spend.rows.at(-1)?.error).toMatch(/call_budget/);
	});
});

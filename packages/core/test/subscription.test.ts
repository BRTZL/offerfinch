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
	ANSWERED_NO_USAGE_BASIS,
	BILLING_UNCLEAR_BASIS,
	EXTRA_USAGE_BASIS,
	MeteredLlm,
	OUTCOME_UNKNOWN_BASIS,
	PAYMENT_UNKNOWN_BASIS,
	SpendingCapReachedError,
	type SpendStore,
	SUBSCRIPTION_BASIS,
} from "../src/scoring/metered";
import { FIXTURES, fakeExporter } from "./helpers";
import { MemoryRepo } from "./memory-repo";

/**
 * Subscription providers: every call is a $0 row marked `subscription` with the tokens the CLI
 * reported, the cap neither refuses nor counts them, and a usage limit or a logout pauses the
 * application (no step retries, never `failed`) until the sweep wakes it.
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
 * Mirrors DrizzleSpendStore: every reservation (subscription too) counts at its worst case
 * until settled; settled spend counts only `api` rows; a subscription call needs the user's
 * confirmation that extra usage is off.
 */
class MemorySpend implements SpendStore {
	rows: Row[] = [];
	pausedJobIds: string[] = [];
	extraUsageOff = true;
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
				(r.status === "reserved"
					? r.estimate
					: r.billing === "api"
						? r.cost
						: 0),
			0,
		);
	}
	async reserveSpend(input: Parameters<SpendStore["reserveSpend"]>[0]) {
		const billing = input.billing ?? "api";
		if (billing === "subscription" && !this.extraUsageOff)
			return { ok: false as const, reason: "extra_usage_unconfirmed" as const };
		const budget = await this.subscriptionBudget();
		if (
			billing === "subscription" &&
			budget.used + (input.modelCalls ?? 0) > budget.budget
		)
			return { ok: false as const, reason: "call_budget" as const, ...budget };
		if (this.used() + input.estimateMicros > this.capMicros)
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
	clearedVendors: (string | undefined)[] = [];
	async clearExtraUsageConfirmation(_userId: string, vendor?: string) {
		this.clearedVendors.push(vendor);
		this.extraUsageOff = false;
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
		if (input.billing) row.billing = input.billing;
		if (input.modelCalls !== undefined) row.modelCalls = input.modelCalls;
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
	it("records $0 rows marked subscription with real tokens, after reserving each call's worst case", async () => {
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

	it("pauses a subscription call when the cap has no room for its worst case (it could turn out paid)", async () => {
		const spend = new MemorySpend(0);
		const provider = priced();
		const metered = new MeteredLlm(provider, spend, {
			userId: "u1",
			applicationId: null,
		});
		const error = await metered
			.generateObject({
				task: "x",
				system: "",
				prompt: "x",
				schema: {} as never,
			})
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SpendingCapReachedError);
		expect(provider.calls).toEqual([]);
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

	it("refuses every subscription call until extra usage is confirmed off, before the CLI runs, and says how", async () => {
		const spend = new MemorySpend(100_000_000);
		spend.extraUsageOff = false;
		const provider = priced();
		const metered = new MeteredLlm(provider, spend, {
			userId: "u1",
			applicationId: null,
		});
		const error = await call(metered);
		expect(error).toBeInstanceOf(SubscriptionUnavailableError);
		expect((error as SubscriptionUnavailableError).kind).toBe("extra_usage");
		expect(provider.calls).toEqual([]);
		expect(spend.rows[0]?.error).toMatch(
			new RegExp(`^${SUBSCRIPTION_PAUSE_PREFIX} \\(extra_usage`),
		);
		expect(spend.rows[0]?.error).toMatch(/Settings › Models/);
	});

	it("records a call that drew on extra usage at its API price, counted by the cap, and withdraws the confirmation", async () => {
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
		expect(row?.basis).toMatch(new RegExp(`^${EXTRA_USAGE_BASIS}`));
		expect((await spend.spendingStatus()).spentMicros).toBe(row?.cost);
		expect(spend.extraUsageOff).toBe(false);
		// The next call is refused until the user confirms again.
		failure = "";
		const next = await call(metered);
		expect((next as SubscriptionUnavailableError).kind).toBe("extra_usage");
		expect(provider.calls).toEqual(["x"]);
	});

	it("holds a paid call that reported no usage at its worst case against the cap", async () => {
		const spend = new MemorySpend(100_000_000);
		const provider = priced(() => "extra_usage_no_usage");
		const metered = new MeteredLlm(provider, spend, {
			userId: "u1",
			applicationId: null,
		});
		await call(metered);
		const row = spend.rows[0];
		expect(row).toMatchObject({ billing: "api", status: "reserved" });
		expect((await spend.spendingStatus()).spentMicros).toBe(row?.estimate);
		expect(row?.estimate).toBeGreaterThan(0);
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
		/** The result arrived and the session showed no sign of paid extra usage. */
		answered?: boolean;
	}) {
		const provider: LlmProvider = {
			name: opts.codex
				? "codex-subscription:gpt-6.1-sol"
				: "claude-subscription:claude-sonnet-5-5",
			...(opts.codex ? { vendor: "openai" } : {}),
			billing: "subscription",
			ownerUserId: "u1",
			async generateObject<T>(request: GenerateObjectRequest<T>): Promise<T> {
				if (opts.sent) request.onModelCall?.();
				if (opts.usage) request.onUsage?.(usage);
				if (opts.answered) request.onAnswered?.();
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
		const row = spend.rows[0];
		if (!row) throw new Error("no row");
		return { row, spent: (await spend.spendingStatus()).spentMicros };
	}

	it("holds a sent prompt whose answer never came back at its reservation", async () => {
		const { row, spent } = await run(
			failing({
				sent: true,
				error: new Error("the CLI ended without an answer"),
			}),
		);
		expect(row).toMatchObject({
			status: "reserved",
			billing: "subscription",
			modelCalls: 1,
			error: "the CLI ended without an answer",
		});
		expect(row.estimate).toBeGreaterThan(0);
		expect(spent).toBe(row.estimate);
	});

	it("releases a call that failed before its prompt was sent", async () => {
		const { row, spent } = await run(
			failing({ sent: false, error: new Error("mkdtemp failed") }),
		);
		expect(row).toMatchObject({ status: "settled", cost: 0, modelCalls: 0 });
		expect(spent).toBe(0);
	});

	it("releases a sent prompt the vendor refused before processing (a 429 or 401 pause)", async () => {
		for (const kind of ["usage_limit", "logged_out"] as const) {
			const { row, spent } = await run(
				failing({
					sent: true,
					error: new SubscriptionUnavailableError(kind, "p", "refused"),
				}),
			);
			expect(row).toMatchObject({ status: "settled", cost: 0, modelCalls: 1 });
			expect(spent).toBe(0);
		}
	});

	it("holds a sent prompt the session aborted after sending (a boundary violation)", async () => {
		const { row } = await run(
			failing({
				sent: true,
				error: new SubscriptionUnavailableError("boundary", "p", "a tool"),
			}),
		);
		expect(row.status).toBe("reserved");
	});

	it("releases a call refused before sending with an earlier paid call's error, keeping the confirmation", async () => {
		const spend = new MemorySpend(100_000_000);
		const metered = new MeteredLlm(
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
			{ userId: "u1", applicationId: null },
		);
		await metered
			.generateObject({
				task: "x",
				system: "",
				prompt: "x",
				schema: {} as never,
			})
			.catch(() => {});
		expect(spend.rows[0]).toMatchObject({
			status: "settled",
			billing: "subscription",
			cost: 0,
			modelCalls: 0,
		});
		expect(spend.extraUsageOff).toBe(true);
	});

	it("holds a sent call whose payment is unknown at its reservation, tokens or not, and stops later calls until confirmed again", async () => {
		for (const withUsage of [true, false]) {
			const spend = new MemorySpend(100_000_000);
			const unknown = new SubscriptionUnavailableError(
				"extra_usage",
				"p",
				"the credit balance could not be read again",
				undefined,
				"unknown",
			);
			const metered = new MeteredLlm(
				failing({ sent: true, usage: withUsage, error: unknown, codex: true }),
				spend,
				{ userId: "u1", applicationId: null },
			);
			const request = {
				task: "x",
				system: "",
				prompt: "x",
				schema: {} as never,
			};
			expect(await metered.generateObject(request).catch((e) => e)).toBe(
				unknown,
			);
			const row = spend.rows[0];
			expect(row).toMatchObject({
				status: "reserved",
				billing: "subscription",
				modelCalls: 1,
			});
			expect(row?.basis?.startsWith(PAYMENT_UNKNOWN_BASIS)).toBe(true);
			expect(row?.estimate).toBeGreaterThan(0);
			expect((await spend.spendingStatus()).spentMicros).toBe(row?.estimate);
			// Nothing further is sent until the user reconciles and confirms again: the paid-call
			// path's withdrawal, for this provider's vendor.
			expect(spend.extraUsageOff).toBe(false);
			expect(spend.clearedVendors).toEqual(["openai"]);
			const next = await metered.generateObject(request).catch((e) => e);
			expect((next as SubscriptionUnavailableError).kind).toBe("extra_usage");
			expect(spend.rows[1]).toMatchObject({ status: "settled", cost: 0 });
		}
	});

	it("releases a call refused before sending with an earlier unknown-payment error, keeping the confirmation", async () => {
		const { row } = await run(
			failing({
				sent: false,
				error: new SubscriptionUnavailableError(
					"extra_usage",
					"p",
					"unknown",
					undefined,
					"unknown",
				),
			}),
		);
		expect(row).toMatchObject({ status: "settled", cost: 0, modelCalls: 0 });
	});

	it("settles at $0 a call whose answer arrived but failed the schema, without usage, and keeps Claude running", async () => {
		const spend = new MemorySpend(100_000_000);
		const provider = failing({
			sent: true,
			answered: true,
			error: new Error(
				"claude-subscription:claude-opus-5-5: no valid structured output for fit-score: Failed to provide valid structured output after 1 attempts",
			),
		});
		const { row, spent } = await run(provider, spend);
		expect(row).toMatchObject({
			status: "settled",
			billing: "subscription",
			cost: 0,
			modelCalls: 1,
			basis: ANSWERED_NO_USAGE_BASIS,
		});
		expect(row.error).toMatch(/no valid structured output/);
		expect(spent).toBe(0);
		// No pause: the confirmation stands and the next call is sent.
		expect(spend.extraUsageOff).toBe(true);
		expect(spend.clearedVendors).toEqual([]);
		await run(provider, spend);
		expect(spend.rows[1]).toMatchObject({ status: "settled", modelCalls: 1 });
	});

	it("still holds a sent call whose answer never arrived (no result)", async () => {
		const { row, spent } = await run(
			failing({ sent: true, error: new Error("lost response") }),
		);
		expect(row).toMatchObject({
			status: "reserved",
			billing: "subscription",
			basis: OUTCOME_UNKNOWN_BASIS,
		});
		expect(spent).toBe(row.estimate);
	});

	it("records a paid call at its API price and withdraws the confirmation even when its answer arrived", async () => {
		const spend = new MemorySpend(100_000_000);
		const paid = new SubscriptionUnavailableError(
			"extra_usage",
			"p",
			"drew on extra usage",
			undefined,
			true,
		);
		const { row, spent } = await run(
			failing({ sent: true, usage: true, answered: true, error: paid }),
			spend,
		);
		expect(row).toMatchObject({ status: "settled", billing: "api" });
		expect(row.cost).toBeGreaterThan(0);
		expect(row.basis).toMatch(new RegExp(`^${EXTRA_USAGE_BASIS}`));
		expect(spent).toBe(row.cost);
		expect(spend.extraUsageOff).toBe(false);
		// Without usage, the paid call is still held at its worst case, as api.
		const held = await run(
			failing({ sent: true, answered: true, error: paid }),
		);
		expect(held.row).toMatchObject({ status: "reserved", billing: "api" });
	});

	it("still holds a sent call whose payment is unknown even when its answer arrived", async () => {
		const { row } = await run(
			failing({
				sent: true,
				answered: true,
				error: new SubscriptionUnavailableError(
					"extra_usage",
					"p",
					"unknown",
					undefined,
					"unknown",
				),
			}),
		);
		expect(row.status).toBe("reserved");
		expect(row.basis?.startsWith(PAYMENT_UNKNOWN_BASIS)).toBe(true);
	});

	it("returns a valid answer from a session that also failed, but holds its spend", async () => {
		const spend = new MemorySpend(100_000_000);
		const provider: LlmProvider = {
			name: "claude-subscription:claude-sonnet-5-5",
			billing: "subscription",
			ownerUserId: "u1",
			async generateObject<T>(request: GenerateObjectRequest<T>): Promise<T> {
				request.onModelCall?.();
				request.onUsage?.(usage);
				request.onBillingUnclear?.("a crash result after the answer");
				return { ok: true } as T;
			},
		};
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
		const row = spend.rows[0];
		expect(row).toMatchObject({
			status: "reserved",
			billing: "subscription",
			error: "a crash result after the answer",
			modelCalls: 1,
		});
		expect(row?.basis?.startsWith(BILLING_UNCLEAR_BASIS)).toBe(true);
		expect((await spend.spendingStatus()).spentMicros).toBe(row?.estimate);
	});

	it("holds a call whose session failed around its answer even when the answer failed the schema, with tokens", async () => {
		const provider: LlmProvider = {
			name: "claude-subscription:claude-sonnet-5-5",
			billing: "subscription",
			ownerUserId: "u1",
			async generateObject<T>(request: GenerateObjectRequest<T>): Promise<T> {
				request.onModelCall?.();
				request.onUsage?.(usage);
				request.onBillingUnclear?.("a crash result after the answer");
				throw new Error("no valid structured output");
			},
		};
		const { row, spent } = await run(provider);
		expect(row).toMatchObject({ status: "reserved", modelCalls: 1 });
		expect(row.basis?.startsWith(BILLING_UNCLEAR_BASIS)).toBe(true);
		expect(spent).toBe(row.estimate);
	});

	it("settles an answer that failed the schema at $0 with its tokens", async () => {
		const { row, spent } = await run(
			failing({ sent: true, usage: true, error: new Error("bad schema") }),
		);
		expect(row).toMatchObject({
			status: "settled",
			cost: 0,
			basis: SUBSCRIPTION_BASIS,
			tokens: 12_000,
		});
		expect(spent).toBe(0);
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

import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { NormalizedJob } from "../src/domain/types";
import { NoopNotifier } from "../src/notify/ntfy";
import { runApplicationFlow } from "../src/pipeline/application-flow";
import { LocalStep, LocalWorkflowStarter } from "../src/pipeline/local";
import type { PipelineDeps } from "../src/pipeline/ports";
import { runScanFlow } from "../src/pipeline/scan-flow";
import { sweepStuckApplications } from "../src/pipeline/sweep";
import { loadProfileFromDir } from "../src/profile/load-node";
import { AnthropicProvider } from "../src/scoring/anthropic";
import { FakeLlmProvider } from "../src/scoring/fake";
import {
	type GenerateObjectRequest,
	LlmNotBilledError,
	type LlmProvider,
	LlmRefusalError,
} from "../src/scoring/llm";
import {
	MeteredLlm,
	SpendingCapReachedError,
	type SpendStore,
} from "../src/scoring/metered";
import { OpenAiProvider } from "../src/scoring/openai";
import { estimateCost } from "../src/scoring/pricing";
import { FIXTURES, fakeExporter } from "./helpers";
import { MemoryRepo } from "./memory-repo";

/**
 * Cost tracking and the spending cap: every call records model, tokens and estimated cost per
 * application, and preparation stops before a call that would pass the cap.
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

/** The fake's answers, billed as Claude Opus 5.5 would bill 10k input and 2k output tokens. */
class PricedFake implements LlmProvider {
	readonly name = "anthropic:claude-opus-5-5";
	readonly fake = new FakeLlmProvider();
	async generateObject<T>(request: GenerateObjectRequest<T>): Promise<T> {
		const output = await this.fake.generateObject({
			...request,
			onUsage: undefined,
		});
		request.onUsage?.({
			model: "claude-opus-5-5",
			inputTokens: 10_000,
			outputTokens: 2_000,
			cachedInputTokens: 0,
			cacheWriteTokens: 0,
		});
		return output;
	}
}

class MemorySpend implements SpendStore {
	rows: {
		id: string;
		applicationId: string | null;
		task: string;
		status: "reserved" | "settled";
		micros: number;
		model?: string;
		error?: string | null;
	}[] = [];
	constructor(
		public capMicros: number,
		public enabled = true,
	) {}
	private used() {
		return this.rows.reduce((n, r) => n + r.micros, 0);
	}
	async reserveSpend(input: Parameters<SpendStore["reserveSpend"]>[0]) {
		if (this.enabled && this.used() + input.estimateMicros > this.capMicros)
			return {
				ok: false as const,
				reason: "cap" as const,
				spentMicros: this.used(),
				capMicros: this.capMicros,
			};
		const id = String(this.rows.length + 1);
		this.rows.push({
			id,
			applicationId: input.applicationId,
			task: input.task,
			status: "reserved",
			micros: input.estimateMicros,
		});
		return { ok: true as const, id };
	}
	async recordRefusal() {}
	async subscriptionBudget() {
		return { budget: 40, used: 0, resetsAt: null };
	}
	async recordPaidStop() {}
	pausedJobIds: string[] = [];
	async listCapPausedJobIds() {
		return this.pausedJobIds;
	}
	async spendingStatus() {
		const settled = this.rows.filter((r) => r.status === "settled");
		const reserved = this.rows.filter((r) => r.status === "reserved");
		return {
			enabled: this.enabled,
			capMicros: this.capMicros,
			spentMicros: settled.reduce((n, r) => n + r.micros, 0),
			reservedMicros: reserved.reduce((n, r) => n + r.micros, 0),
		};
	}
	async holdSpend(id: string, input: Parameters<SpendStore["holdSpend"]>[1]) {
		const row = this.rows.find((r) => r.id === id);
		if (!row) throw new Error("no reservation");
		row.error = input.error;
	}
	async settleSpend(
		id: string,
		input: Parameters<SpendStore["settleSpend"]>[1],
	) {
		const row = this.rows.find((r) => r.id === id);
		if (!row) throw new Error("no reservation");
		row.status = "settled";
		row.micros = input.costMicros;
		row.model = input.usage?.model;
		row.error = input.error;
	}
}

async function setup(spend: MemorySpend) {
	const repo = new MemoryRepo(structuredClone(PROFILE));
	repo.addCompany({
		name: "Acme Robotics",
		source: "greenhouse",
		sourceKey: "acme",
	});
	const workflows = new LocalWorkflowStarter();
	const deps: PipelineDeps = {
		repo,
		sources: {
			greenhouse: { kind: "greenhouse", listJobs: async () => [POSTING] },
		},
		llm: new PricedFake(),
		claimsLlm: new PricedFake(),
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
	const wake = () =>
		runApplicationFlow(new LocalStep(), deps, {
			userId: "u1",
			jobId: app.jobId,
		});
	return { repo, app, wake, deps };
}

const CALL = estimateCost({
	model: "claude-opus-5-5",
	inputTokens: 10_000,
	outputTokens: 2_000,
	cachedInputTokens: 0,
	cacheWriteTokens: 0,
}).micros;

describe("spending cap", () => {
	it("prices a call from the table: 10k in + 2k out on Claude Opus 5.5 is $0.08", () => {
		expect(CALL).toBe(80_000);
	});

	it("records model and estimated cost per application for every call", async () => {
		const spend = new MemorySpend(100_000_000);
		const { repo, app } = await setup(spend);
		expect(repo.apps[0]?.state).not.toBe("preparing");
		const tasks = spend.rows.map((r) => r.task);
		expect(tasks).toContain("fit-score");
		expect(tasks).toContain("tailor");
		expect(tasks).toContain("claims-check");
		expect(spend.rows.filter((r) => r.status !== "settled")).toEqual([]);
		expect(spend.rows.every((r) => r.applicationId === app.id)).toBe(true);
		expect(
			spend.rows.every(
				(r) => r.micros === CALL && r.model === "claude-opus-5-5",
			),
		).toBe(true);
	});

	it("stops before the call that would pass the cap, and resumes when it is raised", async () => {
		// Room for the fit score's worst case, not for tailoring's.
		const spend = new MemorySpend(1_500_000);
		const { repo, app, wake } = await setup(spend);
		expect(repo.apps[0]?.state).toBe("preparing");
		expect(repo.documents.filter((d) => d.applicationId === app.id)).toEqual(
			[],
		);
		expect(spend.rows.map((r) => r.task)).toEqual(["fit-score"]);
		spend.capMicros = 100_000_000;
		await wake();
		expect(["ready_for_review", "needs_answers"]).toContain(
			repo.apps[0]?.state,
		);
	});

	it("does not even score a job once the month's spend has reached the cap", async () => {
		const spend = new MemorySpend(0);
		const { repo } = await setup(spend);
		expect(repo.apps[0]?.state).toBe("found");
		expect(spend.rows).toEqual([]);
	});

	it("a turned-off cap tracks cost but never stops anything", async () => {
		const spend = new MemorySpend(0, false);
		const { repo } = await setup(spend);
		expect(repo.apps[0]?.state).not.toBe("found");
		expect(spend.rows.length).toBeGreaterThan(2);
	});

	it("records the tokens of a refused call, which the provider bills", async () => {
		const spend = new MemorySpend(100_000_000);
		const refusing: LlmProvider = {
			name: "openai:gpt-6.1-terra",
			async generateObject(request) {
				request.onUsage?.({
					model: "gpt-6.1-terra",
					inputTokens: 1_000,
					outputTokens: 100,
					cachedInputTokens: 0,
					cacheWriteTokens: 0,
				});
				throw new LlmRefusalError(request.task, "declined");
			},
		};
		const metered = new MeteredLlm(refusing, spend, {
			userId: "u1",
			applicationId: "a1",
		});
		await expect(
			metered.generateObject({
				task: "claims-check",
				system: "",
				prompt: "x",
				schema: {} as never,
			}),
		).rejects.toBeInstanceOf(LlmRefusalError);
		expect(spend.rows[0]).toMatchObject({
			status: "settled",
			micros: 1_500,
			model: "gpt-6.1-terra",
		});
		expect(spend.rows[0]?.error).toMatch(/declined/);
	});

	it("never prices an unknown model at $0", () => {
		const cost = estimateCost({
			model: "some-new-model",
			inputTokens: 1_000_000,
			outputTokens: 0,
			cachedInputTokens: 0,
			cacheWriteTokens: 0,
		});
		expect(cost.micros).toBe(10_000_000);
		expect(cost.basis).toMatch(/no price for some-new-model/);
	});

	it("the sweep resumes preparation the cap paused once there is room again", async () => {
		const spend = new MemorySpend(1_500_000);
		const { repo, app, deps } = await setup(spend);
		expect(repo.apps[0]?.state).toBe("preparing");
		spend.pausedJobIds = [app.jobId];
		// Still no room for tailoring: a restarted run is refused before any call is made.
		await sweepStuckApplications(deps, "u1");
		expect(repo.apps[0]?.state).toBe("preparing");
		expect(spend.rows.map((r) => r.task)).toEqual(["fit-score"]);
		// A new month (or a higher cap) leaves room.
		spend.capMicros = 100_000_000;
		const swept = await sweepStuckApplications(deps, "u1");
		expect(swept.resumed).toEqual([app.jobId]);
		expect(["ready_for_review", "needs_answers"]).toContain(
			repo.apps[0]?.state,
		);
	});
});

/**
 * Codex re-check of 647487f, finding 3: the reservation assumed three characters per token,
 * left out the output schema and priced the configured model, so a call settled above what it
 * reserved (reserved 101, settled 301) and parallel calls could pass the cap together.
 */
describe("the reservation bounds what a call can settle at", () => {
	const schema = z.object({
		claims: z.array(
			z.object({
				text: z.string().describe("A long description ".repeat(40)),
				quote: z.string(),
			}),
		),
	});

	async function reserveThenSettle(prompt: string, answeredBy: string) {
		const spend = new MemorySpend(1_000_000_000);
		let reserved = 0;
		const reserve = spend.reserveSpend.bind(spend);
		spend.reserveSpend = async (input) => {
			reserved = input.estimateMicros;
			return reserve(input);
		};
		const system = "You check facts.";
		const maxTokens = 2_000;
		const sent = new TextEncoder().encode(
			system + prompt + JSON.stringify(z.toJSONSchema(schema)),
		).length;
		const provider: LlmProvider = {
			name: "anthropic:claude-opus-5-5",
			async generateObject(request) {
				// The provider bills one token per byte sent plus its framing, all output, at the
				// model that answered (a server-side fallback here), every input token a cache write.
				request.onUsage?.({
					model: answeredBy,
					inputTokens: 0,
					cacheWriteTokens: sent + 1_000,
					outputTokens: maxTokens,
					cachedInputTokens: 0,
				});
				return { claims: [] } as never;
			},
		};
		await new MeteredLlm(provider, spend, {
			userId: "u1",
			applicationId: "a1",
		}).generateObject({
			task: "claims-check",
			system,
			prompt,
			schema,
			maxTokens,
		});
		return { reserved, settled: spend.rows[0]?.micros ?? 0 };
	}

	it("holds for emoji and CJK text, the schema, and an unknown answering model", async () => {
		const { reserved, settled } = await reserveThenSettle(
			"🙂漢字".repeat(2_000),
			"some-new-model",
		);
		expect(settled).toBeGreaterThan(0);
		expect(settled).toBeLessThanOrEqual(reserved);
	});

	it("holds when a priced model answers past its priced range", async () => {
		const { reserved, settled } = await reserveThenSettle(
			"x".repeat(300_000),
			"claude-haiku-5-5",
		);
		expect(settled).toBeLessThanOrEqual(reserved);
	});
});

/**
 * Codex re-check of 647487f, finding 4: a call that failed without reporting usage settled at
 * zero, though a lost response or stream may still be billed, and a retry spent again on top.
 */
describe("a call with an unknown outcome", () => {
	const failing = (error: Error): LlmProvider => ({
		name: "anthropic:claude-opus-5-5",
		async generateObject() {
			throw error;
		},
	});
	const call = (spend: MemorySpend, provider: LlmProvider) =>
		new MeteredLlm(provider, spend, {
			userId: "u1",
			applicationId: "a1",
		}).generateObject({
			task: "tailor",
			system: "s",
			prompt: "p",
			schema: z.object({ ok: z.boolean() }),
			maxTokens: 1_000,
		});

	it("keeps the reservation when the stream is lost, so a retry cannot pass the cap", async () => {
		const spend = new MemorySpend(100_000_000);
		await expect(
			call(spend, failing(new Error("stream ended without a message"))),
		).rejects.toThrow(/stream/);
		expect(spend.rows[0]).toMatchObject({ status: "reserved" });
		expect(spend.rows[0]?.micros).toBeGreaterThan(0);
		expect(spend.rows[0]?.error).toMatch(/stream/);
		const status = await spend.spendingStatus();
		expect(status.reservedMicros).toBe(spend.rows[0]?.micros);
		// With the cap at exactly one held call, the retry is refused.
		spend.capMicros = spend.rows[0]?.micros ?? 0;
		await expect(
			call(spend, failing(new Error("again"))),
		).rejects.toBeInstanceOf(SpendingCapReachedError);
	});

	it("releases the reservation only when the provider refused before processing", async () => {
		const spend = new MemorySpend(100_000_000);
		await expect(
			call(
				spend,
				failing(new LlmNotBilledError("tailor", 429, "rate limited")),
			),
		).rejects.toBeInstanceOf(LlmNotBilledError);
		expect(spend.rows[0]).toMatchObject({ status: "settled", micros: 0 });
	});

	it("charges an answer without reported usage at the reservation, not zero", async () => {
		const spend = new MemorySpend(100_000_000);
		const silent: LlmProvider = {
			name: "anthropic:claude-opus-5-5",
			async generateObject() {
				return { ok: true } as never;
			},
		};
		await call(spend, silent);
		expect(spend.rows[0]?.status).toBe("settled");
		expect(spend.rows[0]?.micros).toBeGreaterThan(0);
	});
});

/**
 * Codex review, finding 1: the Anthropic SDK retried inside one reservation. A 500 (possibly
 * billed) followed by a retried 400 surfaced as LlmNotBilledError and released the reservation,
 * and a retry that succeeded settled only its own usage. With SDK retries off, every attempt is
 * one provider call under one reservation; retries happen at the workflow step, which reserves
 * again.
 */
describe("provider attempts under the cap", () => {
	const schema = z.object({ ok: z.boolean() });
	const request = {
		task: "tailor",
		system: "s",
		prompt: "p",
		schema,
		maxTokens: 1_000,
	};
	const scripted = (statuses: number[]) => {
		const calls: string[] = [];
		const fetchImpl = async (url: string | URL | Request) => {
			calls.push(String(url));
			const status = statuses[Math.min(calls.length, statuses.length) - 1];
			return new Response(
				JSON.stringify({
					type: "error",
					error: { type: "api_error", message: `status ${status}` },
				}),
				{ status, headers: { "content-type": "application/json" } },
			);
		};
		return { calls, fetchImpl };
	};

	it("makes one Anthropic request per reservation and holds an ambiguous 500", async () => {
		const { calls, fetchImpl } = scripted([500, 400]);
		const client = new Anthropic({
			apiKey: "sk-test",
			baseURL: "http://127.0.0.1:9",
			fetch: fetchImpl as never,
		});
		const spend = new MemorySpend(100_000_000);
		const llm = new MeteredLlm(
			new AnthropicProvider({ client, fallbacks: false }),
			spend,
			{ userId: "u1", applicationId: "a1" },
		);
		const error = await llm.generateObject(request).catch((e: unknown) => e);
		expect(calls).toHaveLength(1);
		expect(error).not.toBeInstanceOf(LlmNotBilledError);
		expect(spend.rows).toHaveLength(1);
		expect(spend.rows[0]).toMatchObject({ status: "reserved" });
		expect(spend.rows[0]?.micros).toBeGreaterThan(0);
	});

	it("makes one OpenAI request per reservation and holds an ambiguous 500", async () => {
		const { calls, fetchImpl } = scripted([500, 400]);
		const spend = new MemorySpend(100_000_000);
		const llm = new MeteredLlm(
			new OpenAiProvider({
				apiKey: "sk-test",
				model: "gpt-x",
				fetch: fetchImpl,
			}),
			spend,
			{ userId: "u1", applicationId: "a1" },
		);
		const error = await llm.generateObject(request).catch((e: unknown) => e);
		expect(calls).toHaveLength(1);
		expect(error).not.toBeInstanceOf(LlmNotBilledError);
		expect(spend.rows[0]).toMatchObject({ status: "reserved" });
	});
});

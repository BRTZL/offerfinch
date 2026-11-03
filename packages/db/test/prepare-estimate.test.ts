import type { NormalizedJob } from "@offerfinch/core/domain/types";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	DashboardRepository,
	type Database,
	prepareEstimate,
	seedCompanies,
} from "../src/index";
import { execute, testDb } from "./setup";

/**
 * Issue #66: Prepare's estimate comes from what past preparations recorded, per step and per
 * model, as a median with the recorded range; with no history on the current models, none.
 */
let db: Database;
let repo: DashboardRepository;
let companyId = "";
let n = 0;

const TAILOR = "anthropic:claude-sonnet-5-5";
const CLAIMS = "openai:gpt-5.5";
const CLAUDE_PLAN = "claude-subscription:claude-sonnet-5-5";
const T0 = Date.UTC(2026, 9, 1);

beforeAll(async () => {
	db = await testDb();
	repo = new DashboardRepository(db);
	await seedCompanies(db, "u1", [
		{
			name: "Acme",
			source: "greenhouse",
			sourceKey: "acme",
			discoveredFrom: "t",
		},
	]);
	const [company] = await execute<{ id: string }>(
		db,
		sql`select id from companies where user_id = 'u1'`,
	);
	companyId = company?.id ?? "";
});
afterAll(() => db.$close());

async function application(): Promise<string> {
	n++;
	const job: NormalizedJob = {
		source: "greenhouse",
		externalId: String(n),
		url: `https://boards.greenhouse.io/acme/jobs/${n}`,
		title: `Engineer ${n}`,
		locations: ["Remote"],
		workplaceType: "remote",
		descriptionText: "React",
	};
	const { jobId } = await repo.upsertJob("u1", companyId, job);
	return (await repo.getApplicationByJob("u1", jobId))?.applicationId ?? "";
}

async function reviewed(appId: string, at: number) {
	await db.run(sql`insert into application_transitions
		(id, user_id, application_id, from_state, to_state, reason, actor, created_at)
		values (${crypto.randomUUID()}, 'u1', ${appId}, 'preparing', 'ready_for_review', 't', 'workflow', ${at})`);
}

async function usage(
	appId: string | null,
	row: {
		task: string;
		provider: string;
		micros?: number;
		calls?: number;
		at: number;
		status?: "settled" | "reserved";
		billing?: "api" | "subscription";
	},
) {
	await db.run(sql`insert into llm_usage
		(id, user_id, application_id, task, provider, status, estimate_micros, cost_micros,
		 model_calls, billing, created_at)
		values (${crypto.randomUUID()}, 'u1', ${appId}, ${row.task}, ${row.provider},
		 ${row.status ?? "settled"}, 500000, ${row.micros ?? 0}, ${row.calls ?? 0},
		 ${row.billing ?? "api"}, ${row.at})`);
}

/** A preparation that reached review at `T0 + day`, its steps at the costs given. */
async function prepared(
	day: number,
	steps: { task: string; provider: string; micros?: number; calls?: number }[],
) {
	const id = await application();
	const at = T0 + day * 86_400_000;
	for (const [i, s] of steps.entries())
		await usage(id, { ...s, at: at - 1000 + i });
	await reviewed(id, at);
	return { id, at };
}

describe("prepareEstimate", () => {
	it("has no estimate before any preparation on these models", async () => {
		expect(
			await prepareEstimate(db, "u1", { tailoring: TAILOR, claims: CLAIMS }),
		).toBeNull();
	});

	it("gives each step's median and recorded range on its current model", async () => {
		// Three past preparations: drafting 0.10, 0.20, 0.60; checking 0.02, 0.03, 0.04.
		await prepared(1, [
			{ task: "tailor", provider: TAILOR, micros: 60_000 },
			{ task: "tailor", provider: TAILOR, micros: 40_000 }, // the automatic redraft
			{ task: "claims-check", provider: CLAIMS, micros: 20_000 },
		]);
		await prepared(2, [
			{ task: "tailor", provider: TAILOR, micros: 200_000 },
			{ task: "claims-check", provider: CLAIMS, micros: 30_000 },
		]);
		const late = await prepared(3, [
			{ task: "tailor", provider: TAILOR, micros: 600_000 },
			{ task: "claims-check", provider: CLAIMS, micros: 40_000 },
		]);
		// Not part of a preparation: a Check again after review, a chat, scoring, a running call,
		// an unattributed call, and an application that never reached review.
		await usage(late.id, {
			task: "claims-check",
			provider: CLAIMS,
			micros: 9_000_000,
			at: late.at + 5000,
		});
		await usage(late.id, {
			task: "chat-application",
			provider: TAILOR,
			micros: 9_000_000,
			at: late.at + 6000,
		});
		await usage(late.id, {
			task: "fit-score",
			provider: TAILOR,
			micros: 9_000_000,
			at: late.at - 9000,
		});
		await usage(late.id, {
			task: "tailor",
			provider: TAILOR,
			micros: 9_000_000,
			at: late.at - 8000,
			status: "reserved",
		});
		await usage(null, {
			task: "tailor",
			provider: TAILOR,
			micros: 9_000_000,
			at: late.at,
		});
		const unfinished = await application();
		await usage(unfinished, {
			task: "tailor",
			provider: TAILOR,
			micros: 9_000_000,
			at: late.at,
		});

		const estimate = await prepareEstimate(db, "u1", {
			tailoring: TAILOR,
			claims: CLAIMS,
		});
		expect(estimate?.steps).toEqual([
			{
				task: "tailor",
				provider: TAILOR,
				plan: null,
				samples: 3,
				micros: { median: 200_000, low: 100_000, high: 600_000 },
				calls: { median: 0, low: 0, high: 0 },
			},
			{
				task: "claims-check",
				provider: CLAIMS,
				plan: null,
				samples: 3,
				micros: { median: 30_000, low: 20_000, high: 40_000 },
				calls: { median: 0, low: 0, high: 0 },
			},
		]);
	});

	it("leaves out preparations made on another model, and has none for a new one", async () => {
		// The claims check moved to another model: no history there yet.
		expect(
			await prepareEstimate(db, "u1", {
				tailoring: TAILOR,
				claims: "openai:other",
			}),
		).toBeNull();
		// A preparation whose drafts mixed models does not count towards either.
		await prepared(4, [
			{ task: "tailor", provider: TAILOR, micros: 5_000_000 },
			{
				task: "tailor",
				provider: "anthropic:claude-opus-5-5",
				micros: 5_000_000,
			},
			{ task: "claims-check", provider: CLAIMS, micros: 30_000 },
		]);
		const estimate = await prepareEstimate(db, "u1", {
			tailoring: TAILOR,
			claims: CLAIMS,
		});
		expect(estimate?.steps[0]?.samples).toBe(3);
		expect(estimate?.steps[0]?.micros.high).toBe(600_000);
		expect(estimate?.steps[1]?.samples).toBe(4);
	});

	it("counts a subscription's calls and names its plan", async () => {
		await prepared(5, [
			{ task: "tailor", provider: CLAUDE_PLAN, calls: 1 },
			{ task: "claims-check", provider: CLAIMS, micros: 30_000 },
		]);
		await prepared(6, [
			{ task: "tailor", provider: CLAUDE_PLAN, calls: 1 },
			{ task: "tailor", provider: CLAUDE_PLAN, calls: 1 },
			{ task: "claims-check", provider: CLAIMS, micros: 30_000 },
		]);
		await prepared(7, [
			{ task: "tailor", provider: CLAUDE_PLAN, calls: 3 },
			{ task: "claims-check", provider: CLAIMS, micros: 30_000 },
		]);
		const estimate = await prepareEstimate(db, "u1", {
			tailoring: CLAUDE_PLAN,
			claims: CLAIMS,
		});
		expect(estimate?.steps[0]).toMatchObject({
			plan: "anthropic",
			samples: 3,
			calls: { median: 2, low: 1, high: 3 },
			micros: { median: 0, low: 0, high: 0 },
		});
		// An even number of preparations: the median is kept unrounded (1, 2, 3, 4 → 2.5).
		await prepared(8, [
			{ task: "tailor", provider: CLAUDE_PLAN, calls: 4 },
			{ task: "claims-check", provider: CLAIMS, micros: 30_000 },
		]);
		const even = await prepareEstimate(db, "u1", {
			tailoring: CLAUDE_PLAN,
			claims: CLAIMS,
		});
		expect(even?.steps[0]?.calls).toEqual({ median: 2.5, low: 1, high: 4 });
	});

	it("is the user's own history only", async () => {
		expect(
			await prepareEstimate(db, "someone-else", {
				tailoring: TAILOR,
				claims: CLAIMS,
			}),
		).toBeNull();
	});
});

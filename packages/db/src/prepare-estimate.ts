import { sql } from "drizzle-orm";

import type { Database } from "./client";
import { type SubscriptionVendor, subscriptionVendor } from "./spend";

/** The models Prepare would use now, as `llm_usage.provider` records them (`anthropic:…`). */
export interface PrepareModels {
	tailoring: string;
	claims: string;
}

/** A median with the lowest and highest recorded value beside it. */
interface Spread {
	median: number;
	low: number;
	high: number;
}

/** What one step of a preparation cost before, on the model it would use now. */
export interface StepEstimate {
	task: "tailor" | "claims-check";
	provider: string;
	/** The plan's vendor when the model is a subscription: calls are counted, not priced. */
	plan: SubscriptionVendor | null;
	/** Past preparations this rests on. */
	samples: number;
	micros: Spread;
	calls: Spread;
}

/** The newest preparations an estimate looks at, so old prices and prompts fade out. */
const ESTIMATE_SAMPLES = 50;

/**
 * The median is not rounded: steps are summed and multiplied by the jobs before the figure is
 * rounded for display (1.5 + 1.5 calls is 3, not 4).
 */
function spread(values: number[]): Spread {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 1
			? (sorted[mid] ?? 0)
			: ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
	return { median, low: sorted[0] ?? 0, high: sorted.at(-1) ?? 0 };
}

/**
 * One step's recorded cost per past preparation, on `provider` only. A preparation is an
 * application's calls of that step up to the moment it first reached review: the drafts, the
 * automatic redraft and their checks, not a later Check again or chat edit (decisions.md,
 * 2026-11-03). One that ran any of those calls on another model is left out: its cost says
 * nothing about this one.
 */
async function step(
	db: Database,
	userId: string,
	task: StepEstimate["task"],
	provider: string,
): Promise<StepEstimate | null> {
	const rows = (await db.all(sql`
		select sum(u.cost_micros) as micros, sum(u.model_calls) as calls
		from llm_usage u
		join (
			select application_id, min(created_at) as at
			from application_transitions
			where user_id = ${userId} and to_state = 'ready_for_review'
			group by application_id
		) r on r.application_id = u.application_id
		where u.user_id = ${userId} and u.task = ${task} and u.status = 'settled'
			and u.created_at <= r.at
		group by u.application_id
		having sum(case when u.provider = ${provider} then 0 else 1 end) = 0
		order by max(r.at) desc
		limit ${ESTIMATE_SAMPLES}
	`)) as { micros: number; calls: number }[];
	if (rows.length === 0) return null;
	return {
		task,
		provider,
		plan: subscriptionVendor(provider),
		samples: rows.length,
		micros: spread(rows.map((r) => Number(r.micros ?? 0))),
		calls: spread(rows.map((r) => Number(r.calls ?? 0))),
	};
}

/**
 * What Prepare is likely to cost with the models it would use now, from what past preparations
 * cost: drafting and checking, each on its own model. Null when either has no history on its
 * current model: no estimate rather than a made-up one.
 */
export async function prepareEstimate(
	db: Database,
	userId: string,
	models: PrepareModels,
): Promise<{ steps: StepEstimate[] } | null> {
	const tailor = await step(db, userId, "tailor", models.tailoring);
	if (!tailor) return null;
	const claims = await step(db, userId, "claims-check", models.claims);
	if (!claims) return null;
	return { steps: [tailor, claims] };
}

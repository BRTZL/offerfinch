import { protectedProcedure } from "./procedure";
import { worker } from "./shared";

export const spendingBreakdownRouter = {
	/**
	 * This calendar month's (UTC) model calls by model and by step: priced API calls with
	 * their cost (settled, or the estimate while running), subscription calls counted.
	 */
	get: protectedProcedure.handler(({ context }) => {
		const start = new Date();
		start.setUTCDate(1);
		start.setUTCHours(0, 0, 0, 0);
		const rows = worker()
			.db.$client.prepare(
				`select coalesce(model, provider) as model, task, billing,
					  count(*) as calls,
					  sum(case when status = 'settled' then cost_micros else estimate_micros end) as micros
					from llm_usage where user_id = ? and created_at >= ?
					group by coalesce(model, provider), task, billing`,
			)
			.all(context.session.user.id, start.getTime()) as {
			model: string;
			task: string;
			billing: string;
			calls: number;
			micros: number;
		}[];
		const sum = (key: "model" | "task") => {
			const by = new Map<
				string,
				{ calls: number; micros: number; subscription: number }
			>();
			for (const r of rows) {
				const e = by.get(r[key]) ?? { calls: 0, micros: 0, subscription: 0 };
				e.calls += r.calls;
				if (r.billing === "subscription") e.subscription += r.calls;
				else e.micros += r.micros ?? 0;
				by.set(r[key], e);
			}
			return [...by.entries()]
				.map(([name, v]) => ({ name, ...v }))
				.sort((a, b) => b.micros - a.micros || b.calls - a.calls);
		};
		return { byModel: sum("model"), byStep: sum("task") };
	}),
};

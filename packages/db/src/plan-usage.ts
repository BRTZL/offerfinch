import {
	type PlanUsageState,
	type PlanUsageStore,
	type PlanVendor,
	planUsageFromJson,
	planUsageToJson,
} from "@offerfinch/core/scoring/plan-usage";
import { and, eq } from "drizzle-orm";

import type { Database } from "./client";
import { planUsage } from "./schema/pipeline";

/** SQLite side of plan usage: one row per user and vendor, the state as JSON. */
export class DrizzlePlanUsageStore implements PlanUsageStore {
	constructor(
		private readonly db: Database,
		private readonly now: () => Date = () => new Date(),
	) {}

	async load(
		userId: string,
		vendor: PlanVendor,
	): Promise<PlanUsageState | null> {
		const [row] = await this.db
			.select({ state: planUsage.state })
			.from(planUsage)
			.where(and(eq(planUsage.userId, userId), eq(planUsage.vendor, vendor)));
		return row ? planUsageFromJson(vendor, row.state) : null;
	}

	async save(userId: string, state: PlanUsageState): Promise<void> {
		const json = planUsageToJson(state);
		await this.db
			.insert(planUsage)
			.values({ userId, vendor: state.vendor, state: json })
			.onConflictDoUpdate({
				target: [planUsage.userId, planUsage.vendor],
				set: { state: json, updatedAt: this.now() },
			});
	}
}

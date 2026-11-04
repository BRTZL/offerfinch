import {
	type PlanUsageState,
	type PlanUsageTracker,
	type PlanVendor,
	type PlanWindowView,
	planWindowStart,
	planWindowView,
} from "@offerfinch/core/scoring/plan-usage";
import type { DrizzleSpendStore } from "@offerfinch/db";

/** One plan as Settings › Models shows it: its windows, and OfferFinch's calls in each. */
export interface PlanUsageView {
	vendor: PlanVendor;
	checkedAt: string | null;
	account: PlanUsageState["account"];
	windows: (PlanWindowView & {
		/** OfferFinch's prompts in this window, and their tokens, from the ledger. */
		calls: { calls: number; inputTokens: number; outputTokens: number } | null;
	})[];
}

/** Both plans' usage, as read so far; nothing is started here. */
export async function planUsageViews(
	tracker: PlanUsageTracker,
	store: DrizzleSpendStore,
	userId: string,
	now: Date = new Date(),
): Promise<Record<PlanVendor, PlanUsageView>> {
	const view = async (vendor: PlanVendor): Promise<PlanUsageView> => {
		const state = tracker.state(vendor);
		const windows = await Promise.all(
			state.windows.map(async (window) => {
				const since = planWindowStart(window);
				const shown = planWindowView(window, now);
				return {
					...shown,
					calls:
						since && !shown.ended
							? await store.subscriptionCallsSince(userId, vendor, since)
							: null,
				};
			}),
		);
		return {
			vendor,
			checkedAt: state.checkedAt?.toISOString() ?? null,
			account: state.account,
			windows,
		};
	};
	return { anthropic: await view("anthropic"), openai: await view("openai") };
}

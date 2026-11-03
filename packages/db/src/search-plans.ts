import { searchFromLinkedInUrl } from "@offerfinch/core/search/adapt";
import {
	EMPTY_PLAN,
	type GeneratedPlan,
	MAX_USER_SEARCHES,
	normalizeSearch,
	PLAN_WHERE,
	type PlanSearch,
	type SearchPlanStore,
	type StoredPlan,
	searchKey,
} from "@offerfinch/core/search/plan";
import { and, eq } from "drizzle-orm";

import type { Database } from "./client";
import { DrizzlePipelineRepository } from "./repository";
import {
	linkedinSettings,
	searchPlans,
	sourceProviders,
} from "./schema/pipeline";

/** A stored search, read back defensively: anything malformed is left out. */
function readSearch(value: unknown): PlanSearch | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	if (typeof v.keywords !== "string" || !v.keywords.trim()) return null;
	if (!(PLAN_WHERE as readonly unknown[]).includes(v.where)) return null;
	const out: PlanSearch = {
		keywords: v.keywords,
		where: v.where as PlanSearch["where"],
	};
	if (typeof v.place === "string" && v.place) out.place = v.place;
	if (typeof v.seniority === "string" && v.seniority)
		out.seniority = v.seniority;
	return out;
}

const readSearches = (values: unknown[]) =>
	values.flatMap((v) => readSearch(v) ?? []);

/** The shared search plan in SQLite, one row per user. */
export class SqliteSearchPlanStore implements SearchPlanStore {
	constructor(private readonly db: Database) {}

	async plan(userId: string): Promise<StoredPlan> {
		const [row] = await this.db
			.select()
			.from(searchPlans)
			.where(eq(searchPlans.userId, userId));
		if (!row) return EMPTY_PLAN;
		return {
			ai: readSearches(row.ai),
			user: readSearches(row.user),
			basis: row.basis === "ai" || row.basis === "rules" ? row.basis : null,
			generatedAt: row.generatedAt?.toISOString() ?? null,
		};
	}

	async saveGenerated(userId: string, plan: GeneratedPlan): Promise<void> {
		const value = {
			ai: plan.ai,
			basis: plan.basis,
			generatedAt: plan.generatedAt ? new Date(plan.generatedAt) : null,
			updatedAt: new Date(),
		};
		await this.db
			.insert(searchPlans)
			.values({ userId, user: [], ...value })
			.onConflictDoUpdate({ target: searchPlans.userId, set: value });
	}

	/** Saves the user's own searches only (the generated part is the model's). */
	async saveUser(userId: string, user: PlanSearch[]): Promise<void> {
		const value = { user, updatedAt: new Date() };
		await this.db
			.insert(searchPlans)
			.values({ userId, ai: [], basis: null, generatedAt: null, ...value })
			.onConflictDoUpdate({ target: searchPlans.userId, set: value });
	}

	async savePlan(userId: string, plan: StoredPlan): Promise<void> {
		const value = {
			ai: plan.ai,
			user: plan.user,
			basis: plan.basis,
			generatedAt: plan.generatedAt ? new Date(plan.generatedAt) : null,
			updatedAt: new Date(),
		};
		await this.db
			.insert(searchPlans)
			.values({ userId, ...value })
			.onConflictDoUpdate({ target: searchPlans.userId, set: value });
	}

	/**
	 * Adds one of the user's own searches, cleaned (plain words; a place the filter keeps).
	 * Returns false when it is not usable or already there.
	 */
	async addUserSearch(userId: string, input: PlanSearch): Promise<boolean> {
		const settings = await new DrizzlePipelineRepository(
			this.db,
		).getFilterSettings(userId);
		const search = normalizeSearch(input, settings, { strict: false });
		if (!search) return false;
		const plan = await this.plan(userId);
		if (plan.user.some((s) => searchKey(s) === searchKey(search))) return false;
		if (plan.user.length >= MAX_USER_SEARCHES)
			throw new Error(
				`At most ${MAX_USER_SEARCHES} searches of your own: remove one first`,
			);
		await this.saveUser(userId, [...plan.user, search]);
		return true;
	}

	async removeUserSearch(userId: string, key: string): Promise<boolean> {
		const plan = await this.plan(userId);
		const user = plan.user.filter((s) => searchKey(s) !== key);
		if (user.length === plan.user.length) return false;
		await this.saveUser(userId, user);
		return true;
	}
}

export interface RetiredSourceSettings {
	/** LinkedIn's custom searches moved into the plan as the user's own. */
	linkedinSearches: number;
	/** Web search's own searches moved into the plan. */
	webSearches: number;
	/** Saved LinkedIn URLs that are not searches (a collection): kept in the notice, not moved. */
	notMoved: string[];
	/** Settings dropped without a place to go (LinkedIn's page cap and gaps, the model's queries). */
	dropped: string[];
}

/** "design engineer remote Europe" -> keywords "design engineer Europe", remote worldwide. */
function searchFromWords(query: string): PlanSearch | null {
	const remote = /\bremote\b/i.test(query);
	const keywords = query
		.replace(/\bremote\b/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!keywords) return null;
	return remote
		? { keywords, where: "remote-worldwide" }
		: { keywords, where: "onsite" };
}

/**
 * Per-source settings of earlier versions (2026-11-03: sources have none). LinkedIn's custom
 * searches and web search's own searches become the user's searches in the shared plan; nothing
 * the user wrote is dropped silently: what can't move is returned for a notice. LinkedIn's page
 * cap and gaps and web search's model queries are dropped (the pace is fixed; the plan replaces
 * the queries). Stops stay: they are state, not settings. Safe to run at every start.
 */
export async function retirePerSourceSettings(
	db: Database,
): Promise<RetiredSourceSettings> {
	const out: RetiredSourceSettings = {
		linkedinSearches: 0,
		webSearches: 0,
		notMoved: [],
		dropped: [],
	};
	const plans = new SqliteSearchPlanStore(db);
	const repo = new DrizzlePipelineRepository(db);
	const add = async (userId: string, searches: PlanSearch[]) => {
		const settings = await repo.getFilterSettings(userId);
		const plan = await plans.plan(userId);
		const keys = new Set(plan.user.map(searchKey));
		const user = [...plan.user];
		let added = 0;
		for (const raw of searches) {
			const s = normalizeSearch(raw, settings, { strict: false });
			if (!s || keys.has(searchKey(s))) continue;
			keys.add(searchKey(s));
			user.push(s);
			added++;
		}
		if (added) await plans.saveUser(userId, user);
		return added;
	};

	const linkedin = await db.select().from(linkedinSettings);
	for (const row of linkedin) {
		const urls = row.searchUrls ?? [];
		if (urls.length === 0) continue;
		const { livesIn } = await repo.getFilterSettings(row.userId);
		const moved: PlanSearch[] = [];
		for (const url of urls) {
			const search = searchFromLinkedInUrl(url, livesIn);
			if (search) moved.push(search);
			else out.notMoved.push(url);
		}
		out.linkedinSearches += await add(row.userId, moved);
		await db
			.update(linkedinSettings)
			.set({ searchUrls: [], updatedAt: new Date() })
			.where(eq(linkedinSettings.userId, row.userId));
	}
	// A cap or gaps the user set: the pace is fixed now. Reset, so this is said once.
	for (const row of linkedin) {
		if (
			row.dailyPageCap === 15 &&
			row.minGapSeconds === 20 &&
			row.maxGapSeconds === 60
		)
			continue;
		if (!out.dropped.length) out.dropped.push("LinkedIn's page cap and gaps");
		await db
			.update(linkedinSettings)
			.set({ dailyPageCap: 15, minGapSeconds: 20, maxGapSeconds: 60 })
			.where(eq(linkedinSettings.userId, row.userId));
	}

	const web = await db
		.select()
		.from(sourceProviders)
		.where(eq(sourceProviders.provider, "web-search"));
	for (const row of web) {
		const config = (row.config ?? {}) as Record<string, unknown>;
		if (!("queries" in config)) continue;
		const queries = (config.queries ?? {}) as { user?: unknown };
		const own = Array.isArray(queries.user)
			? queries.user.filter((q): q is string => typeof q === "string")
			: [];
		out.webSearches += await add(
			row.userId,
			own.flatMap((q) => searchFromWords(q) ?? []),
		);
		const { queries: _retired, ...rest } = config;
		await db
			.update(sourceProviders)
			.set({ config: rest, updatedAt: new Date() })
			.where(
				and(
					eq(sourceProviders.userId, row.userId),
					eq(sourceProviders.provider, row.provider),
				),
			);
	}
	return out;
}

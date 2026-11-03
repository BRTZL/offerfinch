import { filterSettingsSchema } from "@offerfinch/core/filter/settings";
import type { PipelineDeps } from "@offerfinch/core/pipeline/ports";
import { meteredFor } from "@offerfinch/core/scoring/metered";
import {
	describeSearch,
	PLAN_WHERE,
	plannedSearches,
	refreshSearchPlan,
	rulesPlan,
	searchKey,
} from "@offerfinch/core/search/plan";
import {
	type Database,
	DrizzlePipelineRepository,
	ensureLocationDefaults,
	type PendingEvent,
	type RefilterResult,
	type RetiredSourceSettings,
	refilterApplications,
	SqliteSearchPlanStore,
	saveFilterSettings,
} from "@offerfinch/db";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { protectedProcedure } from "./routers/procedure";

/**
 * Settings › Job search in the worker. Reading the settings fills "I live in", citizenship and
 * right to work from the profile's location the first time; saving them runs the filter again
 * over open matches (no model call), so a match the new settings rule out leaves Matches at once.
 */

export interface JobSearchWorker {
	db: Database;
	starter: { sendEvent(event: PendingEvent): Promise<unknown> };
	log(level: "info" | "warn" | "error", message: string, data?: unknown): void;
	/** The drafting model and spending, for Regenerate. */
	deps: Pick<PipelineDeps, "llm" | "tailorLlm" | "spend">;
	settings: {
		get(key: "movedSearches"): Promise<string | null>;
		set(key: "movedSearches", value: string | null): Promise<void>;
	};
}

/** What moving earlier versions' per-source settings did, in words; null when nothing. */
export function movedSearchesNote(moved: RetiredSourceSettings): string | null {
	const parts: string[] = [];
	const n = moved.linkedinSearches + moved.webSearches;
	if (n > 0)
		parts.push(
			`${n} search${n === 1 ? "" : "es"} you saved for ${[
				moved.linkedinSearches ? "LinkedIn" : "",
				moved.webSearches ? "web search" : "",
			]
				.filter(Boolean)
				.join(
					" and ",
				)} ${n === 1 ? "is" : "are"} now among your own searches below, used by every source.`,
		);
	if (moved.notMoved.length)
		parts.push(
			`Not moved (not a search): ${moved.notMoved.join(", ")}. LinkedIn's Top picks are read in every LinkedIn read.`,
		);
	if (moved.dropped.length)
		parts.push(
			`${moved.dropped.join(", ")} no longer apply: LinkedIn reads at most 10 pages a day, 20 to 60 seconds apart.`,
		);
	return parts.length ? parts.join(" ") : null;
}

const searchInput = z.object({
	keywords: z.string().trim().min(2).max(120),
	where: z.enum(PLAN_WHERE),
	place: z.string().trim().max(80).optional(),
});

/** The plan as Job search shows it: each search in words, who wrote it, and its key. */
async function planView(w: JobSearchWorker, userId: string) {
	const repo = new DrizzlePipelineRepository(w.db);
	const stored = await new SqliteSearchPlanStore(w.db).plan(userId);
	const settings = await repo.getFilterSettings(userId);
	const rules = rulesPlan(settings, await repo.getProfile(userId));
	return {
		searches: plannedSearches(stored, rules).map((s) => ({
			key: searchKey(s),
			label: describeSearch(
				s.where === "remote-worldwide" || s.place || !settings.livesIn
					? s
					: { ...s, place: settings.livesIn },
			),
			by: s.by,
		})),
		generatedAt: stored.generatedAt,
		basis: stored.ai.length ? stored.basis : ("rules" as const),
		moved: await w.settings.get("movedSearches"),
	};
}

/** The pass running or queued last, per worker: passes run one after another, never together. */
const queues = new WeakMap<object, Promise<unknown>>();

/**
 * Re-filters, wakes the runs of the matches it moved so they end, and logs the counts. Passes
 * are serialized per worker; a save while one runs supersedes it (it stops at its next write,
 * see `refilterApplications`), and the pass this call queues decides with the new settings.
 */
export function refilterAndWake(
	w: JobSearchWorker,
	userId: string,
	why: string,
): Promise<RefilterResult> {
	const previous = queues.get(w) ?? Promise.resolve();
	const pass = previous
		.catch(() => {})
		.then(async () => {
			const result = await refilterApplications(w.db, userId);
			for (const event of result.events) await w.starter.sendEvent(event);
			w.log("info", "job search re-filtered", {
				why,
				checked: result.checked,
				rejected: result.rejected,
				restored: result.restored,
				reranked: result.reranked,
				superseded: result.superseded,
			});
			return result;
		});
	queues.set(w, pass);
	return pass;
}

/**
 * Bumped when the filter or ranking changes in a way the stored matches should see. At startup a
 * lower stored version fills the location fields from the profile, then re-filters once.
 */
const JOB_SEARCH_VERSION = 1;

export async function upgradeJobSearch(
	w: JobSearchWorker,
	userId: string,
	version: { get(): Promise<number>; set(value: number): Promise<void> },
): Promise<RefilterResult | null> {
	if ((await version.get()) >= JOB_SEARCH_VERSION) return null;
	const filled = await ensureLocationDefaults(w.db, userId);
	if (filled.changed)
		w.log("info", "job search filled from the profile", {
			livesIn: filled.settings.livesIn,
		});
	const result = await refilterAndWake(w, userId, "update");
	await version.set(JOB_SEARCH_VERSION);
	return result;
}

export function jobSearchSettingsRouter(worker: () => JobSearchWorker) {
	return {
		/** "What OfferFinch searches for": the shared plan every source uses. */
		plan: protectedProcedure.handler(({ context }) =>
			planView(worker(), context.session.user.id),
		),
		/** One of the user's own searches, kept and always used, first. */
		addSearch: protectedProcedure
			.input(searchInput)
			.handler(async ({ context, input }) => {
				const w = worker();
				const userId = context.session.user.id;
				let added: boolean;
				try {
					added = await new SqliteSearchPlanStore(w.db).addUserSearch(
						userId,
						input,
					);
				} catch (error) {
					throw new ORPCError("BAD_REQUEST", {
						message: error instanceof Error ? error.message : String(error),
					});
				}
				if (!added)
					throw new ORPCError("BAD_REQUEST", {
						message: "That search is already there, or has no plain words",
					});
				return planView(w, userId);
			}),
		/** Takes out one of the user's own searches (the model's are written again daily). */
		removeSearch: protectedProcedure
			.input(z.object({ key: z.string().max(400) }))
			.handler(async ({ context, input }) => {
				const w = worker();
				const userId = context.session.user.id;
				await new SqliteSearchPlanStore(w.db).removeUserSearch(
					userId,
					input.key,
				);
				return planView(w, userId);
			}),
		/** The model writes today's plan again now: one call, metered like any. */
		regenerate: protectedProcedure.handler(async ({ context }) => {
			const w = worker();
			const userId = context.session.user.id;
			const repo = new DrizzlePipelineRepository(w.db);
			const result = await refreshSearchPlan({
				llm: meteredFor(
					w.deps.tailorLlm ?? w.deps.llm,
					w.deps.spend,
					userId,
					null,
				),
				store: new SqliteSearchPlanStore(w.db),
				userId,
				profile: await repo.getProfile(userId),
				settings: await repo.getFilterSettings(userId),
				force: true,
			});
			if (result.note)
				throw new ORPCError("CONFLICT", { message: result.note });
			return planView(w, userId);
		}),
		/** The note about moved searches has been read. */
		dismissMoved: protectedProcedure.handler(async () => {
			await worker().settings.set("movedSearches", null);
			return { dismissed: true };
		}),
		get: protectedProcedure.handler(async ({ context }) => {
			const w = worker();
			return (await ensureLocationDefaults(w.db, context.session.user.id))
				.settings;
		}),
		update: protectedProcedure
			.input(filterSettingsSchema.partial())
			.handler(async ({ context, input }) => {
				const w = worker();
				const userId = context.session.user.id;
				const current = await new DrizzlePipelineRepository(
					w.db,
				).getFilterSettings(userId);
				const next = filterSettingsSchema.parse({ ...current, ...input });
				await saveFilterSettings(w.db, userId, next);
				// Saved either way; a failed re-filter is logged and runs again at the next save.
				await refilterAndWake(w, userId, "settings").catch((error) =>
					w.log("warn", "job search not re-filtered", String(error)),
				);
				return next;
			}),
	};
}

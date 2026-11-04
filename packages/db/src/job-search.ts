import { createHash } from "node:crypto";
import {
	countryFromLocation,
	profileLocation,
	withLocationDefaults,
} from "@offerfinch/core/filter/home";
import {
	evaluateHardRequirements,
	type FilterResult,
} from "@offerfinch/core/filter/rules";
import type { FilterSettings } from "@offerfinch/core/filter/settings";
import { rankScored } from "@offerfinch/core/scoring/rank";
import {
	APPLICATION_UPDATED_EVENT,
	applicationInstanceId,
} from "@offerfinch/core/workflow/types";
import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";

import type { Database } from "./client";
import type { PendingEvent } from "./dashboard";
import {
	DrizzlePipelineRepository,
	saveFilterSettings,
	type Tx,
} from "./repository";
import {
	applications,
	applicationTransitions,
	companies,
	filterSettings,
	jobs,
	workflowEvents,
} from "./schema/pipeline";

/**
 * Fills "I live in", citizenship and right to work from the profile's About location ("Izmir,
 * Turkey (GMT+3)" -> Turkey) the first time it can. Kept fields stay; after one fill nothing is
 * filled again, so a field the user clears stays clear.
 */
export async function ensureLocationDefaults(
	db: Database,
	userId: string,
): Promise<{ changed: boolean; settings: FilterSettings }> {
	const repo = new DrizzlePipelineRepository(db);
	const settings = await repo.getFilterSettings(userId);
	if (settings.locationPrefilled) return { changed: false, settings };
	const profile = await repo.getProfile(userId);
	const next = withLocationDefaults(
		settings,
		countryFromLocation(profileLocation(profile)),
	);
	if (next === settings) return { changed: false, settings };
	await saveFilterSettings(db, userId, next);
	return { changed: true, settings: next };
}

/**
 * What a pass checks again: jobs still being checked, matches (acted on or not), and drafts
 * waiting for answers or review. Never one being drafted right now (`preparing`), approved,
 * being submitted or ended.
 */
const REFILTERED = [
	"found",
	"scored",
	"needs_answers",
	"ready_for_review",
] as const;
type RefilterFrom = (typeof REFILTERED)[number];

interface RefilterDecision {
	applicationId: string;
	title: string;
	company: string;
	from: RefilterFrom | "rejected_by_filter";
	decision: FilterResult["decision"];
	summary: string;
	/** The location rule's verdict, for counts by reason. */
	locationVerdict?: FilterResult["locationVerdict"];
	/** The rules that rejected it ("location", "citizenship"…). */
	rejectedBy: string[];
}

export interface RefilterResult {
	/** Applications looked at: found jobs, matches and drafts waiting on the user. */
	checked: number;
	/** Moved to rejected_by_filter. */
	rejected: number;
	/**
	 * Jobs an earlier pass set aside with older settings that the current ones keep: back to
	 * Matches (scored) or to be checked (found), their runs started again.
	 */
	restored: number;
	/** Open matches whose rank changed. */
	reranked: number;
	/** The settings changed during the pass, which stopped; the newer pass decides. */
	superseded: boolean;
	decisions: RefilterDecision[];
	/**
	 * One per moved application, for the caller to send: it ends the match's waiting run, or
	 * starts a restored job's run again.
	 */
	events: PendingEvent[];
}

async function addEvent(
	tx: Tx,
	userId: string,
	applicationId: string,
	jobId: string,
	key: string,
): Promise<PendingEvent> {
	const [row] = await tx
		.insert(workflowEvents)
		.values({
			userId,
			applicationId,
			type: APPLICATION_UPDATED_EVENT,
			idempotencyKey: key,
			payload: { action: "refiltered" },
		})
		.onConflictDoNothing()
		.returning({ id: workflowEvents.id });
	const id =
		row?.id ??
		(
			await tx
				.select({ id: workflowEvents.id })
				.from(workflowEvents)
				.where(
					and(
						eq(workflowEvents.userId, userId),
						eq(workflowEvents.idempotencyKey, key),
					),
				)
		)[0]?.id;
	if (!id) throw new Error("event insert returned nothing");
	return { userId, eventId: id, instanceId: applicationInstanceId(jobId) };
}

/** What a stored settings row reads as, to tell one revision from the next. */
async function settingsRevision(
	t: Tx | Database,
	userId: string,
): Promise<string> {
	const [row] = await t
		.select({ settings: filterSettings.settings })
		.from(filterSettings)
		.where(eq(filterSettings.userId, userId));
	return JSON.stringify(row?.settings ?? {});
}

/** The stamp of the pass that set a job aside, as stored in its filter result. */
const refilteredWith = sql<
	string | null
>`json_extract(${applications.filterResult}, '$.refilteredWith')`;

/** A short stamp of one settings revision, kept on what a pass set aside. */
function stampOf(revision: string): string {
	return createHash("sha256").update(revision).digest("hex").slice(0, 16);
}

/** The settings changed while a pass ran: a newer pass decides; this one writes nothing more. */
class Superseded extends Error {}

/**
 * Every condition that makes an application eligible, repeated in each write: one the user
 * chose (Show in Matches, Prepare anyway) or that moved on in between is left as it is,
 * whatever was read at selection.
 */
function eligible(applicationId: string, userId: string, from: RefilterFrom) {
	return and(
		eq(applications.id, applicationId),
		eq(applications.userId, userId),
		eq(applications.state, from),
		isNull(applications.chosenAnywayAt),
	);
}

/**
 * Runs the job filter again (deterministic, no model call) over jobs still being checked
 * (`found`), every match (`scored`, Prepare pressed or not) and drafts waiting for answers or
 * review. Those it now rejects move to `rejected_by_filter` with the reason, hidden everywhere;
 * their runs are woken and end. The others keep their place with the new filter result, and
 * matches are ranked again. Never touched: jobs the user added or chose anyway
 * (`chosen_anyway_at`), dismissed jobs, a draft being written, and anything approved or later.
 *
 * Races: each write is one transaction that checks, at write time, every eligibility condition
 * and that the settings are still the ones this pass read. A save in between supersedes the
 * pass: it stops (`superseded`), and the pass the save starts decides with the new settings.
 */
export async function refilterApplications(
	db: Database,
	userId: string,
	options: { now?: Date } = {},
): Promise<RefilterResult> {
	const repo = new DrizzlePipelineRepository(db);
	const revision = await settingsRevision(db, userId);
	const stamp = stampOf(revision);
	const settings = await repo.getFilterSettings(userId);
	const profile = await repo.getProfile(userId);
	const dismissals = await repo.dismissalSignals(userId);
	const rows = await db
		.select({
			app: applications,
			job: jobs,
			company: companies.name,
		})
		.from(applications)
		.innerJoin(jobs, eq(jobs.id, applications.jobId))
		.innerJoin(companies, eq(companies.id, jobs.companyId))
		.where(
			and(
				eq(applications.userId, userId),
				or(
					inArray(applications.state, [...REFILTERED]),
					// Set aside by a pass with older settings (never one set aside at its first
					// check, nor one the user showed in Matches: chosen_anyway_at below).
					and(
						eq(applications.state, "rejected_by_filter"),
						isNotNull(refilteredWith),
						ne(refilteredWith, stamp),
					),
				),
				isNull(applications.chosenAnywayAt),
				ne(jobs.source, "manual"),
			),
		);
	const result: RefilterResult = {
		checked: rows.length,
		rejected: 0,
		restored: 0,
		reranked: 0,
		superseded: false,
		decisions: [],
		events: [],
	};
	/** One guarded write: nothing when the settings moved on (the pass stops). */
	const write = <T>(fn: (tx: Tx) => Promise<T>) =>
		db.transaction(async (tx) => {
			if ((await settingsRevision(tx, userId)) !== revision)
				throw new Superseded();
			return fn(tx);
		});
	const rankOf = (
		app: (typeof rows)[number]["app"],
		job: (typeof rows)[number]["job"],
		filter: FilterResult,
	) =>
		app.score === null
			? null
			: rankScored({
					score: app.score,
					job: {
						title: job.title,
						descriptionText: job.descriptionText,
						companyId: job.companyId,
					},
					filter,
					profile,
					dismissals,
					now: options.now,
				});

	/**
	 * A job an older pass set aside: back where it was when the current settings keep it (with
	 * an event that starts its run again), else stamped with this revision.
	 */
	const reconsider = async (
		app: (typeof rows)[number]["app"],
		job: (typeof rows)[number]["job"],
		company: string,
	) => {
		const filter = evaluateHardRequirements(
			{
				title: job.title,
				locations: job.locations,
				workplaceType: job.workplaceType,
				descriptionText: job.descriptionText,
			},
			settings,
		);
		result.decisions.push({
			applicationId: app.id,
			title: job.title,
			company,
			from: "rejected_by_filter",
			decision: filter.decision,
			summary: filter.summary,
			locationVerdict: filter.locationVerdict,
			rejectedBy: filter.reasons
				.filter((r) => r.outcome === "reject")
				.map((r) => r.rule),
		});
		const setAsideBy = app.filterResult?.refilteredWith ?? null;
		const stillSetAside = and(
			eq(applications.id, app.id),
			eq(applications.userId, userId),
			eq(applications.state, "rejected_by_filter"),
			isNull(applications.chosenAnywayAt),
			setAsideBy === null
				? isNull(refilteredWith)
				: eq(refilteredWith, setAsideBy),
		);
		if (filter.decision === "reject") {
			await write((tx) =>
				tx
					.update(applications)
					.set({ filterResult: { ...filter, refilteredWith: stamp } })
					.where(stillSetAside),
			);
			return;
		}
		// Scored before it was set aside: back to Matches; never scored: checked again. A draft
		// hidden from review or answers comes back as a plain match, Prepare not pressed, so
		// nothing is drafted again until the user asks.
		const back = app.score !== null ? "scored" : "found";
		const rank = back === "scored" ? rankOf(app, job, filter) : null;
		const event = await write(async (tx) => {
			const moved = await tx
				.update(applications)
				.set({
					state: back,
					stateChangedAt: new Date(),
					prepareRequestedAt: null,
					filterDecision: filter.decision,
					filterResult: filter,
					flags: filter.flags,
					...(rank ? { rank: rank.rank, rankPenalties: rank.penalties } : {}),
				})
				.where(stillSetAside)
				.returning({ id: applications.id });
			if (moved.length === 0) return null;
			await tx.insert(applicationTransitions).values({
				userId,
				applicationId: app.id,
				fromState: "rejected_by_filter",
				toState: back,
				reason: "Fits your job search again",
				actor: "system",
			});
			return addEvent(
				tx,
				userId,
				app.id,
				app.jobId,
				`refilter-restore-${app.id}-${app.stateChangedAt.getTime()}`,
			);
		});
		if (event) {
			result.restored++;
			result.events.push(event);
		}
	};

	try {
		for (const { app, job, company } of rows) {
			if (app.state === "rejected_by_filter") {
				await reconsider(app, job, company);
				continue;
			}
			const from = app.state as RefilterFrom;
			const filter = evaluateHardRequirements(
				{
					title: job.title,
					locations: job.locations,
					workplaceType: job.workplaceType,
					descriptionText: job.descriptionText,
				},
				settings,
			);
			result.decisions.push({
				applicationId: app.id,
				title: job.title,
				company,
				from,
				decision: filter.decision,
				summary: filter.summary,
				locationVerdict: filter.locationVerdict,
				rejectedBy: filter.reasons
					.filter((r) => r.outcome === "reject")
					.map((r) => r.rule),
			});
			if (filter.decision === "reject") {
				const event = await write(async (tx) => {
					const moved = await tx
						.update(applications)
						.set({
							state: "rejected_by_filter",
							stateChangedAt: new Date(),
							filterDecision: filter.decision,
							filterResult: { ...filter, refilteredWith: stamp },
							flags: [],
						})
						.where(eligible(app.id, userId, from))
						.returning({ id: applications.id });
					if (moved.length === 0) return null;
					await tx.insert(applicationTransitions).values({
						userId,
						applicationId: app.id,
						fromState: from,
						toState: "rejected_by_filter",
						reason: filter.summary.slice(0, 2000),
						actor: "system",
					});
					return addEvent(
						tx,
						userId,
						app.id,
						app.jobId,
						`refilter-${app.id}-${app.stateChangedAt.getTime()}`,
					);
				});
				if (event) {
					result.rejected++;
					result.events.push(event);
				}
				continue;
			}
			// Still kept: store the new reading; an open match is ranked again with it.
			// A found job not filtered yet is left to its run, which filters it next.
			const filterChanged =
				(from === "scored" || app.filterResult !== null) &&
				JSON.stringify(app.filterResult) !== JSON.stringify(filter);
			const rank =
				from === "scored" && app.score !== null
					? rankScored({
							score: app.score,
							job: {
								title: job.title,
								descriptionText: job.descriptionText,
								companyId: job.companyId,
							},
							filter,
							profile,
							dismissals,
							now: options.now,
						})
					: null;
			const rankChanged =
				rank !== null &&
				(rank.rank !== app.rank ||
					JSON.stringify(rank.penalties) !==
						JSON.stringify(app.rankPenalties ?? []));
			if (!filterChanged && !rankChanged) continue;
			const updated = await write((tx) =>
				tx
					.update(applications)
					.set({
						...(filterChanged
							? {
									filterDecision: filter.decision,
									filterResult: filter,
									flags: filter.flags,
								}
							: {}),
						...(rank && rankChanged
							? { rank: rank.rank, rankPenalties: rank.penalties }
							: {}),
					})
					.where(eligible(app.id, userId, from))
					.returning({ id: applications.id }),
			);
			if (rankChanged && updated.length > 0) result.reranked++;
		}
	} catch (error) {
		if (!(error instanceof Superseded)) throw error;
		result.superseded = true;
	}
	return result;
}

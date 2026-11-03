import {
	type DismissReason,
	ENDED_COMPANY_HIDDEN,
	ENDED_NOT_INTERESTED,
} from "@offerfinch/core/domain/dismissal";
import {
	type ApplicationState,
	canTransition,
} from "@offerfinch/core/domain/states";
import {
	APPLICATION_UPDATED_EVENT,
	applicationInstanceId,
} from "@offerfinch/core/workflow/types";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

import type { Database } from "./client";
import type { PendingEvent } from "./dashboard";
import type { Tx } from "./repository";
import { dismissals, hiddenCompanies } from "./schema/dismissals";
import {
	applications,
	applicationTransitions,
	companies,
	jobs,
	workflowEvents,
} from "./schema/pipeline";

/** The history line of Show in Matches; a repeat call finds it and changes nothing. */
const SHOWN_IN_MATCHES_REASON = "Shown in Matches by you";

/** Why the application history says a hidden company's job was dismissed. */
export const COMPANY_HIDDEN_REASON = "From a company you hid";

/**
 * Company rows that are the same employer as `companyId`: itself, and rows with the same
 * normalized name. A name that normalizes to nothing (another script) matches only itself.
 */
function sameCompany(companyId: string) {
	return sql`(${companies.id} = ${companyId} or (${companies.nameKey} <> '' and ${companies.nameKey} = (select name_key from ${companies} where id = ${companyId})))`;
}

/**
 * Whether a company is hidden: hidden itself, or another company row with the same normalized
 * name is (the same employer found through another source).
 */
export async function companyHidden(
	t: Tx | Database,
	userId: string,
	companyId: string,
): Promise<boolean> {
	const rows = await t.all<{ one: number }>(sql`
		select 1 as one from ${hiddenCompanies} hc
		join ${companies} h on h.id = hc.company_id
		join ${companies} c on c.user_id = hc.user_id
			and (c.id = h.id or (h.name_key <> '' and c.name_key = h.name_key))
		where hc.user_id = ${userId} and c.id = ${companyId}
		limit 1`);
	return rows.length > 0;
}

/**
 * Applications the app may dismiss on its own for a hidden company: a job still being checked,
 * or a match nobody acted on. Never a job the user added or chose, one they asked to prepare,
 * one scored below the minimum (it keeps its reason), or anything past a match.
 */
function autoDismissable() {
	return and(
		or(
			eq(applications.state, "found"),
			and(
				eq(applications.state, "scored"),
				isNull(applications.endedReason),
				isNull(applications.prepareRequestedAt),
			),
		),
		isNull(applications.chosenAnywayAt),
		ne(jobs.source, "manual"),
	);
}

export interface DismissResult {
	/** Matches the user dismissed. */
	dismissed: string[];
	/** Other jobs from the company the user hid, dismissed with it. */
	autoDismissed: string[];
	/** Asked for, but no longer a match nobody acted on (left as they are). */
	skipped: string[];
	/** The company hidden by this action, when it was not hidden already. */
	hiddenCompanyId: string | null;
	events: PendingEvent[];
}

export interface HiddenCompany {
	companyId: string;
	name: string;
	hiddenAt: Date;
	/** Jobs from it the app dismissed (they come back when it is shown again). */
	dismissed: number;
}

/**
 * "Not interested" and hidden companies. Every change commits with a `workflow_events` row per
 * application, returned for the caller to send: a dismissal ends the match's waiting run; an
 * undo starts it again, and it waits in the state it is back in.
 */
export class DismissalStore {
	constructor(private readonly db: Database) {}

	// biome-ignore lint/complexity/useMaxParams: These arguments identify one atomic transaction and its state-transition contract.
	private async event(
		tx: Tx,
		userId: string,
		applicationId: string,
		jobId: string,
		key: string,
		payload: Record<string, unknown>,
	): Promise<PendingEvent> {
		const [row] = await tx
			.insert(workflowEvents)
			.values({
				userId,
				applicationId,
				type: APPLICATION_UPDATED_EVENT,
				idempotencyKey: key,
				payload,
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

	/** Moves one application, guarded by its current state; false when it is elsewhere. */
	// biome-ignore lint/complexity/useMaxParams: These arguments identify one atomic transaction and its state-transition contract.
	private async move(
		tx: Tx,
		userId: string,
		applicationId: string,
		from: ApplicationState,
		to: ApplicationState,
		reason: string,
		actor: "user" | "system",
		endedReason: string | null,
	): Promise<boolean> {
		if (!canTransition(from, to)) return false;
		const moved = await tx
			.update(applications)
			.set({ state: to, endedReason, stateChangedAt: new Date() })
			.where(
				and(
					eq(applications.id, applicationId),
					eq(applications.userId, userId),
					eq(applications.state, from),
				),
			)
			.returning({ id: applications.id });
		if (moved.length === 0) return false;
		await tx.insert(applicationTransitions).values({
			userId,
			applicationId,
			fromState: from,
			toState: to,
			reason,
			actor,
		});
		return true;
	}

	/** Dismisses every job from a hidden company the app may dismiss (see `autoDismissable`). */
	private async dismissCompanyJobs(
		tx: Tx,
		userId: string,
		companyId: string,
		action: string,
		except: Set<string>,
	): Promise<{ ids: string[]; events: PendingEvent[] }> {
		const rows = await tx
			.select({
				id: applications.id,
				jobId: applications.jobId,
				state: applications.state,
			})
			.from(applications)
			.innerJoin(jobs, eq(jobs.id, applications.jobId))
			.innerJoin(companies, eq(companies.id, jobs.companyId))
			.where(
				and(
					eq(applications.userId, userId),
					autoDismissable(),
					sameCompany(companyId),
				),
			);
		const ids: string[] = [];
		const events: PendingEvent[] = [];
		for (const row of rows) {
			if (except.has(row.id)) continue;
			const moved = await this.move(
				tx,
				userId,
				row.id,
				row.state,
				"dismissed",
				COMPANY_HIDDEN_REASON,
				"system",
				ENDED_COMPANY_HIDDEN,
			);
			if (!moved) continue;
			ids.push(row.id);
			events.push(
				await this.event(
					tx,
					userId,
					row.id,
					row.jobId,
					`dismiss-${row.id}-${action}`,
					{ action: "dismiss" },
				),
			);
		}
		return { ids, events };
	}

	/**
	 * Not interested: each listed match nobody acted on moves to dismissed, with the user's
	 * reasons (a `dismissals` row each). With `hideCompanyId`, the company is hidden too, and its
	 * other jobs still being checked or listed are dismissed by the app.
	 */
	async dismiss(input: {
		userId: string;
		applicationIds: string[];
		reasons: DismissReason[];
		note?: string | null;
		hideCompanyId?: string | null;
	}): Promise<DismissResult> {
		const { userId } = input;
		const action = crypto.randomUUID();
		const reasons = [...new Set(input.reasons)];
		const note = input.note?.trim() || null;
		return this.db.transaction(async (tx) => {
			const rows = input.applicationIds.length
				? await tx
						.select({
							id: applications.id,
							jobId: applications.jobId,
							state: applications.state,
							endedReason: applications.endedReason,
							prepareRequestedAt: applications.prepareRequestedAt,
							companyId: jobs.companyId,
						})
						.from(applications)
						.innerJoin(jobs, eq(jobs.id, applications.jobId))
						.where(
							and(
								eq(applications.userId, userId),
								inArray(applications.id, input.applicationIds),
							),
						)
				: [];
			const result: DismissResult = {
				dismissed: [],
				autoDismissed: [],
				skipped: input.applicationIds.filter(
					(id) => !rows.some((r) => r.id === id),
				),
				hiddenCompanyId: null,
				events: [],
			};
			for (const row of rows) {
				const open =
					row.state === "scored" &&
					row.endedReason === null &&
					row.prepareRequestedAt === null;
				const moved =
					open &&
					(await this.move(
						tx,
						userId,
						row.id,
						"scored",
						"dismissed",
						"Not interested",
						"user",
						ENDED_NOT_INTERESTED,
					));
				if (!moved) {
					result.skipped.push(row.id);
					continue;
				}
				await tx.insert(dismissals).values({
					userId,
					applicationId: row.id,
					companyId: row.companyId,
					reasons,
					note,
				});
				result.dismissed.push(row.id);
				result.events.push(
					await this.event(
						tx,
						userId,
						row.id,
						row.jobId,
						`dismiss-${row.id}-${action}`,
						{ action: "dismiss" },
					),
				);
			}
			if (result.dismissed.length === 0 && !input.hideCompanyId)
				throw new Error(
					"Refusing: only a listed match nobody acted on can be dismissed",
				);
			if (input.hideCompanyId) {
				const [company] = await tx
					.select({ id: companies.id })
					.from(companies)
					.where(
						and(
							eq(companies.id, input.hideCompanyId),
							eq(companies.userId, userId),
						),
					);
				if (!company) throw new Error("Company not found");
				const inserted = await tx
					.insert(hiddenCompanies)
					.values({ userId, companyId: company.id })
					.onConflictDoNothing()
					.returning({ id: hiddenCompanies.companyId });
				if (inserted.length > 0) result.hiddenCompanyId = company.id;
				const auto = await this.dismissCompanyJobs(
					tx,
					userId,
					company.id,
					action,
					new Set(result.dismissed),
				);
				result.autoDismissed = auto.ids;
				result.events.push(...auto.events);
			}
			return result;
		});
	}

	/**
	 * Returns dismissed applications to the state each left (the latest move into dismissed),
	 * only while they are still dismissed. Their `dismissals` rows go: an undone click is no
	 * signal. Applications in any other state are left alone.
	 */
	private async restore(
		tx: Tx,
		userId: string,
		where: ReturnType<typeof and>,
		action: string,
	): Promise<{ ids: string[]; events: PendingEvent[] }> {
		const rows = await tx
			.select({
				id: applications.id,
				jobId: applications.jobId,
				from: sql<ApplicationState | null>`(select t.from_state from ${applicationTransitions} t where t.application_id = ${applications.id} and t.to_state = 'dismissed' order by t.created_at desc, t.rowid desc limit 1)`,
			})
			.from(applications)
			.innerJoin(jobs, eq(jobs.id, applications.jobId))
			.innerJoin(companies, eq(companies.id, jobs.companyId))
			.where(
				and(
					eq(applications.userId, userId),
					eq(applications.state, "dismissed"),
					where,
				),
			);
		const ids: string[] = [];
		const events: PendingEvent[] = [];
		for (const row of rows) {
			const back: ApplicationState = row.from === "found" ? "found" : "scored";
			const moved = await this.move(
				tx,
				userId,
				row.id,
				"dismissed",
				back,
				"Dismissal undone",
				"user",
				null,
			);
			if (!moved) continue;
			await tx
				.delete(dismissals)
				.where(
					and(
						eq(dismissals.userId, userId),
						eq(dismissals.applicationId, row.id),
					),
				);
			ids.push(row.id);
			events.push(
				await this.event(
					tx,
					userId,
					row.id,
					row.jobId,
					`undo-${row.id}-${action}`,
					{ action: "undo_dismiss" },
				),
			);
		}
		return { ids, events };
	}

	/** Shows a hidden company again: its jobs the app dismissed come back where they were. */
	private async unhide(
		tx: Tx,
		userId: string,
		companyId: string,
		action: string,
	): Promise<{ ids: string[]; events: PendingEvent[] }> {
		const same = await tx
			.select({ id: companies.id })
			.from(companies)
			.where(and(eq(companies.userId, userId), sameCompany(companyId)));
		const ids = same.map((c) => c.id);
		if (ids.length)
			await tx
				.delete(hiddenCompanies)
				.where(
					and(
						eq(hiddenCompanies.userId, userId),
						inArray(hiddenCompanies.companyId, ids),
					),
				);
		return this.restore(
			tx,
			userId,
			and(
				eq(applications.endedReason, ENDED_COMPANY_HIDDEN),
				sameCompany(companyId),
			),
			action,
		);
	}

	/** Undo of `dismiss`: the matches come back, and the company hidden with them is shown. */
	async undo(input: {
		userId: string;
		applicationIds: string[];
		unhideCompanyId?: string | null;
	}): Promise<{ restored: string[]; events: PendingEvent[] }> {
		const action = crypto.randomUUID();
		return this.db.transaction(async (tx) => {
			const restored: string[] = [];
			const events: PendingEvent[] = [];
			if (input.applicationIds.length) {
				const own = await this.restore(
					tx,
					input.userId,
					and(
						inArray(applications.id, input.applicationIds),
						eq(applications.endedReason, ENDED_NOT_INTERESTED),
					),
					action,
				);
				restored.push(...own.ids);
				events.push(...own.events);
			}
			if (input.unhideCompanyId) {
				const shown = await this.unhide(
					tx,
					input.userId,
					input.unhideCompanyId,
					action,
				);
				restored.push(...shown.ids);
				events.push(...shown.events);
			}
			return { restored, events };
		});
	}

	/** Settings › Hidden companies: Show again. */
	async unhideCompany(input: {
		userId: string;
		companyId: string;
	}): Promise<{ restored: string[]; events: PendingEvent[] }> {
		const action = crypto.randomUUID();
		return this.db.transaction(async (tx) => {
			const shown = await this.unhide(
				tx,
				input.userId,
				input.companyId,
				action,
			);
			return { restored: shown.ids, events: shown.events };
		});
	}

	/**
	 * Show in Matches: the user disagrees with the job filter on a job it set aside. The job is
	 * chosen anyway from then on, so neither the filter nor a re-filter sets it aside again (the
	 * filter's result stays on record). A job that was scored goes back to Matches as it was; one
	 * never scored goes back to found and is scored. Returns the event that runs it again.
	 */
	async showInMatches(input: {
		userId: string;
		applicationId: string;
	}): Promise<{ state: "scored" | "found"; event: PendingEvent | null }> {
		const { userId, applicationId } = input;
		return this.db.transaction(async (tx) => {
			const [row] = await tx
				.select({
					state: applications.state,
					score: applications.score,
					jobId: applications.jobId,
					chosenAnywayAt: applications.chosenAnywayAt,
				})
				.from(applications)
				.where(
					and(
						eq(applications.id, applicationId),
						eq(applications.userId, userId),
					),
				);
			// A repeat (a retry after a lost response): already shown, still found or a match.
			if (
				(row?.state === "found" || row?.state === "scored") &&
				row.chosenAnywayAt !== null
			) {
				const [shown] = await tx
					.select({ id: applicationTransitions.id })
					.from(applicationTransitions)
					.where(
						and(
							eq(applicationTransitions.applicationId, applicationId),
							eq(applicationTransitions.userId, userId),
							eq(applicationTransitions.fromState, "rejected_by_filter"),
							eq(applicationTransitions.reason, SHOWN_IN_MATCHES_REASON),
						),
					)
					.limit(1);
				if (shown) return { state: row.state, event: null };
			}
			if (row?.state !== "rejected_by_filter")
				throw new Error(
					"Refusing: only a job the job filter set aside can be shown in Matches",
				);
			const back = row.score === null ? "found" : "scored";
			await tx
				.update(applications)
				.set({ chosenAnywayAt: new Date(), endedReason: null })
				.where(eq(applications.id, applicationId));
			const moved = await this.move(
				tx,
				userId,
				applicationId,
				"rejected_by_filter",
				back,
				SHOWN_IN_MATCHES_REASON,
				"user",
				null,
			);
			if (!moved) throw new Error("Refusing: it moved on meanwhile");
			const event = await this.event(
				tx,
				userId,
				applicationId,
				row.jobId,
				`show-in-matches-${applicationId}-${Date.now()}`,
				{ action: "show_in_matches" },
			);
			return { state: back, event };
		});
	}

	async listHidden(userId: string): Promise<HiddenCompany[]> {
		return this.db
			.select({
				companyId: hiddenCompanies.companyId,
				name: companies.name,
				hiddenAt: hiddenCompanies.createdAt,
				dismissed: sql<number>`(select count(*) from ${applications} a join ${jobs} j on j.id = a.job_id join ${companies} c on c.id = j.company_id where a.user_id = ${userId} and a.state = 'dismissed' and a.ended_reason = ${ENDED_COMPANY_HIDDEN} and (c.id = ${hiddenCompanies.companyId} or (${companies.nameKey} <> '' and c.name_key = ${companies.nameKey})))`,
			})
			.from(hiddenCompanies)
			.innerJoin(companies, eq(companies.id, hiddenCompanies.companyId))
			.where(eq(hiddenCompanies.userId, userId))
			.orderBy(desc(hiddenCompanies.createdAt));
	}
}

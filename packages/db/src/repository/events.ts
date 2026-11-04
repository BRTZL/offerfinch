import {
	ApprovalRequiredError,
	compareApproval,
	type DocumentHashes,
} from "@offerfinch/core/domain/approval";
import {
	type ApplicationState,
	canTransition,
	InvalidTransitionError,
} from "@offerfinch/core/domain/states";
import type { Actor } from "@offerfinch/core/pipeline/ports";
import { staleCitations } from "@offerfinch/core/tailor/stale";
import {
	APPLICATION_UPDATED_EVENT,
	applicationInstanceId,
} from "@offerfinch/core/workflow/types";
import { and, eq, isNull } from "drizzle-orm";
import {
	applications,
	applicationTransitions,
	approvals,
	jobs,
	workflowEvents,
} from "../schema/pipeline";
import type { DrizzlePipelineRepositoryContext } from "./context";
import type { Tx } from "./shared";

/** The application's posting was found closed (core `pipeline/closed.ts`). */
async function postingClosed(t: Tx, applicationId: string): Promise<boolean> {
	const [job] = await t
		.select({ closedAt: jobs.closedAt })
		.from(jobs)
		.innerJoin(applications, eq(applications.jobId, jobs.id))
		.where(eq(applications.id, applicationId));
	return Boolean(job?.closedAt);
}
/** A Redraft the user asked for replaces documents: approve after it, or cancel it. */
async function refuseWhileRedrafting(
	t: Tx,
	applicationId: string,
): Promise<void> {
	const [pending] = await t
		.select({ redraft: applications.redraft })
		.from(applications)
		.where(eq(applications.id, applicationId));
	if (pending?.redraft)
		throw new ApprovalRequiredError(
			applicationId,
			"a redraft is pending; approve its new version once checked, or cancel the redraft",
		);
}

export const eventsMethods = {
	async lockOwned(t: Tx, userId: string, applicationId: string) {
		const [row] = await t
			.select({ state: applications.state })
			.from(applications)
			.where(
				and(
					eq(applications.id, applicationId),
					eq(applications.userId, userId),
				),
			);
		if (!row)
			throw new Error(`Application ${applicationId} not found for ${userId}`);
		return row;
	},

	/**
	 * Locks the row, checks the state machine, applies the update and records the transition.
	 * Entering `applying` also requires, under the same lock, an unrevoked approval matching the
	 * current document hashes; leaving `approved` for review revokes the approval.
	 */
	// biome-ignore lint/complexity/useMaxParams: Keep document-version and state-transition transaction contracts intact.
	async move(
		userId: string,
		applicationId: string,
		from: readonly ApplicationState[],
		to: ApplicationState,
		reason: string,
		who: Actor,
		extra: Partial<typeof applications.$inferInsert> = {},
		tx?: Tx,
	): Promise<boolean> {
		const run = async (t: Tx) => {
			const [row] = await t
				.select({ state: applications.state, userId: applications.userId })
				.from(applications)
				.where(
					and(
						eq(applications.id, applicationId),
						eq(applications.userId, userId),
					),
				);
			if (!row || !from.includes(row.state)) return false;
			if (!canTransition(row.state, to))
				throw new InvalidTransitionError(row.state, to);
			// A closed posting is never drafted (core pipeline/closed.ts): checked here, in the move
			// itself, so a replayed "prepare requested" cannot pass it.
			if (to === "preparing" && (await postingClosed(t, applicationId)))
				return false;
			if (to === "applying") {
				const verdict = await this.approvalVerdict(t, userId, applicationId);
				if (!verdict.ok)
					throw new ApprovalRequiredError(applicationId, verdict.reason);
			}
			const revoking = row.state === "approved" && to !== "applying";
			if (revoking) await this.revokeApproval(t, userId, applicationId, reason);
			await t
				.update(applications)
				.set({
					...extra,
					...(revoking ? { approvedAt: null } : {}),
					state: to,
					stateChangedAt: new Date(),
				})
				.where(eq(applications.id, applicationId));
			await t.insert(applicationTransitions).values({
				userId: row.userId,
				applicationId,
				fromState: row.state,
				toState: to,
				reason: reason.slice(0, 2000),
				actor: who,
			});
			return true;
		};
		return tx ? run(tx) : this.db.transaction(run);
	},

	async getState(
		userId: string,
		applicationId: string,
	): Promise<ApplicationState | null> {
		const [row] = await this.db
			.select({ state: applications.state })
			.from(applications)
			.where(
				and(
					eq(applications.id, applicationId),
					eq(applications.userId, userId),
				),
			);
		return row?.state ?? null;
	},

	transition(
		userId: string,
		applicationId: string,
		input: {
			from: readonly ApplicationState[];
			to: ApplicationState;
			reason: string;
			actor: Actor;
			requirePrepareRequest?: boolean;
		},
	): Promise<boolean> {
		const move = (t?: Tx) =>
			this.move(
				userId,
				applicationId,
				input.from,
				input.to,
				input.reason,
				input.actor,
				{},
				t,
			);
		if (!input.requirePrepareRequest) return move();
		// Checked under the move's own transaction: a request the re-filter cleared in between
		// (it hid the job, then brought it back) does not start a draft.
		return this.db.transaction(async (t) => {
			const [row] = await t
				.select({ at: applications.prepareRequestedAt })
				.from(applications)
				.where(
					and(
						eq(applications.id, applicationId),
						eq(applications.userId, userId),
					),
				);
			return row?.at ? move(t) : false;
		});
	},

	async consumeEvent(
		userId: string,
		applicationId: string,
		eventId: string,
	): Promise<boolean> {
		const rows = await this.db
			.update(workflowEvents)
			.set({ consumedAt: new Date() })
			.where(
				and(
					eq(workflowEvents.id, eventId),
					eq(workflowEvents.userId, userId),
					eq(workflowEvents.applicationId, applicationId),
					isNull(workflowEvents.consumedAt),
				),
			)
			.returning({ id: workflowEvents.id });
		return rows.length > 0;
	},

	/**
	 * Dashboard side of an event: commits the state change and the event row in one transaction,
	 * keyed by an idempotency key, before anything is sent to the workflow. A repeated call returns
	 * the existing event and changes nothing. The caller then sends `{ eventId }` to
	 * `applicationInstanceId(jobId)`; sending twice is harmless.
	 */
	async recordUserAction(input: {
		userId: string;
		applicationId: string;
		idempotencyKey: string;
		transition?: {
			from: readonly ApplicationState[];
			to: ApplicationState;
			reason: string;
		};
		payload?: Record<string, unknown>;
		/** Required when approving: the hashes of the documents the user saw. */
		approvedHashes?: DocumentHashes;
	}): Promise<{ eventId: string; instanceId: string; created: boolean }> {
		return this.db.transaction(async (tx) => {
			// Lock first: hashes, review and approval are read and written under the same lock an
			// edit takes, so an edit lands either before (and the approval is refused) or after
			// (and revokes it), never in between.
			await this.lockOwned(tx, input.userId, input.applicationId);
			const [app] = await tx
				.select({ jobId: applications.jobId })
				.from(applications)
				.where(
					and(
						eq(applications.id, input.applicationId),
						eq(applications.userId, input.userId),
					),
				);
			if (!app) throw new Error(`Application ${input.applicationId} not found`);
			const instanceId = applicationInstanceId(app.jobId);
			const [inserted] = await tx
				.insert(workflowEvents)
				.values({
					userId: input.userId,
					applicationId: input.applicationId,
					type: APPLICATION_UPDATED_EVENT,
					idempotencyKey: input.idempotencyKey,
					payload: input.payload ?? {},
				})
				.onConflictDoNothing()
				.returning({ id: workflowEvents.id });
			if (!inserted) {
				const [existing] = await tx
					.select({ id: workflowEvents.id })
					.from(workflowEvents)
					.where(
						and(
							eq(workflowEvents.userId, input.userId),
							eq(workflowEvents.idempotencyKey, input.idempotencyKey),
						),
					);
				if (!existing) throw new Error("event conflict without row");
				return { eventId: existing.id, instanceId, created: false };
			}
			if (input.transition?.to === "approved") {
				await refuseWhileRedrafting(tx, input.applicationId);
				// Approve exactly what the user saw: refuse if the documents changed since.
				const current = await this.currentHashes(
					tx,
					input.userId,
					input.applicationId,
				);
				const verdict = compareApproval(input.approvedHashes ?? null, current);
				if (!verdict.ok)
					throw new ApprovalRequiredError(
						input.applicationId,
						`the documents approved are not the current version (${verdict.reason}); reload and review again`,
					);
				// And only what passed review: claims check, rules and ATS, for these exact hashes.
				const review = await this.latestReview(
					input.userId,
					input.applicationId,
					tx,
				);
				const reviewed =
					review &&
					compareApproval(review.documentHashes, current).ok &&
					review.passed &&
					review.atsChecked;
				const open = (review?.flags ?? []).filter((f) => f.state === "open");
				if (!reviewed && review && open.length > 0)
					throw new ApprovalRequiredError(
						input.applicationId,
						`${open.length} flagged line(s) still open; edit, delete or confirm each first`,
					);
				if (!reviewed)
					throw new ApprovalRequiredError(
						input.applicationId,
						review
							? "the documents have not passed review in their current version"
							: "the documents have not been reviewed",
					);
				// And only on the profile it cited: a quote whose record was removed or edited since
				// no longer supports its claim, so the check runs again first.
				const stale = staleCitations(
					review.claims,
					await this.getProfile(input.userId, tx),
					review.flags ?? [],
					review.cited ?? [],
				);
				if (stale.length > 0)
					throw new ApprovalRequiredError(
						input.applicationId,
						`your profile changed since the check: ${stale.length} cited fact(s) were edited or removed; check again before approving`,
					);
				await this.revokeApproval(
					tx,
					input.userId,
					input.applicationId,
					"superseded by a new approval",
				);
				await tx.insert(approvals).values({
					userId: input.userId,
					applicationId: input.applicationId,
					documentHashes: input.approvedHashes ?? {},
				});
			}
			if (input.transition) {
				const moved = await this.move(
					input.userId,
					input.applicationId,
					input.transition.from,
					input.transition.to,
					input.transition.reason,
					"user",
					input.transition.to === "approved" ? { approvedAt: new Date() } : {},
					tx,
				);
				if (!moved)
					throw new Error(
						`Application ${input.applicationId} is not in ${input.transition.from.join("/")}`,
					);
			}
			return { eventId: inserted.id, instanceId, created: true };
		});
	},

	async markEventSent(userId: string, eventId: string): Promise<void> {
		await this.db
			.update(workflowEvents)
			.set({ sentAt: new Date() })
			.where(
				and(eq(workflowEvents.id, eventId), eq(workflowEvents.userId, userId)),
			);
	},
} satisfies Record<string, unknown> &
	ThisType<DrizzlePipelineRepositoryContext>;

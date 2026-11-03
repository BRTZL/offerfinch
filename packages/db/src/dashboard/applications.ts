import {
	APPLICATION_UPDATED_EVENT,
	applicationInstanceId,
} from "@offerfinch/core/workflow/types";
import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "../repository";
import {
	applications,
	documents,
	jobs,
	workflowEvents,
} from "../schema/pipeline";
import type { DashboardRepositoryContext } from "./context";
import type { PendingEvent } from "./shared";
export const applicationsMethods = {
	/** Event row for the workflow, in the same transaction as the change it reports. */
	async addEvent(
		tx: Tx,
		userId: string,
		applicationId: string,
		idempotencyKey: string,
		payload: Record<string, unknown>,
	): Promise<PendingEvent> {
		const [app] = await tx
			.select({ jobId: applications.jobId })
			.from(applications)
			.where(
				and(
					eq(applications.id, applicationId),
					eq(applications.userId, userId),
				),
			);
		if (!app) throw new Error(`Application ${applicationId} not found`);
		const [inserted] = await tx
			.insert(workflowEvents)
			.values({
				userId,
				applicationId,
				type: APPLICATION_UPDATED_EVENT,
				idempotencyKey,
				payload,
			})
			.onConflictDoNothing()
			.returning({ id: workflowEvents.id });
		const id =
			inserted?.id ??
			(
				await tx
					.select({ id: workflowEvents.id })
					.from(workflowEvents)
					.where(
						and(
							eq(workflowEvents.userId, userId),
							eq(workflowEvents.idempotencyKey, idempotencyKey),
						),
					)
			)[0]?.id;
		if (!id) throw new Error("event conflict without row");
		return {
			userId,
			eventId: id,
			instanceId: applicationInstanceId(app.jobId),
		};
	},

	/**
	 * Changes a job's posting (its text, title, employer or details): the one way a posting is
	 * rewritten after it was saved. The documents were written, reviewed and approved for the
	 * posting as it was, so in the same transaction: refused while it is being submitted or
	 * after (applying, applied, needs_human); an approved application goes back to review with
	 * its approval revoked; and the review is out of date (its hashes include the posting), so it
	 * runs again. Returns the event that wakes the application (null when nothing was drafted).
	 */
	async updatePosting(input: {
		userId: string;
		applicationId: string;
		patch: Partial<{
			title: string;
			descriptionText: string;
			companyId: string;
			locations: string[];
			workplaceType: (typeof jobs.$inferInsert)["workplaceType"];
			employmentType: string | null;
			applyUrl: string | null;
			publishedAt: Date | null;
			readStatus: "reading" | "failed" | null;
			readError: string | null;
		}>;
	}): Promise<{ changed: boolean; event: PendingEvent | null }> {
		return this.database.transaction(async (tx) => {
			const app = await this.lockOwned(tx, input.userId, input.applicationId);
			const [job] = await tx
				.select({
					id: jobs.id,
					title: jobs.title,
					description: jobs.descriptionText,
					companyId: jobs.companyId,
				})
				.from(jobs)
				.innerJoin(applications, eq(applications.jobId, jobs.id))
				.where(eq(applications.id, input.applicationId));
			if (!job) throw new Error("Refusing: job not found");
			const changes =
				(input.patch.title !== undefined && input.patch.title !== job.title) ||
				(input.patch.descriptionText !== undefined &&
					input.patch.descriptionText !== job.description) ||
				(input.patch.companyId !== undefined &&
					input.patch.companyId !== job.companyId);
			if (changes && ["applying", "applied", "needs_human"].includes(app.state))
				throw new Error(
					`Refusing: the posting can't change once it is being or has been submitted (it is ${app.state})`,
				);
			await tx.update(jobs).set(input.patch).where(eq(jobs.id, job.id));
			if (!changes) return { changed: false, event: null };
			if (app.state === "approved")
				await this.move(
					input.userId,
					input.applicationId,
					["approved"],
					"ready_for_review",
					"The posting changed after approval; approval revoked",
					"user",
					{},
					tx,
				);
			const [drafted] = await tx
				.select({ id: documents.id })
				.from(documents)
				.where(eq(documents.applicationId, input.applicationId))
				.limit(1);
			if (!drafted) return { changed: true, event: null };
			const event = await this.addEvent(
				tx,
				input.userId,
				input.applicationId,
				`posting-${input.applicationId}-${Date.now()}`,
				{ action: "posting_changed" },
			);
			return { changed: true, event };
		});
	},

	/**
	 * A job the user added by link: they chose it on purpose, so it stays in the Inbox whatever
	 * the job filter or the fit score says (both stay on record and are shown as a note). A job
	 * the filter had set aside goes back to "found" so it is scored; a low score no longer ends
	 * it. Returns the event that runs it again, or null when there was nothing to undo.
	 */
	async keepAddedJob(input: {
		userId: string;
		applicationId: string;
	}): Promise<PendingEvent | null> {
		return this.database.transaction(async (tx) => {
			const [row] = await tx
				.select({
					state: applications.state,
					ended: applications.endedReason,
				})
				.from(applications)
				.where(
					and(
						eq(applications.id, input.applicationId),
						eq(applications.userId, input.userId),
					),
				);
			if (!row) throw new Error("Refusing: application not found");
			const setAside =
				row.state === "rejected_by_filter" ||
				(row.state === "scored" && row.ended !== null);
			await tx
				.update(applications)
				.set({
					chosenAnywayAt: new Date(),
					...(setAside ? { endedReason: null } : {}),
				})
				.where(eq(applications.id, input.applicationId));
			if (!setAside) return null;
			if (row.state === "rejected_by_filter")
				await this.move(
					input.userId,
					input.applicationId,
					["rejected_by_filter"],
					"found",
					"Added by you",
					"user",
					{},
					tx,
				);
			return this.addEvent(
				tx,
				input.userId,
				input.applicationId,
				`added-by-you-${input.applicationId}`,
				{ action: "added_by_you" },
			);
		});
	},

	/**
	 * Once, on start: jobs added by link before this version that the filter set aside go back
	 * to the Inbox. Only source "manual" in rejected_by_filter; every other job is left alone.
	 */
	async migrateAddedJobs(userId: string): Promise<PendingEvent[]> {
		const rows = await this.database
			.select({ id: applications.id })
			.from(applications)
			.innerJoin(jobs, eq(jobs.id, applications.jobId))
			.where(
				and(
					eq(applications.userId, userId),
					eq(applications.state, "rejected_by_filter"),
					eq(jobs.source, "manual"),
				),
			);
		const events: PendingEvent[] = [];
		for (const row of rows) {
			const event = await this.keepAddedJob({
				userId,
				applicationId: row.id,
			});
			if (event) events.push(event);
		}
		return events;
	},

	/**
	 * The user presses Prepare on a match: tailoring is on demand (PLAN A). Records the request and
	 * wakes the application, which checks the spending limit and starts drafting. Keyed by the
	 * application, so a double click prepares once.
	 */
	async requestPrepare(input: {
		userId: string;
		applicationId: string;
	}): Promise<PendingEvent> {
		return this.database.transaction(async (tx) => {
			const app = await this.lockOwned(tx, input.userId, input.applicationId);
			if (app.state !== "scored")
				throw new Error(
					`Refusing: only a listed match can be prepared (it is ${app.state})`,
				);
			// Checked here too, inside the change: P on a list from before the posting closed.
			const [job] = await tx
				.select({ closedReason: jobs.closedReason, closedAt: jobs.closedAt })
				.from(jobs)
				.innerJoin(applications, eq(applications.jobId, jobs.id))
				.where(eq(applications.id, input.applicationId));
			if (job?.closedAt)
				throw new Error(
					`Refusing: this posting looks closed (${job.closedReason ?? "found closed"}), so Prepare did not start. If it is still open, choose It's still open.`,
				);
			await tx
				.update(applications)
				.set({ prepareRequestedAt: new Date() })
				.where(
					and(
						eq(applications.id, input.applicationId),
						eq(applications.userId, input.userId),
						isNull(applications.prepareRequestedAt),
					),
				);
			return this.addEvent(
				tx,
				input.userId,
				input.applicationId,
				`prepare-${input.applicationId}`,
				{ action: "prepare" },
			);
		});
	},

	/** An event already recorded under this key: a repeated click returns it and changes nothing. */
	async existingEvent(
		tx: Tx,
		userId: string,
		idempotencyKey: string,
	): Promise<PendingEvent | null> {
		const [row] = await tx
			.select({ id: workflowEvents.id, jobId: applications.jobId })
			.from(workflowEvents)
			.innerJoin(
				applications,
				eq(applications.id, workflowEvents.applicationId),
			)
			.where(
				and(
					eq(workflowEvents.userId, userId),
					eq(workflowEvents.idempotencyKey, idempotencyKey),
				),
			);
		return row
			? {
					userId,
					eventId: row.id,
					instanceId: applicationInstanceId(row.jobId),
				}
			: null;
	},
} satisfies Record<string, unknown> & ThisType<DashboardRepositoryContext>;

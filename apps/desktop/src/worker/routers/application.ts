import { DashboardRepository, reopenPosting } from "@offerfinch/db";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { checkBeforeAction } from "../closed-postings";
import { pipelineRouter } from "./pipeline";
import { protectedProcedure } from "./procedure";
import { refuse, worker } from "./shared";

export const applicationRouter = {
	...pipelineRouter.application,
	/**
	 * Prepare on a listed match: drafts its CV, letter and answers (tailoring is on demand).
	 * Spends model calls: a button, or P on the one selected match in the Inbox (the user's
	 * request, 2026-11-03); never a key on a selection of several.
	 */
	/**
	 * Prepare anyway: a job the user added themselves that the filter set aside, or that scored
	 * below the minimum. Their choice; the filter result and score stay on record.
	 */
	prepare: protectedProcedure
		.input(z.object({ id: z.string().uuid() }))
		.handler(async ({ context, input }) => {
			// A closed posting is not prepared: tailoring it would spend money for nothing.
			const posting = await checkBeforeAction(worker(), input.id, "prepare");
			if (posting.closed)
				throw new ORPCError("CONFLICT", {
					message: `This posting looks closed: ${posting.reason}. Prepare did not start. If it is still open, choose It's still open.`,
				});
			const event = await refuse(() =>
				new DashboardRepository(worker().db).requestPrepare({
					userId: context.session.user.id,
					applicationId: input.id,
				}),
			);
			await context.sendEvent(event);
			return { preparing: true };
		}),
	/**
	 * The hand-off opened on an approved application: is the posting still open? Cheap and
	 * safe checks only (core `pipeline/closed.ts`); LinkedIn, Indeed and Glassdoor are never read.
	 */
	checkPosting: protectedProcedure
		.input(z.object({ id: z.string().uuid() }))
		.handler(async ({ input }) => {
			const posting = await checkBeforeAction(worker(), input.id, "handoff");
			return posting.closed
				? { closed: true as const, reason: posting.reason }
				: { closed: false as const };
		}),
	/** "It's still open": the check was wrong; automatic checks never close this posting again. */
	reopenPosting: protectedProcedure
		.input(z.object({ id: z.string().uuid() }))
		.handler(async ({ context, input }) => {
			if (
				!(await reopenPosting(worker().db, context.session.user.id, input.id))
			)
				throw new ORPCError("NOT_FOUND");
			return { ok: true };
		}),
};

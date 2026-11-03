import { DISMISS_REASONS } from "@offerfinch/core/domain/dismissal";
import {
	DashboardRepository,
	type Database,
	DismissalStore,
	type PendingEvent,
} from "@offerfinch/db";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { protectedProcedure } from "./routers/procedure";

const ids = z.array(z.string().uuid()).min(1).max(500);

/** A domain refusal ("Refusing: …") as a 409 the app shows as-is. */
async function refuse<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof Error && /^Refusing/.test(error.message))
			throw new ORPCError("CONFLICT", { message: error.message });
		throw error;
	}
}

async function sendAll(
	send: (event: PendingEvent) => Promise<void>,
	events: PendingEvent[],
) {
	for (const event of events) await send(event);
}

/**
 * Not interested on matches, its undo, and hidden companies (Settings). Each change commits
 * first, then wakes the applications it moved: a dismissal ends a match's waiting run; an undo
 * starts it again.
 */
export function dismissalRouter(worker: () => { db: Database }) {
	return {
		/** How many applications each Inbox view holds. */
		views: protectedProcedure.handler(({ context }) =>
			new DashboardRepository(worker().db).inboxCounts(context.session.user.id),
		),
		/**
		 * Not interested: the matches move to dismissed with the user's optional reasons; with
		 * `hideCompanyId` the company is hidden and its other open matches go too.
		 */
		dismiss: protectedProcedure
			.input(
				z.object({
					ids,
					reasons: z.array(z.enum(DISMISS_REASONS)).max(DISMISS_REASONS.length),
					note: z.string().trim().max(500).optional(),
					hideCompanyId: z.string().uuid().optional(),
				}),
			)
			.handler(async ({ context, input }) => {
				const { events, ...result } = await refuse(() =>
					new DismissalStore(worker().db).dismiss({
						userId: context.session.user.id,
						applicationIds: input.ids,
						reasons: input.reasons,
						note: input.note,
						hideCompanyId: input.hideCompanyId,
					}),
				);
				await sendAll(context.sendEvent, events);
				return result;
			}),
		/** Undo of dismiss: those matches come back, and the company it hid is shown again. */
		undo: protectedProcedure
			.input(
				z.object({
					ids: z.array(z.string().uuid()).max(500),
					unhideCompanyId: z.string().uuid().optional(),
				}),
			)
			.handler(async ({ context, input }) => {
				const { events, restored } = await new DismissalStore(worker().db).undo(
					{
						userId: context.session.user.id,
						applicationIds: input.ids,
						unhideCompanyId: input.unhideCompanyId,
					},
				);
				await sendAll(context.sendEvent, events);
				return { restored };
			}),
		/**
		 * Show in Matches: a job the job filter set aside goes back to Matches, and the filter
		 * never sets it aside again.
		 */
		showInMatches: protectedProcedure
			.input(z.object({ id: z.string().uuid() }))
			.handler(async ({ context, input }) => {
				const { event, state } = await refuse(() =>
					new DismissalStore(worker().db).showInMatches({
						userId: context.session.user.id,
						applicationId: input.id,
					}),
				);
				// A repeat call changed nothing: no event to send.
				if (event) await context.sendEvent(event);
				return { state };
			}),
		hidden: {
			list: protectedProcedure.handler(({ context }) =>
				new DismissalStore(worker().db).listHidden(context.session.user.id),
			),
			/** Show again: the company's jobs the app dismissed come back where they were. */
			unhide: protectedProcedure
				.input(z.object({ companyId: z.string().uuid() }))
				.handler(async ({ context, input }) => {
					const { events, restored } = await new DismissalStore(
						worker().db,
					).unhideCompany({
						userId: context.session.user.id,
						companyId: input.companyId,
					});
					await sendAll(context.sendEvent, events);
					return { restored };
				}),
		},
	};
}

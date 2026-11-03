import { TRACKING_STAGES } from "@offerfinch/core/domain/tracking";
import {
	addNote,
	currentStages,
	deleteNote,
	moveStage,
	NOTE_MAX,
	trackingFor,
	updateNote,
} from "@offerfinch/db";
import { z } from "zod";
import { protectedProcedure } from "./procedure";
import { refuse, worker } from "./shared";

const noteBody = z.string().min(1).max(NOTE_MAX);

/**
 * After Applied: stages, their history and private notes. Its own procedures, apart from the
 * application detail, because the chat builds its model input from that detail: notes must
 * never reach a model.
 */
export const trackingRouter = {
	/** Each applied application's current stage, by id; one with none is at Applied. */
	stages: protectedProcedure.handler(async ({ context }) =>
		Object.fromEntries(
			await currentStages(worker().db, context.session.user.id),
		),
	),
	get: protectedProcedure
		.input(z.object({ id: z.string().uuid() }))
		.handler(({ context, input }) =>
			trackingFor(worker().db, context.session.user.id, input.id),
		),
	move: protectedProcedure
		.input(
			z.object({
				id: z.string().uuid(),
				stage: z.enum(TRACKING_STAGES),
				occurredOn: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional(),
				interviewAt: z.string().datetime().nullish(),
				interviewRound: z.number().int().min(1).max(50).nullish(),
				note: z.string().max(NOTE_MAX).optional(),
			}),
		)
		.handler(({ context, input }) =>
			refuse(() =>
				moveStage(worker().db, {
					userId: context.session.user.id,
					applicationId: input.id,
					stage: input.stage,
					occurredOn: input.occurredOn,
					interviewAt: input.interviewAt,
					interviewRound: input.interviewRound,
					note: input.note,
				}),
			),
		),
	addNote: protectedProcedure
		.input(z.object({ id: z.string().uuid(), body: noteBody }))
		.handler(({ context, input }) =>
			refuse(() =>
				addNote(worker().db, {
					userId: context.session.user.id,
					applicationId: input.id,
					body: input.body,
				}),
			),
		),
	updateNote: protectedProcedure
		.input(z.object({ noteId: z.string().uuid(), body: noteBody }))
		.handler(({ context, input }) =>
			refuse(() =>
				updateNote(worker().db, {
					userId: context.session.user.id,
					noteId: input.noteId,
					body: input.body,
				}),
			),
		),
	deleteNote: protectedProcedure
		.input(z.object({ noteId: z.string().uuid() }))
		.handler(({ context, input }) =>
			deleteNote(worker().db, {
				userId: context.session.user.id,
				noteId: input.noteId,
			}),
		),
};

import path from "node:path";
import {
	recordInputSchema,
	recordLabel,
	recordPath,
} from "@offerfinch/core/profile/records";
import {
	addRecord,
	convertProfileFilesWithBackup,
	listRecords,
	moveRecord,
	removeRecord,
	replaceRecords,
	updateRecord,
} from "@offerfinch/db";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { pipelineRouter } from "./pipeline";
import { protectedProcedure } from "./procedure";
import { refuse, worker } from "./shared";

export const profileRouter = {
	...pipelineRouter.profile,
	/** Every record with its label, About first; answers are listed by `questions.facts`. */
	records: protectedProcedure.handler(async ({ context }) =>
		(await listRecords(worker().db, context.session.user.id)).map((r) => ({
			...r,
			label: recordLabel(r),
			path: recordPath(r),
		})),
	),
	/**
	 * Converts a profile an earlier version kept as files into records, after a full copy of
	 * the database in backups/. Only when the user presses Convert; once.
	 */
	convert: protectedProcedure.handler(async ({ context }) => {
		const w = worker();
		return convertProfileFilesWithBackup(
			w.db,
			context.session.user.id,
			path.join(w.init.userData, "backups"),
		);
	}),
	addRecord: protectedProcedure
		.input(recordInputSchema)
		.handler(({ context, input }) =>
			refuse(() =>
				addRecord(
					worker().db,
					context.session.user.id,
					input,
					"you, in the app",
				),
			),
		),
	updateRecord: protectedProcedure
		.input(z.object({ id: z.string().uuid(), record: recordInputSchema }))
		.handler(async ({ context, input }) => {
			const row = await refuse(() =>
				updateRecord(
					worker().db,
					context.session.user.id,
					input.id,
					input.record,
					{ source: "you, in the app" },
				),
			);
			if (!row) throw new ORPCError("NOT_FOUND");
			return row;
		}),
	removeRecord: protectedProcedure
		.input(z.object({ id: z.string().uuid() }))
		.handler(async ({ context, input }) => {
			if (!(await removeRecord(worker().db, context.session.user.id, input.id)))
				throw new ORPCError("NOT_FOUND");
			return { removed: true };
		}),
	moveRecord: protectedProcedure
		.input(
			z.object({ id: z.string().uuid(), direction: z.enum(["up", "down"]) }),
		)
		.handler(async ({ context, input }) => ({
			moved: await moveRecord(
				worker().db,
				context.session.user.id,
				input.id,
				input.direction,
			),
		})),
	/** Saves a reviewed draft as the profile, replacing every record; answers are kept. */
	saveDraft: protectedProcedure
		.input(
			z.object({
				records: z
					.array(
						z.intersection(
							recordInputSchema,
							z.object({ source: z.string().trim().min(1).max(200) }),
						),
					)
					.min(1)
					.max(400)
					.refine(
						(records) => records.filter((r) => r.kind === "about").length === 1,
						"One About record is required",
					),
			}),
		)
		.handler(async ({ context, input }) => ({
			saved: await refuse(() =>
				replaceRecords(worker().db, context.session.user.id, input.records),
			),
		})),
};

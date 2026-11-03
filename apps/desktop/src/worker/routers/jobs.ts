import { ORPCError } from "@orpc/server";
import { z } from "zod";
import {
	addJobFromPaste,
	addJobLinks,
	pasteForApplication,
	removeAddedJob,
	rereadPosting,
	retryRead,
	splitLinks,
} from "../add-job";
import { protectedProcedure } from "./procedure";
import { pastedSchema, refuse, worker } from "./shared";

export const jobsRouter = {
	/** Reads a job's posting again and stores it cleaned (structured data, main content). */
	reread: protectedProcedure
		.input(z.object({ id: z.string().uuid() }))
		.handler(async ({ input }) => {
			const result = await rereadPosting(worker(), input.id);
			if (!result.ok)
				throw new ORPCError("BAD_REQUEST", { message: result.reason });
			return result;
		}),
	/** One or more links (one per line): checked now, read in the background. */
	addLinks: protectedProcedure
		.input(z.object({ text: z.string().trim().min(1).max(20_000) }))
		.handler(({ input }) => {
			const urls = splitLinks(input.text);
			if (urls.length > 25)
				throw new ORPCError("BAD_REQUEST", {
					message: "Up to 25 links at a time",
				});
			return addJobLinks(worker(), { urls });
		}),
	/** The posting's text typed or pasted by the user, for a link. */
	addPasted: protectedProcedure
		.input(
			z.object({
				url: z.string().trim().min(1).max(2000),
				pasted: pastedSchema,
			}),
		)
		.handler(({ input }) => addJobFromPaste(worker(), input)),
	/** "Paste description" on a job whose posting could not be read. */
	pasteFor: protectedProcedure
		.input(z.object({ id: z.string().uuid(), pasted: pastedSchema }))
		.handler(async ({ input }) => {
			await refuse(() => pasteForApplication(worker(), input.id, input.pasted));
			return { ok: true };
		}),
	retryRead: protectedProcedure
		.input(z.object({ id: z.string().uuid() }))
		.handler(async ({ input }) => {
			await refuse(() => retryRead(worker(), input.id));
			return { ok: true };
		}),
	remove: protectedProcedure
		.input(z.object({ id: z.string().uuid() }))
		.handler(async ({ input }) => {
			await refuse(() => removeAddedJob(worker(), input.id));
			return { ok: true };
		}),
};

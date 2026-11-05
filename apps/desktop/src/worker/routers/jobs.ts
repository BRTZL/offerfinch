import { FEEDS } from "@offerfinch/core/feeds/feeds";
import { applications, jobs } from "@offerfinch/db/schema/pipeline";
import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
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

/** Job sources whose postings come whole from a public feed (core/feeds). */
const FEED_SOURCES: ReadonlySet<string> = new Set(FEEDS.map((f) => f.source));

/** Whether an application's job came from a remote feed. */
async function fromFeed(
	userId: string,
	applicationId: string,
): Promise<boolean> {
	const [row] = await worker()
		.db.select({ source: jobs.source })
		.from(applications)
		.innerJoin(jobs, eq(jobs.id, applications.jobId))
		.where(
			and(eq(applications.id, applicationId), eq(applications.userId, userId)),
		);
	return Boolean(row && FEED_SOURCES.has(row.source));
}

/** Try-it mode reads no page from the internet: links are refused there (worker/demo.ts). */
function refuseInDemo() {
	if (worker().init.demo)
		throw new ORPCError("BAD_REQUEST", {
			message:
				"With sample data, OfferFinch reads no page from the internet. Leave demo to add jobs by link.",
		});
}

export const jobsRouter = {
	/** Reads a job's posting again and stores it cleaned (structured data, main content). */
	reread: protectedProcedure
		.input(z.object({ id: z.string().uuid() }))
		.handler(async ({ context, input }) => {
			refuseInDemo();
			// A remote feed gave the whole posting; its page there (an HN post, a page behind a
			// browser check) is never read by the app (docs/decisions.md, 2026-11-03).
			if (await fromFeed(context.session.user.id, input.id))
				throw new ORPCError("BAD_REQUEST", {
					message:
						"This posting came whole from its feed and is not read again. Open it there to see the page.",
				});
			const result = await rereadPosting(worker(), input.id);
			if (!result.ok)
				throw new ORPCError("BAD_REQUEST", { message: result.reason });
			return result;
		}),
	/** One or more links (one per line): checked now, read in the background. */
	addLinks: protectedProcedure
		.input(z.object({ text: z.string().trim().min(1).max(20_000) }))
		.handler(({ input }) => {
			refuseInDemo();
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
			refuseInDemo();
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

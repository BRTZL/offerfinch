import { DashboardRepository, INBOX_VIEWS } from "@offerfinch/db";
import { z } from "zod";
import { pipelineRouter } from "./pipeline";
import { protectedProcedure } from "./procedure";
import { stateSchema, worker } from "./shared";

export const inboxRouter = {
	...pipelineRouter.inbox,
	/** A page of the inbox, for the virtualized list (no 200-row cap). */
	page: protectedProcedure
		.input(
			z.object({
				view: z.enum(INBOX_VIEWS).optional(),
				states: z.array(stateSchema).optional(),
				search: z.string().max(200).optional(),
				minScore: z.number().min(0).max(100).optional(),
				companyId: z.string().uuid().optional(),
				offset: z.number().int().min(0).max(1_000_000),
				limit: z.number().int().min(1).max(500),
				sort: z.enum(["recent", "fit"]).optional(),
				includeAdded: z.boolean().optional(),
			}),
		)
		.handler(({ context, input }) =>
			new DashboardRepository(worker().db).listApplications(
				context.session.user.id,
				input,
			),
		),
};

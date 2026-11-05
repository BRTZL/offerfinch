import { DashboardRepository } from "@offerfinch/db";
import { z } from "zod";
import {
	SETUP_STEPS,
	setupComplete,
	setupProgress,
} from "../../shared/setup-steps";
import { protectedProcedure } from "./procedure";
import { providerStatus, worker } from "./shared";

export const onboardingRouter = {
	get: protectedProcedure.handler(async ({ context }) => {
		const w = worker();
		const state = await w.settings.get("onboarding");
		const repo = new DashboardRepository(w.db);
		const profile = await repo.profileFiles(context.session.user.id);
		const sources = await providerStatus(w, context.session.user.id);
		// The five steps, also when the progress was stored by the eight-step setup.
		const progress = setupProgress(state);
		return {
			...state,
			...progress,
			// Finished only with every step done and none skipped; a row an earlier version marked
			// complete with skipped steps reads as open again.
			completedAt: setupComplete(progress) ? state.completedAt : null,
			hasProfile: Boolean(profile),
			/** Sources set up and on: a scan needs at least one. */
			sources: sources.filter((p) => p.ready).length,
			steps: SETUP_STEPS,
		};
	}),
	mark: protectedProcedure
		.input(
			z.object({
				step: z.enum(SETUP_STEPS),
				outcome: z.enum(["done", "skipped"]),
			}),
		)
		.handler(async ({ input }) => {
			const w = worker();
			const state = await w.settings.get("onboarding");
			const done = new Set(state.done);
			const skipped = new Set(state.skipped);
			done.add(input.step);
			if (input.outcome === "skipped") skipped.add(input.step);
			else skipped.delete(input.step);
			const progress = setupProgress({
				done: [...done],
				skipped: [...skipped],
			});
			const all = setupComplete(progress);
			const next = {
				...state,
				done: [...done],
				skipped: [...skipped],
				completedAt: all
					? (state.completedAt ?? new Date().toISOString())
					: null,
			};
			await w.settings.set("onboarding", next);
			return next;
		}),
	dismiss: protectedProcedure
		.input(z.object({ dismissed: z.boolean() }))
		.handler(async ({ input }) => {
			const w = worker();
			const state = await w.settings.get("onboarding");
			await w.settings.set("onboarding", {
				...state,
				dismissed: input.dismissed,
			});
			return { dismissed: input.dismissed };
		}),
};

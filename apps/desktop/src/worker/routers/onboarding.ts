import { DashboardRepository } from "@offerfinch/db";
import { z } from "zod";
import { ONBOARDING_STEPS } from "../settings";
import { protectedProcedure } from "./procedure";
import { providerStatus, worker } from "./shared";

export const onboardingRouter = {
	get: protectedProcedure.handler(async ({ context }) => {
		const w = worker();
		const state = await w.settings.get("onboarding");
		const repo = new DashboardRepository(w.db);
		const profile = await repo.profileFiles(context.session.user.id);
		const sources = await providerStatus(w, context.session.user.id);
		return {
			...state,
			hasProfile: Boolean(profile),
			/** Sources set up and on: a scan needs at least one. */
			sources: sources.filter((p) => p.ready).length,
			steps: ONBOARDING_STEPS,
		};
	}),
	mark: protectedProcedure
		.input(
			z.object({
				step: z.enum(ONBOARDING_STEPS),
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
			const all = ONBOARDING_STEPS.every((s) => done.has(s));
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

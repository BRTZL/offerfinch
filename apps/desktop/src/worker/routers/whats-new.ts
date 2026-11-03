import { z } from "zod";
import { protectedProcedure } from "./procedure";
import { worker } from "./shared";

/**
 * What's new (issue #9): the worker only stores which version's notes were last shown. The
 * window decides what to show (shared/release-notes.ts) from the notes main bundles.
 */
export const whatsNewRouter = {
	state: protectedProcedure.handler(async () => {
		const w = worker();
		const onboarding = await w.settings.get("onboarding");
		return {
			seen: await w.settings.get("whatsNewSeen"),
			// Any onboarding progress means this database was used before: an upgrade.
			usedBefore:
				onboarding.done.length > 0 ||
				onboarding.skipped.length > 0 ||
				onboarding.dismissed ||
				Boolean(onboarding.completedAt),
		};
	}),
	seen: protectedProcedure
		.input(z.object({ version: z.string().trim().min(1).max(40) }))
		.handler(async ({ input }) => {
			await worker().settings.set("whatsNewSeen", input.version);
			return { seen: input.version };
		}),
};

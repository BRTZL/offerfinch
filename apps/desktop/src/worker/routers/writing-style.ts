import { writingStyleSchema } from "@offerfinch/core/tailor/writing-style";
import { protectedProcedure } from "./procedure";
import { worker } from "./shared";

/**
 * Settings › Writing: how drafts read. Read at each draft, redraft, chat turn and answer-helper
 * call, so a save applies to the next one; nothing already drafted changes.
 */
export const writingStyleRouter = {
	get: protectedProcedure.handler(() => worker().settings.get("writingStyle")),
	set: protectedProcedure
		.input(writingStyleSchema)
		.handler(async ({ input }) => {
			await worker().settings.set("writingStyle", input);
			return worker().settings.get("writingStyle");
		}),
};

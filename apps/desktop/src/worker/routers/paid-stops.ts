import {
	DrizzleSpendStore,
	paidStopText,
	type SubscriptionVendor,
} from "@offerfinch/db";
import { resumeClaudeCalls } from "@offerfinch/local-llm/claude";
import { resumeCodexCalls } from "@offerfinch/local-llm/codex";
import { resumeOpenCodeCalls } from "@offerfinch/local-llm/opencode";
import { z } from "zod";
import { protectedProcedure } from "./procedure";
import { usagePage, worker } from "./shared";

/** Claude, Codex, or one OpenCode source (`opencode:<source>`). */
const vendorSchema = z
	.string()
	.regex(/^(anthropic|openai|opencode:[\w.-]+)$/)
	.transform((v) => v as SubscriptionVendor);

export const paidStopsRouter = {
	/**
	 * Each plan stopped after a paid call (Claude extra usage, ChatGPT credits), with what to say
	 * and where its usage page is. Empty while both run.
	 */
	list: protectedProcedure.handler(async ({ context }) => {
		const stops = await new DrizzleSpendStore(worker().db).paidStops(
			context.session.user.id,
		);
		return (Object.keys(stops) as SubscriptionVendor[]).flatMap((vendor) => {
			const at = stops[vendor];
			return at
				? [
						{
							vendor,
							at,
							text: paidStopText(vendor, at),
							usagePage: usagePage(vendor, true),
						},
					]
				: [];
		});
	}),
	/** Lifts a plan's paid stop, in the database and in this worker; Claude: extra usage is off. */
	resume: protectedProcedure
		.input(z.object({ vendor: vendorSchema }))
		.handler(async ({ context, input }) => {
			await new DrizzleSpendStore(worker().db).resumeSubscription(
				context.session.user.id,
				input.vendor,
			);
			// This worker's pause for the paid call lifts too, so the next call is sent (a
			// usage-limit or logout pause stays).
			if (input.vendor === "anthropic") resumeClaudeCalls();
			else if (input.vendor === "openai") resumeCodexCalls();
			else resumeOpenCodeCalls(input.vendor);
			worker().runner.poke();
			return { resumed: true };
		}),
};

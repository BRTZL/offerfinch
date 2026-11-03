import { DrizzleSpendStore } from "@offerfinch/db";
import { resumeClaudeCalls } from "@offerfinch/local-llm/claude";
import { resumeCodexCalls } from "@offerfinch/local-llm/codex";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { protectedProcedure } from "./procedure";
import { usagePage, worker } from "./shared";

export const holdsRouter = {
	/**
	 * Model calls held at their worst case because whether (or what) they were billed is not
	 * known, with where to look it up. Confirmed here after checking the provider’s usage page.
	 */
	list: protectedProcedure.handler(async ({ context }) => {
		const store = new DrizzleSpendStore(worker().db);
		const held = await store.listHeld(context.session.user.id);
		return {
			held: held.map((h) => ({
				id: h.id,
				task: h.task,
				provider: h.provider,
				vendor: h.vendor,
				subscription: h.subscription,
				reservationMicros: h.estimateMicros,
				createdAt: h.createdAt,
				reason: h.error,
				confirmedOffBefore: h.confirmedOffBefore,
				usagePage: usagePage(h.vendor, h.subscription),
			})),
			state: await store.subscriptionState(context.session.user.id),
		};
	}),
	/** What a held call really cost (from the vendor's usage page), or `null`: not charged. */
	reconcile: protectedProcedure
		.input(
			z.object({
				id: z.string().uuid(),
				usd: z.number().min(0).max(1_000).nullable(),
			}),
		)
		.handler(async ({ context, input }) => {
			const settled = await new DrizzleSpendStore(worker().db).reconcile(
				context.session.user.id,
				input.id,
				Math.round((input.usd ?? 0) * 1_000_000),
			);
			if (!settled) throw new ORPCError("NOT_FOUND");
			return { settled };
		}),
	/** Lifts a vendor's pause once its held calls are reconciled; Claude: extra usage is off. */
	resume: protectedProcedure
		.input(z.object({ vendor: z.enum(["anthropic", "openai"]) }))
		.handler(async ({ context, input }) => {
			try {
				await new DrizzleSpendStore(worker().db).resumeSubscription(
					context.session.user.id,
					input.vendor,
				);
			} catch (error) {
				throw new ORPCError("CONFLICT", {
					message: error instanceof Error ? error.message : String(error),
				});
			}
			// Every held call is reconciled: this worker's pause for a paid or unknown payment
			// lifts too, so the next call is sent (a usage-limit or logout pause stays).
			if (input.vendor === "anthropic") resumeClaudeCalls();
			else resumeCodexCalls();
			worker().runner.poke();
			return { resumed: true };
		}),
};

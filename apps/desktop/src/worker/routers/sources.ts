import { PROVIDER_IDS, updateProvider } from "@offerfinch/db";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { SITE_TABS } from "../../shared/bridge";
import { DEMO_SITE_REFUSAL } from "../demo";
import { protectedProcedure } from "./procedure";
import {
	clearStops,
	providerStatus,
	signInDetector,
	siteTabsStatus,
	worker,
} from "./shared";

/** Try-it mode touches no site session: they are the real ones (worker/demo.ts). */
function refuseInDemo() {
	if (worker().init.demo)
		throw new ORPCError("BAD_REQUEST", { message: DEMO_SITE_REFUSAL });
}

export const sourcesRouter = {
	/**
	 * Each source: on or off, its last run and current problem; each site tab's sign-in. No
	 * per-source settings: every source uses the shared search plan (Settings › Job search).
	 */
	list: protectedProcedure.handler(async ({ context }) => {
		const w = worker();
		return {
			providers: await providerStatus(w, context.session.user.id),
			tabs: await siteTabsStatus(w),
		};
	}),
	/**
	 * After the sign-in sheet closed: reads where the site's tab ended. A normal page on the
	 * site means the sign-in worked; a sign-in page (or anything else) means it did not.
	 */
	checkSignIn: protectedProcedure
		.input(z.object({ site: z.enum(SITE_TABS) }))
		.handler(async ({ input }) => {
			refuseInDemo();
			const w = worker();
			const call = w.siteHost().site;
			try {
				const page = (await call({
					op: "snapshot",
					site: input.site,
				})) as { url: string; status: number | null; html: string };
				const stop = signInDetector(w, input.site)(page);
				if (!stop)
					await w.markSession(input.site, {
						signedInAt: new Date().toISOString(),
						needsSignIn: false,
					});
				return { signedIn: !stop };
			} catch {
				// The tab is gone (a run took it, or it timed out): nothing learnt.
				return { signedIn: null };
			} finally {
				await call({ op: "closeIdle", site: input.site }).catch(() => {});
			}
		}),
	/** Clears the site's whole session in OfferFinch (cookies, storage, cache). */
	signOut: protectedProcedure
		.input(z.object({ site: z.enum(SITE_TABS) }))
		.handler(async ({ input }) => {
			refuseInDemo();
			const w = worker();
			try {
				await w.siteHost().site({ op: "signOut", site: input.site });
			} catch (error) {
				throw new ORPCError("CONFLICT", {
					message: error instanceof Error ? error.message : String(error),
				});
			}
			await w.markSession(input.site, {
				signedInAt: null,
				needsSignIn: false,
			});
			return { signedOut: true };
		}),
	update: protectedProcedure
		.input(
			z.object({
				provider: z.enum(PROVIDER_IDS),
				enabled: z.boolean().optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			await updateProvider(
				worker().db,
				context.session.user.id,
				input.provider,
				{ enabled: input.enabled },
			);
			return { saved: true };
		}),
	/**
	 * Retry now: the source's stop is lifted and a scan starts at once. LinkedIn is read in that
	 * scan without waiting out its 3 hours (its 30 pages a day still hold).
	 */
	retry: protectedProcedure
		.input(z.object({ provider: z.enum(PROVIDER_IDS) }))
		.handler(async ({ context, input }) => {
			const w = worker();
			await clearStops(w, context.session.user.id, input.provider);
			if (input.provider === "linkedin") {
				const { readLinkedInNow } = await import("../linkedin");
				readLinkedInNow();
			}
			return w.scanNow();
		}),
	/** The user checked the site in their browser: its next scan may read it again. */
	clearStop: protectedProcedure
		.input(z.object({ provider: z.enum(PROVIDER_IDS) }))
		.handler(async ({ context, input }) => {
			await clearStops(worker(), context.session.user.id, input.provider);
			return { cleared: true };
		}),
};

import { meteredFor } from "@offerfinch/core/scoring/metered";
import { DrizzleSpendStore } from "@offerfinch/db";
import {
	CODEX_CREDITS_HOWTO,
	CODEX_HEADROOM_PERCENT,
} from "@offerfinch/local-llm/codex";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { autoFill } from "../../shared/auto-connect";
import { VENDOR_RULE } from "../pipeline";
import { aiSettingsSchema } from "../settings";
import { protectedProcedure } from "./procedure";
import { worker } from "./shared";

export const aiRouter = {
	get: protectedProcedure.handler(async () => {
		const w = worker();
		return {
			settings: await w.settings.get("ai"),
			roles: w.roles,
			vendorRule: VENDOR_RULE,
			fakeAllowed: Boolean(w.init.test?.fakeModels),
		};
	}),
	set: protectedProcedure.input(aiSettingsSchema).handler(async ({ input }) => {
		const w = worker();
		for (const role of ["scoring", "tailoring", "claims"] as const)
			if (input[role].mode === "fake" && !w.init.test?.fakeModels)
				throw new ORPCError("BAD_REQUEST", {
					message: "Test models are only available in test runs",
				});
		await w.settings.set("ai", input);
		await w.rebuild();
		w.runner.poke();
		return { roles: w.roles };
	}),
	/**
	 * Claude Code and Codex on this Mac: where each CLI is, its version against the tested
	 * one, its login (read without a prompt), and what to run when it is not ready. Plus the
	 * guards: Claude's extra-usage confirmation, Codex's usage headroom, the daily budget.
	 */
	subscriptions: protectedProcedure.handler(async ({ context }) => {
		const w = worker();
		const store = new DrizzleSpendStore(w.db);
		// On a first start, the login shell's PATH may still be on its way.
		await w.pathRefresh;
		const [claude, codex] = await Promise.all([
			w.subscriptions.claude(),
			w.subscriptions.codex(),
		]);
		return {
			claude,
			codex,
			vendorRule: VENDOR_RULE,
			extraUsageOffConfirmedAt: await store.extraUsageOffConfirmedAt(
				context.session.user.id,
			),
			callBudget: await store.subscriptionBudget(context.session.user.id),
			codexHeadroomPercent: CODEX_HEADROOM_PERCENT,
			codexCredits: CODEX_CREDITS_HOWTO,
		};
	}),
	/**
	 * Setup's Connect AI: finds Claude Code and Codex, and gives each role that is still open
	 * (on an API key with none stored) the signed-in one: Claude finds matches and drafts, Codex
	 * checks drafts. A choice the user made is never changed. `refresh` reads PATH and the
	 * logins again (Check again, after installing or signing in).
	 */
	autoConnect: protectedProcedure
		.input(z.object({ refresh: z.boolean().default(false) }))
		.handler(async ({ input }) => {
			const w = worker();
			await w.pathRefresh;
			if (input.refresh) await w.refreshClis({ always: true });
			const [claude, codex] = await Promise.all([
				w.subscriptions.claude(),
				w.subscriptions.codex(),
			]);
			const settings = await w.settings.get("ai");
			const { settings: next, filled } = autoFill({
				settings,
				claude: claude.login.state === "logged_in",
				codex: codex.login.state === "logged_in",
				keys: {
					anthropic: w.hasSecret("anthropic"),
					openai: w.hasSecret("openai"),
				},
			});
			if (filled.length) {
				await w.settings.set("ai", next as typeof settings);
				await w.rebuild();
				w.runner.poke();
			}
			return { claude, codex, filled, roles: w.roles };
		}),
	/**
	 * A live test of one role: one small call through the metered path (counted against the
	 * cap like any call). Sends no profile data.
	 */
	test: protectedProcedure
		.input(z.object({ role: z.enum(["scoring", "tailoring", "claims"]) }))
		.handler(async ({ context, input }) => {
			const w = worker();
			const provider =
				input.role === "scoring"
					? w.deps.llm
					: input.role === "tailoring"
						? (w.deps.tailorLlm ?? w.deps.llm)
						: w.deps.claimsLlm;
			if (!provider) return { ok: false, message: "Not configured" };
			const started = Date.now();
			try {
				const answer = await meteredFor(
					provider,
					w.deps.spend,
					context.session.user.id,
					null,
				).generateObject({
					task: "connection-test",
					system: "You answer connection checks with the requested JSON only.",
					prompt: 'Reply with {"ok": true}.',
					schema: z.object({ ok: z.boolean() }),
					// Room for adaptive thinking: a small limit fails the test, not the model.
					maxTokens: 2_000,
				});
				return {
					ok: answer.ok === true,
					message: `${provider.name} answered in ${Date.now() - started} ms`,
				};
			} catch (error) {
				return {
					ok: false,
					message: error instanceof Error ? error.message : String(error),
				};
			}
		}),
};

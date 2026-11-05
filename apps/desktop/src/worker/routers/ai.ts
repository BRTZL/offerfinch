import { meteredFor } from "@offerfinch/core/scoring/metered";
import { DrizzleSpendStore } from "@offerfinch/db";
import {
	CODEX_CREDITS_HOWTO,
	CODEX_HEADROOM_PERCENT,
} from "@offerfinch/local-llm/codex";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { autoFill } from "../../shared/auto-connect";
import {
	PROVIDER_IDS,
	PROVIDER_NAMES,
	parseModelRef,
	providerOff,
} from "../../shared/providers";
import { planUsageViews } from "../plan-usage";
import { aiSettingsSchema } from "../settings";
import { protectedProcedure } from "./procedure";
import { worker } from "./shared";

export const aiRouter = {
	get: protectedProcedure.handler(async () => {
		const w = worker();
		return {
			settings: await w.settings.get("ai"),
			roles: w.roles,
			// Try-it mode runs on the test models too.
			fakeAllowed: Boolean(w.init.demo || w.init.test?.fakeModels),
		};
	}),
	set: protectedProcedure.input(aiSettingsSchema).handler(async ({ input }) => {
		const w = worker();
		for (const role of ["scoring", "tailoring", "claims"] as const)
			if (
				parseModelRef(input[role].model ?? "")?.provider === "fake" &&
				!w.init.demo &&
				!w.init.test?.fakeModels
			)
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
			usage: await planUsageViews(w.planUsage, store, context.session.user.id),
			extraUsageOffConfirmedAt: await store.extraUsageOffConfirmedAt(
				context.session.user.id,
			),
			callBudget: await store.subscriptionBudget(context.session.user.id),
			codexHeadroomPercent: CODEX_HEADROOM_PERCENT,
			codexCredits: CODEX_CREDITS_HOWTO,
		};
	}),
	/**
	 * Every provider with its state on this computer and the models it offers: whether it runs on
	 * this platform (`off`, why not), installed and signed in, and its models. The pickers offer
	 * the models of the providers that are on and signed in, and the test models in test runs.
	 */
	models: protectedProcedure.handler(async () => {
		const w = worker();
		await w.pathRefresh;
		const providers = await Promise.all(
			PROVIDER_IDS.map(async (provider) => {
				const [state, models] = await Promise.all([
					w.subscriptions.state(provider),
					w.subscriptions.models(provider),
				]);
				const off = providerOff(provider, process.platform);
				return {
					provider,
					name: PROVIDER_NAMES[provider],
					off,
					signedIn: !off && state.login.state === "logged_in",
					state,
					models,
				};
			}),
		);
		return {
			providers,
			fakeAllowed: Boolean(w.init.demo || w.init.test?.fakeModels),
		};
	}),
	/**
	 * Installs a provider OfferFinch downloads itself (Gemini through Antigravity: Google's pinned
	 * server, checked against its size and hash before it is unpacked). Returns its state after.
	 */
	install: protectedProcedure
		.input(z.object({ provider: z.literal("antigravity") }))
		.handler(async ({ input }) => {
			const w = worker();
			try {
				const state = await w.subscriptions.install(input.provider);
				await w.rebuild();
				return { state };
			} catch (error) {
				throw new ORPCError("BAD_REQUEST", {
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}),
	/**
	 * OfferFinch's own sign-in to a provider (Gemini through Antigravity): Google's page opens in
	 * the browser, and this answers once the sign-in finished (or failed, or timed out after five
	 * minutes). Asking again while one waits opens the same page again. Returns the state after.
	 */
	signIn: protectedProcedure
		.input(z.object({ provider: z.literal("antigravity") }))
		.handler(async ({ input }) => {
			const w = worker();
			try {
				const state = await w.subscriptions.signIn(input.provider);
				await w.rebuild();
				w.runner.poke();
				return { state };
			} catch (error) {
				throw new ORPCError("BAD_REQUEST", {
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}),
	/**
	 * What each plan has used of its windows and OfferFinch's share, as last read: nothing is
	 * started. The reads happen with each call, with each CLI check, and on `refreshUsage`.
	 */
	planUsage: protectedProcedure.handler(async ({ context }) => {
		const w = worker();
		return planUsageViews(
			w.planUsage,
			new DrizzleSpendStore(w.db),
			context.session.user.id,
		);
	}),
	/** Reads both plans' usage again now (a probe per CLI, no prompt), then the views. */
	refreshUsage: protectedProcedure.handler(async ({ context }) => {
		const w = worker();
		await w.pathRefresh;
		await Promise.all([
			w.subscriptions.claude({ fresh: true }),
			w.subscriptions.codex({ fresh: true }),
		]);
		return planUsageViews(
			w.planUsage,
			new DrizzleSpendStore(w.db),
			context.session.user.id,
		);
	}),
	/**
	 * Setup's Connect AI: finds Claude Code and Codex, and gives each step still without a model
	 * the signed-in one: Claude for all three when it is signed in, else Codex. A choice the user
	 * made is never changed. `refresh` reads PATH and the logins again (Check again, after
	 * installing or signing in).
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
				signedIn: {
					claude:
						!providerOff("claude", process.platform) &&
						claude.login.state === "logged_in",
					codex:
						!providerOff("codex", process.platform) &&
						codex.login.state === "logged_in",
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

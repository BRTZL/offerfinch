import { meteredFor } from "@offerfinch/core/scoring/metered";
import { DrizzleSpendStore } from "@offerfinch/db";
import {
	CODEX_CREDITS_HOWTO,
	CODEX_HEADROOM_PERCENT,
} from "@offerfinch/local-llm/codex";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import {
	PROVIDER_IDS,
	PROVIDER_IN_APP,
	PROVIDER_NAMES,
	type ProviderId,
	parseModelRef,
} from "../../shared/providers";
import { fillSteps, providerViews } from "../model-choice";
import { planUsageViews } from "../plan-usage";
import { aiSettingsSchema } from "../settings";
import type { ProviderAction } from "../subscriptions";
import { protectedProcedure } from "./procedure";
import { worker } from "./shared";

/** The steps that ran on an API key, while the notice saying keys were removed is up. */
async function keysNotice() {
	const notice = await worker().settings.get("keysRemoved");
	return notice && !notice.dismissed ? { steps: notice.steps } : null;
}

/**
 * An install or sign-in from the app: the provider's own when this version has one, else what
 * to do instead. Afterwards the provider's state is read again.
 */
async function providerAction(
	provider: ProviderId,
	kind: "install" | "signIn",
	run: ((provider: ProviderId) => Promise<ProviderAction>) | undefined,
): Promise<ProviderAction> {
	const name = PROVIDER_NAMES[provider];
	const what = kind === "install" ? "Installing" : "Signing in to";
	if (!PROVIDER_IN_APP[provider][kind])
		return {
			ok: false,
			message: `${what} ${name} happens in Terminal: run the command shown for it.`,
		};
	if (!run)
		return {
			ok: false,
			message: `${what} ${name} from OfferFinch is not available in this version yet.`,
		};
	const w = worker();
	const result = await run.call(w.subscriptions, provider);
	await w.subscriptions.state(provider, { fresh: true });
	return result;
}

export const aiRouter = {
	get: protectedProcedure.handler(async () => {
		const w = worker();
		return {
			settings: await w.settings.get("ai"),
			roles: w.roles,
			// Try-it mode runs on the test models too.
			fakeAllowed: Boolean(w.init.demo || w.init.test?.fakeModels),
			keysRemoved: await keysNotice(),
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
		return {
			providers: await providerViews(w.subscriptions),
			fakeAllowed: Boolean(w.init.demo || w.init.test?.fakeModels),
		};
	}),
	/**
	 * Installs a provider OfferFinch installs itself (Gemini's Antigravity server), then reads its
	 * state again. A provider installed from Terminal, or a version that cannot, says what to do.
	 */
	install: protectedProcedure
		.input(z.object({ provider: z.enum(PROVIDER_IDS) }))
		.handler(({ input }) =>
			providerAction(input.provider, "install", worker().subscriptions.install),
		),
	/** Signs in to a provider OfferFinch signs in to itself (Gemini, with Google). */
	signIn: protectedProcedure
		.input(z.object({ provider: z.enum(PROVIDER_IDS) }))
		.handler(({ input }) =>
			providerAction(input.provider, "signIn", worker().subscriptions.signIn),
		),
	/** Settings › Models' notice that API keys were removed: shown until dismissed. */
	dismissKeysNotice: protectedProcedure.handler(async () => {
		const w = worker();
		const notice = await w.settings.get("keysRemoved");
		if (notice)
			await w.settings.set("keysRemoved", { ...notice, dismissed: true });
		return { ok: true };
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
	 * Setup's Connect AI: finds every provider, and gives each step still without a model one
	 * from what is available: Claude for all three when it is signed in, else the first plan
	 * model found. A choice the user made is never changed. `refresh` reads PATH and the logins
	 * again (Check again, after installing or signing in).
	 */
	autoConnect: protectedProcedure
		.input(z.object({ refresh: z.boolean().default(false) }))
		.handler(async ({ input }) => {
			const w = worker();
			await w.pathRefresh;
			if (input.refresh) await w.refreshClis({ always: true });
			const providers = await providerViews(w.subscriptions, {
				fresh: input.refresh,
			});
			const filled = await fillSteps(w, providers);
			return {
				providers,
				fakeAllowed: Boolean(w.init.demo || w.init.test?.fakeModels),
				filled,
				roles: w.roles,
			};
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

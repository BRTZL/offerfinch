import { autoFill } from "../shared/auto-connect";
import {
	type ModelInfo,
	PROVIDER_IDS,
	PROVIDER_IN_APP,
	PROVIDER_NAMES,
	type ProviderId,
	providerOff,
	ROLES,
	type Role,
} from "../shared/providers";
import type { AiSettings, SettingsStore } from "./settings";
import type { CliState, Subscriptions } from "./subscriptions";

/** One provider as the pickers and the Accounts list show it. */
export interface ProviderView {
	provider: ProviderId;
	name: string;
	/** Why it does not run on this platform, or null. */
	off: string | null;
	signedIn: boolean;
	state: CliState;
	models: ModelInfo[];
	/** What OfferFinch installs or signs in to itself (`ai.install`, `ai.signIn`). */
	inApp: { install: boolean; signIn: boolean };
}

/** Every provider's state and models on this computer, read in parallel. */
export async function providerViews(
	subscriptions: Subscriptions,
	options: { fresh?: boolean } = {},
): Promise<ProviderView[]> {
	return Promise.all(
		PROVIDER_IDS.map(async (provider) => {
			const [state, models] = await Promise.all([
				subscriptions.state(provider, options),
				subscriptions.models(provider),
			]);
			const off = providerOff(provider, process.platform);
			return {
				provider,
				name: PROVIDER_NAMES[provider],
				off,
				signedIn: !off && state.login.state === "logged_in",
				state,
				models,
				inApp: PROVIDER_IN_APP[provider],
			};
		}),
	);
}

/** The models of each provider that is on and signed in: what a step can run on now. */
function availableModels(
	views: ProviderView[],
): Partial<Record<ProviderId, ModelInfo[]>> {
	return Object.fromEntries(
		views.filter((v) => v.signedIn).map((v) => [v.provider, v.models]),
	);
}

interface Worker {
	settings: SettingsStore;
	subscriptions: Subscriptions;
	rebuild(): Promise<void>;
	runner: { poke(): void };
}

/**
 * Gives the steps without a model one from what is available now (`autoFill`), saves and
 * rebuilds when any was filled. `only` limits it to some steps.
 */
export async function fillSteps(
	w: Worker,
	views: ProviderView[],
	only?: readonly Role[],
): Promise<Role[]> {
	const settings = await w.settings.get("ai");
	const { settings: next, filled } = autoFill({
		settings,
		available: availableModels(views),
		only,
	});
	if (filled.length) {
		await w.settings.set("ai", next as AiSettings);
		await w.rebuild();
		w.runner.poke();
	}
	return filled;
}

/**
 * The steps an earlier version ran on an API key, from the stored `ai` row as it is (the read
 * moves them to no model; this row keeps the old shape until the choice is written again).
 */
export function apiKeySteps(stored: unknown): Role[] {
	if (!stored || typeof stored !== "object") return [];
	const roles = stored as Record<string, unknown>;
	return ROLES.filter((role) => {
		const value = roles[role];
		return (
			Boolean(value) &&
			typeof value === "object" &&
			(value as { mode?: unknown }).mode === "api"
		);
	});
}

/**
 * Keys are gone (docs/model-providers.md): at start, a step an earlier version ran on an API key
 * is noted once for Settings › Models' notice (in `open`, before anything writes the choice).
 */
export async function noteRemovedKeys(
	settings: SettingsStore,
): Promise<Role[]> {
	const steps = apiKeySteps(await settings.raw("ai"));
	if (steps.length && (await settings.get("keysRemoved")) === null)
		await settings.set("keysRemoved", { steps, dismissed: false });
	return steps;
}

/**
 * After the CLIs are found: the key steps that still have no model get one from what is
 * available. Until one is filled or chosen, the stored row keeps its key mode and the next start
 * tries again.
 */
export async function fillKeySteps(w: Worker): Promise<Role[]> {
	const steps = apiKeySteps(await w.settings.raw("ai"));
	if (!steps.length) return [];
	return fillSteps(w, await providerViews(w.subscriptions), steps);
}

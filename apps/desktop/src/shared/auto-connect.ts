/**
 * Setup's Connect AI step fills the steps still without a model from what is signed in on this
 * computer. Pure, so the worker and the tests share it.
 */
import {
	CLAUDE_DEFAULTS,
	type Effort,
	FAKE_PROVIDER,
	formatModelRef,
	type ModelInfo,
	type ModelRef,
	PROVIDER_IDS,
	type ProviderId,
	parseModelRef,
	ROLES,
	type Role,
} from "./providers";

export type { Role } from "./providers";

type RoleChoice = { model: ModelRef | null; effort?: Effort };
export type AiChoice = Record<Role, RoleChoice>;

/**
 * The provider and model a step without a model gets from what is available: Claude's default
 * for the step when Claude is signed in, else the first plan model of the first provider that
 * has one (Codex, OpenCode, Gemini, in that order). A pay-per-use model is never picked by
 * itself: it costs money, so the user chooses it.
 */
function startingRef(
	available: Partial<Record<ProviderId, ModelInfo[]>>,
	role: Role,
): ModelRef | null {
	if (available.claude?.length)
		return formatModelRef("claude", CLAUDE_DEFAULTS[role]);
	for (const provider of PROVIDER_IDS) {
		const model = available[provider]?.find(
			(m) => m.billing === "subscription",
		);
		if (model) return model.ref;
	}
	return null;
}

/**
 * Fills every step without a model from the models available now (`available`: the models of
 * each provider that is on and signed in): all three on Claude when it is signed in, else on
 * the first plan model found. Any model may do any step, the same one included. A step the
 * user chose a model for is never changed; `only` limits the fill to some steps.
 */
export function autoFill(input: {
	settings: AiChoice;
	available: Partial<Record<ProviderId, ModelInfo[]>>;
	only?: readonly Role[];
}): { settings: AiChoice; filled: Role[] } {
	const next: AiChoice = { ...input.settings };
	const filled: Role[] = [];
	for (const role of input.only ?? ROLES) {
		if (next[role].model !== null) continue;
		const model = startingRef(input.available, role);
		if (!model) continue;
		next[role] = { model };
		filled.push(role);
	}
	return { settings: next, filled };
}

/** The provider a stored choice runs on, or null for none (and the test models). */
export function providerOfRef(ref: string | null): ProviderId | null {
	if (!ref) return null;
	const parsed = parseModelRef(ref);
	return parsed && parsed.provider !== FAKE_PROVIDER ? parsed.provider : null;
}

/**
 * Whether each step can run now: its configuration is ready (`ready`, from the worker) and its
 * provider is signed in. A choice stays the user's when the provider is gone or signed out; it
 * is just not ready until it is back. The test models need no sign-in.
 */
export function readyNow<
	R extends { role: Role; model: string | null; ready: boolean },
>(roles: R[], signedIn: Partial<Record<ProviderId, boolean>>): R[] {
	return roles.map((r) => {
		const provider = providerOfRef(r.model);
		return {
			...r,
			ready: r.ready && (provider === null || Boolean(signedIn[provider])),
		};
	});
}

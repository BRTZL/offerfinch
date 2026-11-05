/**
 * Setup's Connect AI step fills the steps still without a model from what is signed in on this
 * computer. Pure, so the worker and the tests share it.
 */
import {
	CLAUDE_DEFAULTS,
	type Effort,
	FAKE_PROVIDER,
	formatModelRef,
	type ModelRef,
	type ProviderId,
	parseModelRef,
	ROLES,
	type Role,
} from "./providers";

export type { Role } from "./providers";

type RoleChoice = { model: ModelRef | null; effort?: Effort };
export type AiChoice = Record<Role, RoleChoice>;

/** What a signed-in provider gives a step that has no model yet. */
function defaultRef(provider: "claude" | "codex", role: Role): ModelRef {
	return provider === "claude"
		? formatModelRef("claude", CLAUDE_DEFAULTS[role])
		: // The account's default Codex model.
			formatModelRef("codex", "");
}

/**
 * Fills every step without a model: all three on Claude when Claude Code is signed in, else all
 * three on Codex. Any model may do any step, the same one included. A step the user chose a
 * model for is never changed.
 */
export function autoFill(input: {
	settings: AiChoice;
	signedIn: Partial<Record<ProviderId, boolean>>;
}): { settings: AiChoice; filled: Role[] } {
	const provider = input.signedIn.claude
		? "claude"
		: input.signedIn.codex
			? "codex"
			: null;
	const next: AiChoice = { ...input.settings };
	const filled: Role[] = [];
	if (!provider) return { settings: next, filled };
	for (const role of ROLES) {
		if (next[role].model !== null) continue;
		next[role] = { model: defaultRef(provider, role) };
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

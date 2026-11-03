/**
 * Setup's Connect AI step picks Claude Code and Codex by itself when they are on this Mac and
 * signed in to a plan. Pure, so the worker and the tests share it.
 */

export type Role = "scoring" | "tailoring" | "claims";
export type Mode =
	| "api"
	| "claude-subscription"
	| "codex-subscription"
	| "fake";

const ROLE_KEYS: readonly Role[] = ["scoring", "tailoring", "claims"];

/** Which choices a role can take: the claims check stays on another vendor than tailoring. */
export function unavailable(role: Role, mode: Mode): string | null {
	if (role === "claims" && mode === "claude-subscription")
		return "Drafting uses Claude, so Claude cannot check its drafts";
	if (role !== "claims" && mode === "codex-subscription")
		return "Codex only checks drafts";
	return null;
}

type RoleSettings = { mode: Mode; model?: string; effort?: string };
export type AiChoice = Record<Role, RoleSettings>;

/**
 * A role is still open when it is on the default (an API key) and no key is stored for its
 * vendor: a stored key, test models or a subscription are the user's choice and stay.
 */
function open(
	role: Role,
	settings: AiChoice,
	keys: { anthropic: boolean; openai: boolean },
): boolean {
	if (settings[role].mode !== "api") return false;
	return role === "claims" ? !keys.openai : !keys.anthropic;
}

/**
 * The roles a signed-in Claude Code and Codex fill: Claude finds matches and drafts, Codex
 * checks drafts. Only open roles are filled, and never with a choice `unavailable` refuses.
 */
export function autoFill(input: {
	settings: AiChoice;
	claude: boolean;
	codex: boolean;
	keys: { anthropic: boolean; openai: boolean };
}): { settings: AiChoice; filled: Role[] } {
	const next: AiChoice = { ...input.settings };
	const filled: Role[] = [];
	for (const role of ROLE_KEYS) {
		const mode: Mode | null =
			role === "claims"
				? input.codex
					? "codex-subscription"
					: null
				: input.claude
					? "claude-subscription"
					: null;
		if (!mode || unavailable(role, mode)) continue;
		if (!open(role, input.settings, input.keys)) continue;
		// The model and effort belonged to the API choice; the plan's defaults apply.
		next[role] = { mode };
		filled.push(role);
	}
	return { settings: next, filled };
}

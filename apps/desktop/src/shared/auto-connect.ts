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

type RoleSettings = { mode: Mode; model?: string; effort?: string };
export type AiChoice = Record<Role, RoleSettings>;

/** The two model companies: Anthropic (Claude) and OpenAI (Codex, ChatGPT). */
export type Vendor = "anthropic" | "openai";

const VENDOR_NAME: Record<Vendor, string> = {
	anthropic: "Claude",
	openai: "OpenAI",
};

/** The company drafts are written by, or null on test models. */
export function draftingVendor(settings: Pick<AiChoice, "tailoring">) {
	return vendorOf("tailoring", settings.tailoring.mode, null);
}

/**
 * The company a role's choice runs on; null for test models. An API key is Anthropic's for
 * finding matches and drafting. For checking drafts it is the other company's than drafting:
 * OpenAI's while drafts are Claude's, Anthropic's while they are OpenAI's.
 */
export function vendorOf(
	role: Role,
	mode: Mode,
	drafting: Vendor | null,
): Vendor | null {
	if (mode === "fake") return null;
	if (mode === "claude-subscription") return "anthropic";
	if (mode === "codex-subscription") return "openai";
	if (role !== "claims") return "anthropic";
	return drafting === "openai" ? "anthropic" : "openai";
}

/**
 * Why a role cannot take a choice, or null. A draft is never checked by the company that wrote
 * it, so checking drafts must stay on the other company than drafting. Without the rest of the
 * settings, nothing is refused.
 */
export function unavailable(
	role: Role,
	mode: Mode,
	settings?: AiChoice,
): string | null {
	if (!settings) return null;
	if (role === "claims") {
		const drafting = draftingVendor(settings);
		if (drafting && vendorOf("claims", mode, drafting) === drafting)
			return `Drafts are written by ${VENDOR_NAME[drafting]}, so ${VENDOR_NAME[drafting]} can't check them`;
		return null;
	}
	if (role === "tailoring") {
		const drafting = vendorOf("tailoring", mode, null);
		const checkMode = settings.claims.mode;
		// An API-key checker follows drafting to the other company; a plan does not.
		if (
			drafting &&
			checkMode !== "api" &&
			vendorOf("claims", checkMode, drafting) === drafting
		)
			return `Drafts are checked by ${VENDOR_NAME[drafting]}. Choose another checker first`;
	}
	return null;
}

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
	const vendor = vendorOf(role, "api", draftingVendor(settings));
	return vendor === "openai" ? !keys.openai : !keys.anthropic;
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
		if (!mode || unavailable(role, mode, next)) continue;
		if (!open(role, next, input.keys)) continue;
		// The model and effort belonged to the API choice; the plan's defaults apply.
		next[role] = { mode };
		filled.push(role);
	}
	return { settings: next, filled };
}

/**
 * Whether each role can run now: its configuration is ready (`ready`, from the worker) and, on a
 * plan, that plan's CLI is installed and signed in. A subscription choice stays the user's when
 * the CLI is gone or signed out; it is just not ready until it is back.
 */
export function readyNow<
	R extends { role: Role; mode: string; ready: boolean },
>(roles: R[], signedIn: { claude: boolean; codex: boolean }): R[] {
	return roles.map((r) => ({
		...r,
		ready:
			r.ready &&
			(r.mode === "claude-subscription"
				? signedIn.claude
				: r.mode === "codex-subscription"
					? signedIn.codex
					: true),
	}));
}

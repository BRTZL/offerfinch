/**
 * What Settings › Models shows for each model role: the provider, how it is paid for,
 * and for a subscription its login, from non-secret fields only.
 */
export interface LlmLoginState {
	state:
		| "logged_in"
		| "logged_out"
		| "not_subscription"
		| "refused"
		| "unknown";
	/** Plain words: plan, token source, what to do. Never a token, key or email. */
	detail: string;
}

interface LlmRoleStatus {
	role: "scoring" | "tailoring" | "claims";
	/** The provider and model, e.g. "claude-subscription:claude-sonnet-5-5". */
	provider: string;
	billing: "api" | "subscription";
	login: LlmLoginState | null;
}

export interface LlmStatus {
	roles: LlmRoleStatus[];
	/** True when this runtime can run subscription providers, as the desktop worker does. */
	local: boolean;
	/** The account subscription models answer for, when configured. */
	subscriptionUserId: string | null;
	/** Credential variables kept out of the subscription CLIs (names only). */
	removedEnv: string[];
	/** Where Claude Code's login is read from (a path, not a secret), when set. */
	claudeConfigDir: string | null;
	/**
	 * What codex-subscription is and how it runs (the name predates it: it held the refusal).
	 * The desktop app may still put its own "not available" text here.
	 */
	codexRefusal: string;
	codexLogin: string | null;
}

/**
 * The environment a subscription CLI (Claude Code, Codex) is started with. Built from an
 * allowlist, never by copying `process.env` and deleting keys: an SDK given ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, a cloud-provider switch (CLAUDE_CODE_USE_BEDROCK, ...), a base URL or a parent
 * agent's session variables may silently bill an API account or attach to another session.
 */

/** Variables the CLIs need to start and find the user's own login (keychain, home directory). */
const PASSED = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TMPDIR",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
] as const;

/**
 * Where Claude Code keeps its login. Passed through only when set, because it decides which
 * account is found; `llm:status` prints it.
 */
const CLAUDE_CONFIG_DIR = "CLAUDE_CONFIG_DIR";

/**
 * Names that look like credentials, provider switches or debug and Node controls (a debug log
 * would hold the prompt): reported (by name only) as removed.
 */
const CREDENTIAL_PATTERN =
	/(^ANTHROPIC_|^OPENAI_|^CODEX_|^CLAUDE_CODE_USE_|API_KEY|_TOKEN$|^AWS_|^GOOGLE_|^AZURE_|^VERTEX|BEDROCK|^DEBUG|^NODE_OPTIONS$)/;

export interface SubscriptionEnv {
	env: Record<string, string>;
	/** Credential-like and debug variables present in the parent and left out (names only). */
	removed: string[];
}

export function subscriptionEnv(
	parent: Record<string, string | undefined> = process.env,
	extra: Record<string, string> = {},
): SubscriptionEnv {
	const env: Record<string, string> = {};
	for (const key of [...PASSED, CLAUDE_CONFIG_DIR]) {
		const value = parent[key];
		if (value) env[key] = value;
	}
	Object.assign(env, extra);
	const removed = Object.keys(parent)
		.filter((key) => !(key in env) && CREDENTIAL_PATTERN.test(key))
		.sort();
	return { env, removed };
}

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

/** Windows startup and login locations must not enter POSIX CLI environments. */
const WINDOWS_PASSED = [
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"SystemRoot",
	"SystemDrive",
	"WINDIR",
	"ComSpec",
	"PATHEXT",
	"TEMP",
	"TMP",
	"USERNAME",
	"HOMEDRIVE",
	"HOMEPATH",
	"ProgramData",
	"ProgramFiles",
	"ProgramFiles(x86)",
	"CLAUDE_CODE_GIT_BASH_PATH",
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
	platform: NodeJS.Platform = process.platform,
): SubscriptionEnv {
	const env: Record<string, string> = {};
	for (const key of [
		...PASSED,
		...(platform === "win32" ? WINDOWS_PASSED : []),
		CLAUDE_CONFIG_DIR,
	]) {
		const value = envValue(parent, key, platform);
		if (value) env[key] = value;
	}
	for (const [key, value] of Object.entries(extra)) {
		if (platform === "win32") {
			for (const existing of Object.keys(env)) {
				if (existing.toUpperCase() === key.toUpperCase()) delete env[existing];
			}
		}
		env[platform === "win32" && key.toUpperCase() === "PATH" ? "PATH" : key] =
			value;
	}
	// A private TMPDIR must also cover Windows APIs that use TEMP or TMP.
	if (platform === "win32" && env.TMPDIR) {
		env.TEMP = env.TMPDIR;
		env.TMP = env.TMPDIR;
	}
	const removed = Object.keys(parent)
		.filter(
			(key) =>
				!(key in env) &&
				CREDENTIAL_PATTERN.test(platform === "win32" ? key.toUpperCase() : key),
		)
		.sort();
	return { env, removed };
}

/** Windows environment records are case-insensitive, including plain copied objects. */
export function envValue(
	parent: Record<string, string | undefined>,
	key: string,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	return (
		parent[key] ??
		(platform === "win32"
			? parent[
					Object.keys(parent).find(
						(name) => name.toUpperCase() === key.toUpperCase(),
					) ?? ""
				]
			: undefined)
	);
}

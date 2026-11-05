import { execFile } from "node:child_process";
import path from "node:path";
import type { LlmLoginState } from "@offerfinch/core/scoring/llm-status";
import type { PlanSnapshot } from "@offerfinch/core/scoring/plan-usage";

import { probeExtraUsage } from "./claude";
import {
	CODEX_MACOS_ONLY,
	type CodexTurnInput,
	type CodexTurnResult,
	codexAuthFile,
	readCodexLogin,
	runCodexTurn,
} from "./codex";
import { envValue, subscriptionEnv } from "./env";
import { type ClaudeQuery, isolatedQuery } from "./isolated";
import { claudeUsageSnapshot, codexUsageSnapshot } from "./plan-usage";

/** A login state with the plan's usage as the same read reported it (null: not read). */
export type LoginWithUsage = LlmLoginState & { planUsage: PlanSnapshot | null };

/**
 * Claude Code's login as a subscription call would find it: the same options and environment,
 * started and closed without a prompt, so no model request is made.
 */
export async function claudeLogin(
	parentEnv: Record<string, string | undefined> = process.env,
	query: ClaudeQuery = isolatedQuery,
	now: () => Date = () => new Date(),
): Promise<LoginWithUsage> {
	try {
		// The same probe a call makes before its prompt: login and the plan's usage, nothing sent.
		const { auth, extra, account, usage } = await probeExtraUsage(
			query,
			"claude-sonnet-5-5",
			subscriptionEnv(parentEnv).env,
		);
		const planUsage = usage
			? claudeUsageSnapshot(usage, now(), account?.subscriptionType ?? null)
			: null;
		const plan = account
			? [
					account.subscriptionType ? `plan ${account.subscriptionType}` : null,
					account.tokenSource ? `token from ${account.tokenSource}` : null,
					account.apiKeySource
						? `API key source ${account.apiKeySource}`
						: null,
					account.apiProvider ? `backend ${account.apiProvider}` : null,
				]
					.filter(Boolean)
					.join(", ")
			: "";
		if (!account && auth)
			return { state: "unknown", detail: auth.detail, planUsage };
		if (!auth)
			return {
				state: "logged_in",
				detail: `Claude subscription (${plan}); ${extra.detail}`,
				extraUsage: extra.state,
				planUsage,
			};
		return {
			state: auth.kind === "logged_out" ? "logged_out" : "not_subscription",
			detail: `${auth.detail}${plan ? ` (${plan})` : ""}`,
			planUsage,
		};
	} catch (error) {
		return {
			state: "unknown",
			detail: `Claude Code did not report its login: ${error instanceof Error ? error.message : String(error)}`,
			planUsage: null,
		};
	}
}

/**
 * The ChatGPT plan's Codex usage, read as a call reads it before its prompt: a locked-down
 * `codex app-server` in a private temp root signs in with the user's token, reads
 * `account/rateLimits/read`, and stops; no thread, no prompt. Null when the CLI could not
 * report it, with why.
 */
export async function codexPlanUsage(input: {
	binary: string;
	parentEnv?: Record<string, string | undefined>;
	now?: () => Date;
	/** Tests only: stands in for `runCodexTurn`. */
	runTurn?: (turn: CodexTurnInput) => Promise<CodexTurnResult>;
}): Promise<{ snapshot: PlanSnapshot | null; error: string | null }> {
	if (process.platform === "win32")
		return { snapshot: null, error: CODEX_MACOS_ONLY };
	const parentEnv = input.parentEnv ?? process.env;
	const now = input.now ?? (() => new Date());
	const read = await readCodexLogin(codexAuthFile(parentEnv), now());
	if (!read.ok) return { snapshot: null, error: read.detail };
	try {
		const result = await (input.runTurn ?? runCodexTurn)({
			binary: input.binary,
			auth: {
				type: "chatgpt",
				login: read.login,
				authFile: codexAuthFile(parentEnv),
			},
			system: "",
			prompt: "",
			parentEnv,
			timeoutMs: 30_000,
			creditsOnly: true,
		});
		if (result.boundary) return { snapshot: null, error: result.boundary };
		if (result.turnError)
			return { snapshot: null, error: result.turnError.message };
		const snapshot =
			result.rateLimitsBefore &&
			codexUsageSnapshot(result.rateLimitsBefore, now());
		return {
			snapshot,
			error: snapshot ? null : "Codex did not report the plan's usage.",
		};
	} catch (error) {
		return {
			snapshot: null,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * codex-subscription's login as a call would find it: Codex's ChatGPT access token, read only
 * (no CLI started, nothing refreshed or written, no part of the token returned).
 */
export async function codexSubscriptionLogin(
	parentEnv: Record<string, string | undefined> = process.env,
): Promise<LlmLoginState> {
	if (process.platform === "win32")
		return { state: "unknown", detail: CODEX_MACOS_ONLY };
	const file = codexAuthFile(parentEnv);
	const read = await readCodexLogin(file);
	if (!read.ok)
		return {
			state:
				read.kind === "not_subscription" ? "not_subscription" : "logged_out",
			detail: read.detail,
		};
	return {
		state: "logged_in",
		detail: `ChatGPT plan ${read.login.planType ?? "unknown"} (read from ${file}); access token valid until ${read.login.expiresAt?.toISOString() ?? "unknown"}, refreshed by Codex itself. Credits and usage are checked before each call.`,
	};
}

/**
 * PATH as the user's login shell sets it. A GUI app (the desktop app) starts with launchd's
 * minimal PATH, which usually lacks `codex` and `claude`; T3 Code resolves it the same way
 * (`$SHELL -ilc`, apps/desktop/src/shell/DesktopShellEnvironment.ts there). Null on failure.
 */
export function loginShellPath(
	shell: string = process.env.SHELL || "/bin/zsh",
	timeoutMs = 5000,
	platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
	if (platform === "win32") {
		const root = envValue(process.env, "SystemRoot", platform);
		if (!root || !path.win32.isAbsolute(root)) return Promise.resolve(null);
		return new Promise((resolve) => {
			execFile(
				path.win32.join(
					root,
					"System32",
					"WindowsPowerShell",
					"v1.0",
					"powershell.exe",
				),
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); [Environment]::GetEnvironmentVariable('Path','User'); [Environment]::GetEnvironmentVariable('Path','Machine')",
				],
				{ timeout: timeoutMs, env: subscriptionEnv().env },
				(error, stdout) => {
					if (error) return resolve(null);
					const dirs = [
						envValue(process.env, "PATH", platform) ?? "",
						...String(stdout).trim().split(/\r?\n/),
					]
						.join(";")
						.split(";")
						.filter(Boolean);
					resolve(
						[
							...new Map(dirs.map((dir) => [dir.toLowerCase(), dir])).values(),
						].join(";") || null,
					);
				},
			);
		});
	}
	const start = "__OFFERFINCH_PATH_START__";
	const end = "__OFFERFINCH_PATH_END__";
	return new Promise((resolve) => {
		execFile(
			shell,
			["-ilc", `printf '%s%s%s' '${start}' "$PATH" '${end}'`],
			{
				timeout: timeoutMs,
				env: {
					HOME: process.env.HOME ?? "",
					USER: process.env.USER ?? "",
					SHELL: shell,
					TERM: "dumb",
				},
			},
			(error, stdout) => {
				const match = new RegExp(`${start}(.*?)${end}`, "s").exec(
					String(stdout),
				);
				resolve(error && !match ? null : match?.[1]?.trim() || null);
			},
		);
	});
}

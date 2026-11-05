import { type ChildProcess, execFile, fork } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type {
	AccountInfo,
	SDKControlGetUsageResponse,
	SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
	type GenerateObjectRequest,
	type LlmProvider,
	SubscriptionUnavailableError,
} from "@offerfinch/core/scoring/llm";
import type { LlmLoginState } from "@offerfinch/core/scoring/llm-status";
import type { PlanUsageSink } from "@offerfinch/core/scoring/plan-usage";
import {
	CLAUDE_SUBSCRIPTION,
	ClaudeSubscriptionProvider,
	CODEX_SUBSCRIPTION,
	CodexSubscriptionProvider,
	claudeLogin,
	codexPlanUsage,
	codexSubscriptionLogin,
	loginShellPath,
	subscriptionEnv,
} from "@offerfinch/local-llm";
import { findCliOnPath } from "@offerfinch/local-llm/cli-path";
import { CODEX_MACOS_ONLY } from "@offerfinch/local-llm/codex";
import { envValue } from "@offerfinch/local-llm/env";
import type {
	ClaudeQuery,
	ClaudeSession,
} from "@offerfinch/local-llm/isolated";
import {
	EFFORTS,
	formatModelRef,
	type ModelInfo,
	PROVIDER_NAMES,
	type ProviderId,
} from "../shared/providers";
import type { LocalLlmFactory } from "./model-factories";

/**
 * The subscription CLIs from a GUI app. macOS starts the app with launchd's minimal PATH, which
 * lacks `claude` and `codex`; PATH is read from the user's login shell (`loginShellPath`, as T3
 * Code does), with the usual install folders as a fallback, and given to every CLI started.
 */
export function fallbackDirs(
	platform: NodeJS.Platform = process.platform,
	env = process.env,
): string[] {
	if (platform === "win32") {
		const home = envValue(env, "USERPROFILE", platform);
		const app = envValue(env, "APPDATA", platform);
		const local = envValue(env, "LOCALAPPDATA", platform);
		return [
			...(home
				? [".local\\bin", ".claude\\local", ".bun\\bin", "scoop\\shims"].map(
						(dir) => path.win32.join(home, dir),
					)
				: []),
			...(app ? [path.win32.join(app, "npm")] : []),
			...(local
				? [
						path.win32.join(local, "pnpm"),
						path.win32.join(local, "Volta", "bin"),
					]
				: []),
		];
	}
	return [
		path.join(os.homedir(), ".local/bin"),
		path.join(os.homedir(), ".claude/local"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		path.join(os.homedir(), ".npm-global/bin"),
		path.join(os.homedir(), ".bun/bin"),
	];
}

/** The login shell's PATH with this process's and the usual install folders after it. */
async function resolvedPath(): Promise<string> {
	return mergePath(await loginShellPath());
}

export function mergePath(
	login: string | null,
	platform: NodeJS.Platform = process.platform,
	env = process.env,
): string {
	const delimiter =
		platform === "win32" ? path.win32.delimiter : path.delimiter;
	const dirs = [
		...(login ?? "").split(delimiter),
		...(envValue(env, "PATH", platform) ?? "").split(delimiter),
		...fallbackDirs(platform, env),
	].filter(Boolean);
	return [
		...new Map(
			dirs.map((dir) => [platform === "win32" ? dir.toLowerCase() : dir, dir]),
		).values(),
	].join(delimiter);
}

function version(
	binary: string,
	env: NodeJS.ProcessEnv,
): Promise<string | null> {
	return new Promise((resolve) =>
		execFile(
			binary,
			["--version"],
			{ env: subscriptionEnv(env).env, timeout: 10_000 },
			(error, stdout) =>
				resolve(error ? null : String(stdout).trim().split("\n")[0] || null),
		),
	);
}

/** Pinned SDK's bundled CLI, the one the boundary tests ran against. */
const CLAUDE_TESTED = "2.1.315";
/** The Codex CLI version the layer tests ran against. */
const CODEX_TESTED = "0.166.0";

type FromHost =
	| { t: "ready" }
	| { t: "init"; result: { account: AccountInfo } }
	| { t: "init_error"; error: string }
	| { t: "message"; message: SDKMessage }
	| { t: "done" }
	| { t: "error"; error: string }
	| {
			t: "usage";
			id: number;
			result?: SDKControlGetUsageResponse;
			error?: string;
	  };

/**
 * `local-llm`'s isolated query for Electron: the same host script and IPC protocol, forked as
 * Node with Electron's own binary (ELECTRON_RUN_AS_NODE, the only variable added to the
 * allowlist), and the user's installed Claude Code as the CLI (the SDK's bundled one is 296 MB).
 */
function electronClaudeQuery(
	hostScript: string,
	claudeBinary: string,
): ClaudeQuery {
	return ({ prompt, options }): ClaudeSession => {
		const { abortController, env: cliEnv, ...rest } = options;
		const { env: hostEnv } = subscriptionEnv(cliEnv ?? {});
		const child: ChildProcess = fork(hostScript, [], {
			execPath: process.execPath,
			env: { ...hostEnv, ELECTRON_RUN_AS_NODE: "1" },
			execArgv: [],
			serialization: "advanced",
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		const queue: SDKMessage[] = [];
		let ended = false;
		let failure: Error | null = null;
		let wake: () => void = () => {};
		let resolveInit: (value: { account: AccountInfo }) => void = () => {};
		let rejectInit: (error: Error) => void = () => {};
		const init = new Promise<{ account: AccountInfo }>((resolve, reject) => {
			resolveInit = resolve;
			rejectInit = reject;
		});
		init.catch(() => {});
		const usageCalls = new Map<
			number,
			{
				resolve: (v: SDKControlGetUsageResponse) => void;
				reject: (e: Error) => void;
			}
		>();
		let usageId = 0;
		const finish = (error: Error | null) => {
			if (ended) return;
			ended = true;
			failure = error;
			if (error) rejectInit(error);
			for (const call of usageCalls.values())
				call.reject(error ?? new Error("the session ended"));
			usageCalls.clear();
			wake();
		};
		const post = (message: Record<string, unknown>) => {
			if (child.connected) child.send(message);
		};
		child.on("message", (raw: FromHost) => {
			if (raw.t === "init") resolveInit(raw.result);
			else if (raw.t === "init_error") rejectInit(new Error(raw.error));
			else if (raw.t === "message") {
				queue.push(raw.message);
				wake();
			} else if (raw.t === "done") finish(null);
			else if (raw.t === "error") finish(new Error(raw.error));
			else if (raw.t === "usage") {
				const call = usageCalls.get(raw.id);
				usageCalls.delete(raw.id);
				if (raw.result) call?.resolve(raw.result);
				else call?.reject(new Error(raw.error ?? "no usage answer"));
			}
		});
		child.on("error", (error) => finish(error));
		child.on("exit", (code, signal) =>
			finish(
				ended
					? null
					: new Error(
							`the Claude Agent SDK host exited (${signal ?? `code ${code}`}) before the session ended`,
						),
			),
		);
		post({
			t: "start",
			options: {
				...rest,
				env: cliEnv,
				pathToClaudeCodeExecutable: claudeBinary,
			},
		});
		void (async () => {
			try {
				for await (const message of prompt) post({ t: "prompt", message });
			} finally {
				post({ t: "end_input" });
			}
		})();
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			post({ t: "close" });
			const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
			timer.unref();
			child.once("exit", () => clearTimeout(timer));
			finish(null);
		};
		abortController?.signal.addEventListener("abort", close, { once: true });
		async function* messages(): AsyncGenerator<SDKMessage> {
			while (true) {
				const next = queue.shift();
				if (next !== undefined) {
					yield next;
					continue;
				}
				if (ended) {
					if (failure) throw failure;
					return;
				}
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			}
		}
		const stream = messages();
		return {
			[Symbol.asyncIterator]: () => stream,
			initializationResult: () => init,
			usage: () =>
				new Promise<SDKControlGetUsageResponse>((resolve, reject) => {
					if (ended) {
						reject(new Error("the session ended"));
						return;
					}
					const id = ++usageId;
					usageCalls.set(id, { resolve, reject });
					post({ t: "usage", id });
				}),
			close,
		};
	};
}

/** What to run in Terminal to install a CLI or sign in to it. */
export interface CliFix {
	kind: "install" | "login";
	/** One line to paste in Terminal. */
	command: string;
	/** What to do once it runs, when the command alone is not enough. */
	after: string | null;
}

/** The commands the app and its docs give for Claude Code and the Codex CLI. */
export const CLAUDE_FIX: Record<CliFix["kind"], CliFix> = {
	install: {
		kind: "install",
		command:
			process.platform === "win32"
				? "irm https://claude.ai/install.ps1 | iex"
				: "curl -fsSL https://claude.ai/install.sh | bash",
		after: "Then run claude, type /login and sign in with your Claude plan.",
	},
	login: {
		kind: "login",
		command: "claude",
		after: "Then type /login and sign in with your Claude plan.",
	},
};
export const CODEX_FIX: Record<CliFix["kind"], CliFix> = {
	install: {
		kind: "install",
		command: "npm install -g @openai/codex",
		after: "Then run codex login and sign in with your ChatGPT plan.",
	},
	login: {
		kind: "login",
		command: "codex login",
		after: "Sign in with your ChatGPT plan.",
	},
};

export interface CliState {
	/** The binary found on the login shell's PATH, or null. */
	path: string | null;
	version: string | null;
	tested: string;
	login: LlmLoginState;
	/** What to run in Terminal when it is not ready. */
	command: string | null;
	/** The same, as a command to copy and what to do after it. */
	fix: CliFix | null;
}

/** The CLI checks and the factory each run has (real, test stand-ins, try-it mode). */
export interface CliChecks {
	/**
	 * Re-reads PATH from the login shell (seconds with a heavy shell profile) and finds the
	 * CLIs. Returns the PATH, so it can be cached for the next start.
	 */
	refresh(): Promise<string>;
	/** Uses a known PATH now (the one cached from the last start), without starting a shell. */
	usePath(pathEnv: string): void;
	factory: LocalLlmFactory;
	/**
	 * Each CLI's state, kept for a minute. The read also reports the plan's usage to the plan
	 * usage tracker. `fresh`: read again now (Refresh in Settings › Models).
	 */
	claude(options?: { fresh?: boolean }): Promise<CliState>;
	codex(options?: { fresh?: boolean }): Promise<CliState>;
}

export interface Subscriptions extends CliChecks {
	/** A provider's state: installed where, which version against the tested one, signed in. */
	state(provider: ProviderId, options?: { fresh?: boolean }): Promise<CliState>;
	/** The models a provider offers, whether or not it is signed in now. */
	models(provider: ProviderId): Promise<ModelInfo[]>;
}

/** Claude's models on the plan: the defaults the steps use, and Haiku. */
const CLAUDE_MODELS: ModelInfo[] = [
	["claude-opus-5-5", "Claude Opus 5.5"],
	["claude-sonnet-5-5", "Claude Sonnet 5.5"],
	["claude-haiku-5-5", "Claude Haiku 5.5"],
].map(([id, name]) => ({
	ref: formatModelRef("claude", id as string),
	name: name as string,
	provider: "claude",
	billing: "subscription",
	efforts: [...EFFORTS],
}));

/**
 * Codex's models on the plan: the account's default (empty model, what Codex picks for the
 * plan), then the known ones. The app-server's own list is not read yet (it would start the CLI
 * for a list).
 */
const CODEX_MODELS: ModelInfo[] = [
	["", "Codex account default"],
	["gpt-6.1-sol", "GPT-6.1 Sol"],
	["gpt-6.1-terra", "GPT-6.1 Terra"],
].map(([id, name]) => ({
	ref: formatModelRef("codex", id as string),
	name: name as string,
	provider: "codex",
	billing: "subscription",
	efforts: [...EFFORTS],
}));

/** A provider this version does not run yet: not installed, nothing to offer. */
function notInstalled(provider: ProviderId): CliState {
	return {
		path: null,
		version: null,
		tested: "",
		login: {
			state: "logged_out",
			detail: `${PROVIDER_NAMES[provider]} is not installed.`,
		},
		command: null,
		fix: null,
	};
}

/** `state` and `models` for every provider, on top of a run's CLI checks. */
export function withProviders(checks: CliChecks): Subscriptions {
	return {
		...checks,
		state: (provider, options) =>
			provider === "claude"
				? checks.claude(options)
				: provider === "codex"
					? checks.codex(options)
					: Promise.resolve(notInstalled(provider)),
		models: async (provider) =>
			provider === "claude"
				? CLAUDE_MODELS
				: provider === "codex"
					? CODEX_MODELS
					: [],
	};
}

/** A role whose CLI is missing: its calls pause with what to install, never fail. */
class MissingCli implements LlmProvider {
	readonly billing = "subscription" as const;
	constructor(
		readonly name: string,
		readonly vendor: string,
		private readonly detail: string,
		private readonly kind: "boundary" | "logged_out" = "logged_out",
	) {}
	async generateObject<T>(_request: GenerateObjectRequest<T>): Promise<T> {
		throw new SubscriptionUnavailableError(this.kind, this.name, this.detail);
	}
}

/** The subscription providers and their login checks, for the worker. */
export function subscriptions(input: {
	hostScript: string;
	log?: (message: string, data?: Record<string, unknown>) => void;
	/** Where every read of a plan's usage goes (Settings › Models). */
	planUsage?: (vendor: "anthropic" | "openai") => PlanUsageSink;
}): Subscriptions {
	let env: Record<string, string | undefined> = { ...process.env };
	let claudeBinary: string | null = null;
	let codexBinary: string | null = null;
	let claudeCache: { at: number; state: CliState } | null = null;
	let codexCache: { at: number; state: CliState } | null = null;
	const fresh = (c: { at: number } | null) => c && Date.now() - c.at < 60_000;
	const usePath = (pathEnv: string) => {
		env = { ...process.env, PATH: pathEnv };
		claudeBinary = findCliOnPath("claude", pathEnv);
		codexBinary = findCliOnPath("codex", pathEnv);
		claudeCache = null;
		codexCache = null;
	};
	usePath(mergePath(null));
	return withProviders({
		usePath,
		async refresh() {
			const pathEnv = await resolvedPath();
			usePath(pathEnv);
			return pathEnv;
		},
		factory: ({ provider, model, effort, ownerUserId }) => {
			if (provider === "claude")
				return claudeBinary
					? new ClaudeSubscriptionProvider({
							model,
							effort,
							ownerUserId,
							parentEnv: env,
							log: input.log,
							query: electronClaudeQuery(input.hostScript, claudeBinary),
							planUsage: input.planUsage?.("anthropic"),
						})
					: new MissingCli(
							`${CLAUDE_SUBSCRIPTION}:${model}`,
							"anthropic",
							`Claude Code (claude) was not found. Install it (${CLAUDE_FIX.install.command}), run claude and log in with /login.`,
						);
			if (provider === "codex" && process.platform === "win32")
				return new MissingCli(
					`${CODEX_SUBSCRIPTION}:${model}`,
					"openai",
					CODEX_MACOS_ONLY,
					"boundary",
				);
			if (provider === "codex")
				return codexBinary
					? new CodexSubscriptionProvider({
							model,
							effort,
							ownerUserId,
							parentEnv: env,
							binary: codexBinary,
							log: input.log,
							planUsage: input.planUsage?.("openai"),
						})
					: new MissingCli(
							`${CODEX_SUBSCRIPTION}:${model || "default"}`,
							"openai",
							"The Codex CLI (`codex`) was not found. Install it (npm install -g @openai/codex), then run `codex login` in Terminal.",
						);
			return new MissingCli(
				`${provider}:${model}`,
				provider,
				`${PROVIDER_NAMES[provider]} models are not available in this version yet.`,
				"boundary",
			);
		},
		async claude(options = {}) {
			if (!options.fresh && fresh(claudeCache))
				return (claudeCache as { state: CliState }).state;
			const binary = claudeBinary;
			const state: CliState = binary
				? await (async () => {
						const { planUsage, ...login } = await claudeLogin(
							env,
							electronClaudeQuery(input.hostScript, binary),
						);
						if (planUsage) input.planUsage?.("anthropic").sample(planUsage);
						return {
							path: binary,
							version: await version(binary, env as NodeJS.ProcessEnv),
							tested: CLAUDE_TESTED,
							login,
							command:
								login.state === "logged_in"
									? null
									: "claude   (then type /login and sign in with your Claude plan)",
							fix: login.state === "logged_in" ? null : CLAUDE_FIX.login,
						};
					})()
				: {
						path: null,
						version: null,
						tested: CLAUDE_TESTED,
						login: {
							state: "logged_out",
							detail: "Claude Code is not installed.",
						},
						command: CLAUDE_FIX.install.command,
						fix: CLAUDE_FIX.install,
					};
			claudeCache = { at: Date.now(), state };
			return state;
		},
		async codex(options = {}) {
			if (process.platform === "win32")
				return {
					path: codexBinary,
					version: null,
					tested: CODEX_TESTED,
					login: { state: "unknown", detail: CODEX_MACOS_ONLY },
					command: null,
					fix: null,
				};
			if (!options.fresh && fresh(codexCache))
				return (codexCache as { state: CliState }).state;
			const binary = codexBinary;
			const login: LlmLoginState = binary
				? await codexSubscriptionLogin(env)
				: { state: "logged_out", detail: "The Codex CLI is not installed." };
			// Signed in: the plan's usage, as a call reads it before its prompt (no prompt here).
			if (binary && login.state === "logged_in" && input.planUsage) {
				const read = await codexPlanUsage({ binary, parentEnv: env });
				if (read.snapshot) input.planUsage("openai").sample(read.snapshot);
				else
					input.log?.("codex plan usage not read", {
						error: read.error,
					});
			}
			const state: CliState = {
				path: binary,
				version: binary
					? await version(binary, env as NodeJS.ProcessEnv)
					: null,
				tested: CODEX_TESTED,
				login,
				command: !binary
					? CODEX_FIX.install.command
					: login.state === "logged_in"
						? null
						: CODEX_FIX.login.command,
				fix: !binary
					? CODEX_FIX.install
					: login.state === "logged_in"
						? null
						: CODEX_FIX.login,
			};
			codexCache = { at: Date.now(), state };
			return state;
		},
	});
}

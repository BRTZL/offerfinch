import { type ChildProcess, execFile, fork } from "node:child_process";
import fs from "node:fs";
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
import {
	CLAUDE_SUBSCRIPTION,
	ClaudeSubscriptionProvider,
	CODEX_SUBSCRIPTION,
	CodexSubscriptionProvider,
	claudeLogin,
	codexSubscriptionLogin,
	loginShellPath,
	subscriptionEnv,
} from "@offerfinch/local-llm";
import type {
	ClaudeQuery,
	ClaudeSession,
} from "@offerfinch/local-llm/isolated";
import type { LocalLlmFactory } from "./model-factories";

/**
 * The subscription CLIs from a GUI app. macOS starts the app with launchd's minimal PATH, which
 * lacks `claude` and `codex`; PATH is read from the user's login shell (`loginShellPath`, as T3
 * Code does), with the usual install folders as a fallback, and given to every CLI started.
 */
const FALLBACK_DIRS = [
	path.join(os.homedir(), ".local/bin"),
	path.join(os.homedir(), ".claude/local"),
	"/opt/homebrew/bin",
	"/usr/local/bin",
	path.join(os.homedir(), ".npm-global/bin"),
	path.join(os.homedir(), ".bun/bin"),
];

/** The login shell's PATH with this process's and the usual install folders after it. */
async function resolvedPath(): Promise<string> {
	return mergePath(await loginShellPath());
}

function mergePath(login: string | null): string {
	const dirs = [
		...(login ?? "").split(path.delimiter),
		...(process.env.PATH ?? "").split(path.delimiter),
		...FALLBACK_DIRS,
	].filter(Boolean);
	return [...new Set(dirs)].join(path.delimiter);
}

function findOnPath(name: string, pathEnv: string): string | null {
	for (const dir of pathEnv.split(path.delimiter)) {
		const candidate = path.join(dir, name);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return fs.realpathSync(candidate);
		} catch {}
	}
	return null;
}

function version(
	binary: string,
	env: NodeJS.ProcessEnv,
): Promise<string | null> {
	return new Promise((resolve) =>
		execFile(binary, ["--version"], { env, timeout: 10_000 }, (error, stdout) =>
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
		command: "curl -fsSL https://claude.ai/install.sh | bash",
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

export interface Subscriptions {
	/**
	 * Re-reads PATH from the login shell (seconds with a heavy shell profile) and finds the
	 * CLIs. Returns the PATH, so it can be cached for the next start.
	 */
	refresh(): Promise<string>;
	/** Uses a known PATH now (the one cached from the last start), without starting a shell. */
	usePath(pathEnv: string): void;
	factory: LocalLlmFactory;
	claude(): Promise<CliState>;
	codex(): Promise<CliState>;
}

/** A role whose CLI is missing: its calls pause with what to install, never fail. */
class MissingCli implements LlmProvider {
	readonly billing = "subscription" as const;
	constructor(
		readonly name: string,
		readonly vendor: string,
		private readonly detail: string,
	) {}
	async generateObject<T>(_request: GenerateObjectRequest<T>): Promise<T> {
		throw new SubscriptionUnavailableError(
			"logged_out",
			this.name,
			this.detail,
		);
	}
}

/** The subscription providers and their login checks, for the worker. */
export function subscriptions(input: {
	hostScript: string;
	log?: (message: string, data?: Record<string, unknown>) => void;
}): Subscriptions {
	let env: Record<string, string | undefined> = { ...process.env };
	let claudeBinary: string | null = null;
	let codexBinary: string | null = null;
	let claudeCache: { at: number; state: CliState } | null = null;
	let codexCache: { at: number; state: CliState } | null = null;
	const fresh = (c: { at: number } | null) => c && Date.now() - c.at < 60_000;
	const usePath = (pathEnv: string) => {
		env = { ...process.env, PATH: pathEnv };
		claudeBinary = findOnPath("claude", pathEnv);
		codexBinary = findOnPath("codex", pathEnv);
		claudeCache = null;
		codexCache = null;
	};
	usePath(mergePath(null));
	return {
		usePath,
		async refresh() {
			const pathEnv = await resolvedPath();
			usePath(pathEnv);
			return pathEnv;
		},
		factory: ({ provider, model, effort, ownerUserId }) => {
			if (provider === CLAUDE_SUBSCRIPTION)
				return claudeBinary
					? new ClaudeSubscriptionProvider({
							model,
							effort,
							ownerUserId,
							parentEnv: env,
							log: input.log,
							query: electronClaudeQuery(input.hostScript, claudeBinary),
						})
					: new MissingCli(
							`${CLAUDE_SUBSCRIPTION}:${model}`,
							"anthropic",
							"Claude Code (`claude`) was not found. Install it (curl -fsSL https://claude.ai/install.sh | bash), run `claude` in Terminal and log in with /login.",
						);
			if (provider === CODEX_SUBSCRIPTION)
				return codexBinary
					? new CodexSubscriptionProvider({
							model,
							effort,
							ownerUserId,
							parentEnv: env,
							binary: codexBinary,
							log: input.log,
						})
					: new MissingCli(
							`${CODEX_SUBSCRIPTION}:${model || "default"}`,
							"openai",
							"The Codex CLI (`codex`) was not found. Install it (npm install -g @openai/codex), then run `codex login` in Terminal.",
						);
			throw new Error(`Unknown subscription provider: ${provider}`);
		},
		async claude() {
			if (fresh(claudeCache)) return (claudeCache as { state: CliState }).state;
			const binary = claudeBinary;
			const state: CliState = binary
				? await (async () => {
						const login = await claudeLogin(
							env,
							electronClaudeQuery(input.hostScript, binary),
						);
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
		async codex() {
			if (fresh(codexCache)) return (codexCache as { state: CliState }).state;
			const binary = codexBinary;
			const login: LlmLoginState = binary
				? await codexSubscriptionLogin(env)
				: { state: "logged_out", detail: "The Codex CLI is not installed." };
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
	};
}

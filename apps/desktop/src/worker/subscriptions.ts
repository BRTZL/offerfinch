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
	checkOpenCodeBinary,
	findOpenCodeBinary,
	listOpenCodeCatalog,
	OPENCODE_INSTALL,
	OPENCODE_TESTED_VERSION,
	OPENCODE_WINDOWS_OFF,
	type OpenCodeModelEntry,
	OpenCodeProvider,
	openCodeDataHome,
	openCodeDbFile,
	openCodeEntries,
	sweepOpenCodeCrashes,
} from "@offerfinch/local-llm/opencode";
import {
	type OpenCodeCredential,
	readOpenCodeCredentials,
} from "@offerfinch/local-llm/opencode-db";
import {
	EFFORTS,
	type Effort,
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

export const OPENCODE_FIX: Record<CliFix["kind"], CliFix> = {
	install: {
		kind: "install",
		command: OPENCODE_INSTALL,
		after:
			"Then run opencode auth login and sign in (OpenCode, OpenCode Go or a coding plan).",
	},
	login: {
		kind: "login",
		command: "opencode auth login",
		after:
			"Sign in to OpenCode, OpenCode Go or a coding plan with an API key; OpenCode's free models need no sign-in.",
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
	/** OpenCode's state, when this run can check it. */
	opencode?(options?: { fresh?: boolean }): Promise<CliState>;
	/** OpenCode's models on this computer, listed by OpenCode itself (cached). */
	opencodeModels?(): Promise<ModelInfo[]>;
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
					: provider === "opencode" && checks.opencode
						? checks.opencode(options)
						: Promise.resolve(notInstalled(provider)),
		models: async (provider) =>
			provider === "claude"
				? CLAUDE_MODELS
				: provider === "codex"
					? CODEX_MODELS
					: provider === "opencode" && checks.opencodeModels
						? checks.opencodeModels()
						: [],
	};
}

/** An OpenCode model as the pickers show it. */
export function openCodeModelInfo(entry: OpenCodeModelEntry): ModelInfo {
	return {
		ref: formatModelRef("opencode", `${entry.source}/${entry.model}`),
		name: entry.name,
		provider: "opencode",
		source: entry.source,
		billing: entry.billing === "api" ? "api" : "subscription",
		efforts: EFFORTS.filter((e: Effort) => entry.variants.includes(e)),
		...(entry.billing === "api" && entry.price
			? { price: { input: entry.price.input, output: entry.price.output } }
			: {}),
	};
}

/** OpenCode's sign-ins in words: which sources it offers, and which it does not use, and why. */
export function openCodeLogin(
	credentials: OpenCodeCredential[],
	entries: OpenCodeModelEntry[] | null,
	now: Date = new Date(),
): LlmLoginState {
	const active = credentials.filter((c) => c.active);
	const expired = active.find(
		(c) =>
			c.integration === "opencode" &&
			c.type === "oauth" &&
			c.expiresAt &&
			c.expiresAt.getTime() < now.getTime() + 5 * 60_000,
	);
	if (expired)
		return {
			state: "logged_out",
			detail:
				"OpenCode's login has expired. Open OpenCode once so it refreshes it, or run opencode auth login.",
		};
	const offered = [
		...new Set(
			(entries ?? []).filter((e) => !e.unavailable).map((e) => e.source),
		),
	];
	const unused = [
		...new Set(
			(entries ?? [])
				.filter(
					(e) =>
						e.unavailable && active.some((c) => c.integration === e.source),
				)
				.map((e) => e.source),
		),
	].filter((source) => !offered.includes(source));
	const signedIn = active.length
		? `Signed in: ${[...new Set(active.map((c) => c.integration))].join(", ")}.`
		: "Not signed in: only OpenCode's free models are offered.";
	return {
		state: "logged_in",
		detail: [
			signedIn,
			entries
				? offered.length
					? `Models from ${offered.join(", ")}.`
					: "No model OfferFinch can use was listed."
				: "Models are still being listed.",
			unused.length
				? `Not used yet: ${unused.join(", ")} (an untested API or another company's plan login).`
				: "",
		]
			.filter(Boolean)
			.join(" "),
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
	/**
	 * OpenCode's stable private root. Its path goes into OpenCode's environment block, which the
	 * model sees, so it must not name the user: default a folder in the per-user temp directory.
	 */
	opencodeRoot?: string;
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
	const opencode = openCodeSide({
		root: input.opencodeRoot ?? path.join(os.tmpdir(), "offerfinch-opencode"),
		env: () => env,
		log: input.log,
	});
	const usePath = (pathEnv: string) => {
		env = { ...process.env, PATH: pathEnv };
		claudeBinary = findCliOnPath("claude", pathEnv);
		codexBinary = findCliOnPath("codex", pathEnv);
		claudeCache = null;
		codexCache = null;
		opencode.usePath(pathEnv);
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
			if (provider === "opencode")
				return opencode.provider({ model, effort, ownerUserId });
			return new MissingCli(
				`${provider}:${model}`,
				provider,
				`${PROVIDER_NAMES[provider]} models are not available in this version yet.`,
				"boundary",
			);
		},
		opencode: (options) => opencode.state(options),
		opencodeModels: () => opencode.models(),
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

/** How long OpenCode's model list is kept, and how long listing it may take. */
const OPENCODE_CATALOG_TTL_MS = 10 * 60_000;
const OPENCODE_CATALOG_TIMEOUT_MS = 30_000;

/**
 * OpenCode's model list on this computer, read from OpenCode itself (a locked-down server that
 * creates no session) and joined with the user's credentials (types only). Kept ten minutes; a
 * read in progress is shared; `entry` answers from what is kept, without waiting.
 */
function openCodeCatalog(input: {
	binary: () => string | null;
	root: string;
	env: () => Record<string, string | undefined>;
	log?: (message: string, data?: Record<string, unknown>) => void;
}) {
	let kept: { at: number; entries: OpenCodeModelEntry[] } | null = null;
	let running: Promise<OpenCodeModelEntry[] | null> | null = null;
	const read = async (): Promise<OpenCodeModelEntry[] | null> => {
		const binary = input.binary();
		if (!binary) return null;
		const parentEnv = input.env();
		const listed = await Promise.race([
			listOpenCodeCatalog({ binary, root: input.root, parentEnv }),
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error("listing OpenCode's models timed out")),
					OPENCODE_CATALOG_TIMEOUT_MS,
				),
			),
		]);
		const entries = openCodeEntries(
			listed,
			readCredentials(openCodeDbFile(openCodeDataHome(parentEnv))),
		);
		kept = { at: Date.now(), entries };
		return entries;
	};
	return {
		entry(source: string, model: string): OpenCodeModelEntry | null {
			return (
				kept?.entries.find((e) => e.source === source && e.model === model) ??
				null
			);
		},
		load(options: { fresh?: boolean } = {}) {
			if (
				!options.fresh &&
				kept &&
				Date.now() - kept.at < OPENCODE_CATALOG_TTL_MS
			)
				return Promise.resolve(kept.entries);
			running ??= read()
				.catch((error) => {
					input.log?.("opencode models not listed", { error: String(error) });
					return kept?.entries ?? null;
				})
				.finally(() => {
					running = null;
				});
			return running;
		},
		clear() {
			kept = null;
		},
	};
}

/** The user's OpenCode credentials (types only); none when the database cannot be read. */
function readCredentials(dbFile: string): OpenCodeCredential[] {
	try {
		return readOpenCodeCredentials(dbFile);
	} catch {
		return [];
	}
}

/** OpenCode's state: installed, the tested build, and which sources it is signed in to. */
async function openCodeState(input: {
	binary: string | null;
	root: string;
	env: Record<string, string | undefined>;
	entries: OpenCodeModelEntry[] | null;
}): Promise<CliState> {
	if (!input.binary)
		return {
			path: null,
			version: null,
			tested: OPENCODE_TESTED_VERSION,
			login: { state: "logged_out", detail: "OpenCode is not installed." },
			command: OPENCODE_FIX.install.command,
			fix: OPENCODE_FIX.install,
		};
	const gate = await checkOpenCodeBinary({
		binary: input.binary,
		root: input.root,
		parentEnv: input.env,
	}).catch((error) => ({
		ok: false as const,
		version: null,
		detail: String(error),
	}));
	if (!gate.ok)
		return {
			path: input.binary,
			version: gate.version,
			tested: OPENCODE_TESTED_VERSION,
			login: { state: "refused", detail: gate.detail },
			command: OPENCODE_FIX.install.command,
			fix: OPENCODE_FIX.install,
		};
	const login = openCodeLogin(
		readCredentials(openCodeDbFile(openCodeDataHome(input.env))),
		input.entries,
	);
	return {
		path: input.binary,
		version: gate.version,
		tested: OPENCODE_TESTED_VERSION,
		login,
		command: login.state === "logged_in" ? null : OPENCODE_FIX.login.command,
		fix: login.state === "logged_in" ? null : OPENCODE_FIX.login,
	};
}

/**
 * OpenCode for the worker: its binary on the login shell's PATH, its model list, its state and
 * its provider, with the crash sweep whenever a binary is found.
 */
function openCodeSide(input: {
	root: string;
	env: () => Record<string, string | undefined>;
	log?: (message: string, data?: Record<string, unknown>) => void;
}) {
	let binary: string | null = null;
	let cache: { at: number; state: CliState } | null = null;
	const catalog = openCodeCatalog({
		binary: () => binary,
		root: input.root,
		env: input.env,
		log: input.log,
	});
	return {
		usePath(pathEnv: string) {
			const before = binary;
			binary =
				process.platform === "win32" ? null : findOpenCodeBinary(pathEnv);
			cache = null;
			if (binary === before) return;
			catalog.clear();
			if (binary)
				void sweepOpenCodeCrashes({
					binary,
					root: input.root,
					parentEnv: input.env(),
					log: input.log,
				}).catch(() => {});
		},
		provider(choice: {
			model: string;
			effort?: Effort;
			ownerUserId: string;
		}): LlmProvider {
			const at = choice.model.indexOf("/");
			const source = choice.model.slice(0, at);
			const model = choice.model.slice(at + 1);
			const name = `opencode:${choice.model}`;
			if (process.platform === "win32")
				return new MissingCli(
					name,
					`opencode:${source}`,
					OPENCODE_WINDOWS_OFF,
					"boundary",
				);
			if (!binary)
				return new MissingCli(
					name,
					`opencode:${source}`,
					`OpenCode (opencode) was not found. Install it (${OPENCODE_INSTALL}), then run opencode auth login in Terminal.`,
				);
			void catalog.load();
			return new OpenCodeProvider({
				source,
				model,
				effort: choice.effort,
				ownerUserId: choice.ownerUserId,
				root: input.root,
				binary,
				parentEnv: input.env(),
				log: input.log,
				entry: () => catalog.entry(source, model),
				refresh: () => catalog.load(),
			});
		},
		async state(options: { fresh?: boolean } = {}): Promise<CliState> {
			if (process.platform === "win32")
				return {
					path: null,
					version: null,
					tested: OPENCODE_TESTED_VERSION,
					login: { state: "unknown", detail: OPENCODE_WINDOWS_OFF },
					command: null,
					fix: null,
				};
			if (!options.fresh && cache && Date.now() - cache.at < 60_000)
				return cache.state;
			const state = await openCodeState({
				binary,
				root: input.root,
				env: input.env(),
				entries: await catalog.load(options),
			});
			cache = { at: Date.now(), state };
			return state;
		},
		async models(): Promise<ModelInfo[]> {
			if (process.platform === "win32" || !binary) return [];
			return ((await catalog.load()) ?? [])
				.filter((e) => !e.unavailable)
				.map(openCodeModelInfo);
		},
	};
}

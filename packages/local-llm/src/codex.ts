import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import {
	fullPrompt,
	type GenerateObjectRequest,
	type LlmProvider,
	type LlmUsage,
	redactRequest,
	type SubscriptionPauseKind,
	SubscriptionUnavailableError,
} from "@offerfinch/core/scoring/llm";
import { toStrictJsonSchema } from "@offerfinch/core/scoring/openai";
import type { PlanUsageSink } from "@offerfinch/core/scoring/plan-usage";
import type { z } from "zod";

import { Breaker } from "./breaker";
import {
	type AppServerProcess,
	type RpcMessage,
	type ServerRequestAnswer,
	startAppServer,
} from "./codex-rpc";
import { subscriptionEnv } from "./env";
import { codexUsageSnapshot } from "./plan-usage";

export const CODEX_SUBSCRIPTION = "codex-subscription";

/** The codex-cli version every boundary test in `test/codex-*.test.ts` was proven on. */
export const CODEX_TESTED_VERSION = "0.166.0";

/**
 * Feature flags turned off: every one that adds a tool, outside context, a background process
 * or a file the prompt could reach. Passed with `--strict-config`, so an unknown name fails the
 * start instead of being ignored.
 */
export const CODEX_DISABLED_FEATURES = [
	"shell_tool",
	"unified_exec",
	"multi_agent",
	"multi_agent_v2",
	"memories",
	"computer_use",
	"browser_use",
	"in_app_browser",
	"sleep_tool",
	"apps",
	"plugins",
	"hooks",
	"image_generation",
	"view_image",
	"goals",
	"skill_search",
	"tool_suggest",
	"code_mode",
	"code_mode_host",
	"default_mode_request_user_input",
	"shell_snapshot",
	"daemon_auto_start",
] as const;

/** Config overrides: no project docs, web search, analytics, history or stored credentials. */
export const CODEX_CONFIG_OVERRIDES = [
	"project_doc_max_bytes=0",
	'web_search="disabled"',
	"analytics.enabled=false",
	"feedback.enabled=false",
	'history.persistence="none"',
	'cli_auth_credentials_store="ephemeral"',
] as const;

/** Where Codex sends a ChatGPT login's model requests (the built-in provider's default). */
export const CHATGPT_BACKEND = "https://chatgpt.com/backend-api";

/**
 * The model provider every call uses: Codex's Responses API on the same login, with Codex's own
 * retries off. A built-in provider cannot be changed (`model_providers.openai` fails the start
 * under `--strict-config`), and the built-in one retries a failed request (an HTTP 500: two
 * prompt POSTs for one turn) and a dropped stream on its own, each another prompt the call's
 * reservation and the daily budget did not cover. With these settings a turn sends one request;
 * a retry is the caller's, reserved again.
 */
export const CODEX_PROVIDER_ID = "offerfinch";
export function codexProviderConfig(baseUrl: string): string[] {
	const key = `model_providers.${CODEX_PROVIDER_ID}`;
	return [
		`model_provider=${JSON.stringify(CODEX_PROVIDER_ID)}`,
		`${key}.name="offerfinch"`,
		`${key}.base_url=${JSON.stringify(baseUrl)}`,
		`${key}.wire_api="responses"`,
		`${key}.requires_openai_auth=true`,
		`${key}.request_max_retries=0`,
		`${key}.stream_max_retries=0`,
		`${key}.supports_websockets=false`,
	];
}

/**
 * The tools Codex 0.166.0 still lists with the lockdown on (measured on the wire, see
 * test/codex-layers.test.ts). None can act: `exec` has no code-mode host, the thread has no
 * execution environment, and the client aborts on any call. A name outside this list means the
 * installed Codex changed what it offers: a `boundary` pause, not a call.
 */
export const CODEX_EXPECTED_TOOLS: readonly string[] = [
	"functions.exec",
	"functions.wait",
	"functions.request_user_input",
	"functions.request_user_input_async",
	"collaboration.followup_task",
	"collaboration.interrupt_agent",
	"collaboration.list_agents",
	"collaboration.send_message",
	"collaboration.spawn_agent",
	"collaboration.wait_agent",
];

/** Raw response items a pure model call produces; anything else is a tool attempt. */
const SAFE_RAW_ITEMS = new Set(["message", "reasoning", "additional_tools"]);
/** Thread items a pure model call produces. */
const SAFE_ITEMS = new Set(["userMessage", "agentMessage", "reasoning"]);

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export function codexLaunchArgs(extraConfig: string[] = []): string[] {
	return [
		"app-server",
		"--strict-config",
		...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
		...[...CODEX_CONFIG_OVERRIDES, ...extraConfig].flatMap((value) => [
			"-c",
			value,
		]),
	];
}

/**
 * A macOS Seatbelt profile around the whole Codex process: the user's home and the shared temp
 * directories are unreadable and unwritable, except the Codex binary's own directory (read) and
 * this call's private root (read and write). Paths must be real paths (`/var` is
 * `/private/var`). Network stays open: the CLI itself must reach ChatGPT; its tools have no
 * execution environment.
 */
export function sandboxProfile(input: {
	deny: string[];
	readOnly: string[];
	readWrite: string[];
}): string {
	const quote = (path: string) => JSON.stringify(path);
	const ancestors = new Set<string>();
	for (const path of [...input.readOnly, ...input.readWrite]) {
		let current = dirname(path);
		while (current && current !== sep && !ancestors.has(current)) {
			ancestors.add(current);
			current = dirname(current);
		}
	}
	return [
		"(version 1)",
		"(allow default)",
		`(deny file-read* file-write* ${input.deny.map((p) => `(subpath ${quote(p)})`).join(" ")})`,
		...(ancestors.size
			? [
					`(allow file-read-metadata ${[...ancestors].map((p) => `(literal ${quote(p)})`).join(" ")})`,
				]
			: []),
		...input.readOnly.map((p) => `(allow file-read* (subpath ${quote(p)}))`),
		...input.readWrite.map(
			(p) => `(allow file-read* file-write* (subpath ${quote(p)}))`,
		),
		"",
	].join("\n");
}

/** The real path of the `codex` binary on PATH, or null. */
export async function findCodexBinary(
	pathEnv: string | undefined,
): Promise<string | null> {
	for (const dir of (pathEnv ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, "codex");
		if (existsSync(candidate)) {
			try {
				return await realpath(candidate);
			} catch {}
		}
	}
	return null;
}

// ---------------------------------------------------------------------------------------------
// Login: the user's own Codex login, read only.

export interface CodexLogin {
	accessToken: string;
	accountId: string;
	planType: string | null;
	expiresAt: Date | null;
}

export type CodexLoginRead =
	| { ok: true; login: CodexLogin }
	| { ok: false; kind: SubscriptionPauseKind; detail: string };

/** Where the user's Codex keeps its login: `$CODEX_HOME/auth.json`, else `~/.codex/auth.json`. */
export function codexAuthFile(
	parentEnv: Record<string, string | undefined> = process.env,
): string {
	return join(parentEnv.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
}

function jwtClaims(token: string): Record<string, unknown> | null {
	try {
		const payload = token.split(".")[1];
		if (!payload) return null;
		return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
	} catch {
		return null;
	}
}

const LOGIN_HOWTO =
	"Open Codex (or run `codex`) once so it signs in or refreshes its own login, then check Settings › Models. Preparation retries after the next scan. OfferFinch only reads the access token; it never refreshes, copies or writes the login.";

/**
 * Reads the access token of the user's ChatGPT login from Codex's auth file, without writing
 * or copying the file and without touching the refresh token: Codex keeps refreshing its own
 * login, and the app-server gets only the short-lived access token (`chatgptAuthTokens`
 * external auth), so it can never rotate the refresh token and log the user out. No part of
 * the token is ever logged or put in an error.
 */
export async function readCodexLogin(
	file: string,
	now: Date = new Date(),
): Promise<CodexLoginRead> {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch {
		return {
			ok: false,
			kind: "logged_out",
			detail: `Codex is not logged in to ChatGPT (no ${file}). Run \`codex login\` and choose ChatGPT. ${LOGIN_HOWTO}`,
		};
	}
	let data: {
		OPENAI_API_KEY?: string | null;
		tokens?: { access_token?: string; account_id?: string } | null;
	};
	try {
		data = JSON.parse(raw);
	} catch {
		return {
			ok: false,
			kind: "logged_out",
			detail: `Codex's login file ${file} could not be read as JSON. ${LOGIN_HOWTO}`,
		};
	}
	const accessToken = data.tokens?.access_token;
	if (!accessToken) {
		return data.OPENAI_API_KEY
			? {
					ok: false,
					kind: "not_subscription",
					detail:
						"Codex is logged in with an API key, not a ChatGPT plan. codex-subscription uses only a ChatGPT login; use CLAIMS_LLM_PROVIDER=openai for API-key billing.",
				}
			: {
					ok: false,
					kind: "logged_out",
					detail: `Codex has no ChatGPT login. Run \`codex login\`. ${LOGIN_HOWTO}`,
				};
	}
	const claims = jwtClaims(accessToken);
	const auth = (claims?.["https://api.openai.com/auth"] ?? {}) as Record<
		string,
		unknown
	>;
	const accountId =
		data.tokens?.account_id ||
		(typeof auth.chatgpt_account_id === "string"
			? auth.chatgpt_account_id
			: "");
	if (!claims || !accountId)
		return {
			ok: false,
			kind: "logged_out",
			detail: `Codex's ChatGPT login has no account id. ${LOGIN_HOWTO}`,
		};
	const exp =
		typeof claims.exp === "number" ? new Date(claims.exp * 1000) : null;
	if (exp && exp.getTime() - now.getTime() < 5 * 60_000)
		return {
			ok: false,
			kind: "logged_out",
			detail: `Codex's ChatGPT access token has expired (${exp.toISOString()}). ${LOGIN_HOWTO}`,
		};
	return {
		ok: true,
		login: {
			accessToken,
			accountId,
			planType:
				typeof auth.chatgpt_plan_type === "string"
					? auth.chatgpt_plan_type
					: null,
			expiresAt: exp,
		},
	};
}

// ---------------------------------------------------------------------------------------------
// Plan usage: ChatGPT credits are Codex's paid extra usage.

interface CreditsSnapshot {
	hasCredits: boolean;
	unlimited: boolean;
	balance: string | null;
}
interface RateLimitWindow {
	usedPercent: number;
	resetsAt: number | null;
	/** Newer CLIs say how long the window is, in minutes. */
	windowDurationMins?: number | null;
}
interface RateLimitSnapshot {
	limitId: string | null;
	primary: RateLimitWindow | null;
	secondary: RateLimitWindow | null;
	credits: CreditsSnapshot | null;
	spendControlReached: boolean | null;
	planType: string | null;
	rateLimitReachedType: string | null;
}
export interface CodexRateLimits {
	ordinaryUsageAllowed: boolean | null;
	rateLimits: RateLimitSnapshot | null;
	rateLimitsByLimitId: Record<string, RateLimitSnapshot | undefined> | null;
}

export const CODEX_CREDITS_HOWTO =
	"Codex can spend ChatGPT credits once the plan's included usage runs out, and no request option keeps a call off them. codex-subscription runs only while every usage window has headroom, and records a call whose credit balance dropped as paid.";

/** A call starts only while every usage window is below this share used (the user's choice). */
export const CODEX_HEADROOM_PERCENT = 90;

function snapshotsOf(limits: CodexRateLimits): RateLimitSnapshot[] {
	return [
		limits.rateLimits,
		...Object.values(limits.rateLimitsByLimitId ?? {}),
	].filter((s): s is RateLimitSnapshot => !!s);
}

/** A balance as Codex reports it: a plain non-negative decimal string, nothing else. */
const BALANCE = /^\d+(\.\d+)?$/;

/**
 * The credit balance per limit id, as numbers; null when any bucket cannot be read. Every bucket
 * must carry a plain non-negative decimal balance, whatever `hasCredits` says: an absent, empty,
 * invalid or negative balance is unknown, never 0.
 */
export function creditBalances(
	limits: CodexRateLimits,
): Record<string, number> | null {
	const out: Record<string, number> = {};
	for (const s of snapshotsOf(limits)) {
		const raw = s.credits?.balance;
		if (typeof raw !== "string" || !BALANCE.test(raw.trim())) return null;
		const balance = Number(raw.trim());
		if (!Number.isFinite(balance)) return null;
		const id = s.limitId ?? "default";
		if (id in out && out[id] !== balance) return null;
		out[id] = balance;
	}
	return Object.keys(out).length ? out : null;
}

/**
 * True when any bucket's credit balance went down between the two reads; null (unknown) when
 * the second read is missing or lacks any bucket the first one had.
 */
export function creditsSpent(
	before: Record<string, number>,
	after: Record<string, number> | null,
): boolean | null {
	if (!after) return null;
	let missing = false;
	for (const [id, balance] of Object.entries(before)) {
		const now = after[id];
		if (now === undefined) missing = true;
		else if (now < balance - 1e-6) return true;
	}
	return missing ? null : false;
}

/**
 * Whether a sent call was paid from ChatGPT credits, from the balances read before the prompt and
 * after the turn. `fine` only when it is provable: the second read has every bucket and none went
 * down, or no bucket held any credits to spend. `paid` when any bucket went down. Anything else
 * (no first read, no second read, a bucket missing) is `unknown`.
 */
export function codexPayment(
	before: Record<string, number> | null,
	after: Record<string, number> | null,
): "fine" | "paid" | "unknown" {
	if (!before) return "unknown";
	const spent = creditsSpent(before, after);
	if (spent === true) return "paid";
	if (spent === false) return "fine";
	return Object.values(before).every((b) => b === 0) ? "fine" : "unknown";
}

/**
 * Whether a call may start, read from the plan's usage just before the prompt exists. Fails
 * closed. Included usage must be reported as allowed; no limit may be reached; every window
 * must have headroom (below `CODEX_HEADROOM_PERCENT` used), so a call is unlikely to cross into
 * credits; and the credit balance must be readable and finite (not unlimited), so a call that
 * did spend credits is seen afterwards by the balance going down (`creditsSpent`).
 */
export function rateLimitProblem(
	limits: CodexRateLimits,
): { kind: SubscriptionPauseKind; detail: string; resetsAt?: Date } | null {
	const snapshots = snapshotsOf(limits);
	const reached = snapshots.find(
		(s) => s.rateLimitReachedType || s.spendControlReached,
	);
	const windows = snapshots
		.flatMap((s) => [s.primary, s.secondary])
		.filter((w): w is RateLimitWindow => !!w);
	// Headroom must be established, not assumed: every bucket reports at least one window (a plan
	// may report only one of its two), and every window it reports has a finite, non-negative
	// share used. Anything else (no snapshot, a bucket with no window, NaN, a string) pauses.
	const usable = (w: RateLimitWindow) =>
		typeof w.usedPercent === "number" &&
		Number.isFinite(w.usedPercent) &&
		w.usedPercent >= 0;
	const unknownHeadroom =
		!snapshots.length ||
		snapshots.some((s) => !s.primary && !s.secondary) ||
		windows.some((w) => !usable(w));
	const full = windows.filter(
		(w) => usable(w) && w.usedPercent >= CODEX_HEADROOM_PERCENT,
	);
	const resets = full.map((w) => w.resetsAt ?? 0).filter((t) => t > 0);
	const resetsAt = resets.length
		? new Date(Math.max(...resets) * 1000)
		: undefined;
	if (limits.ordinaryUsageAllowed === false || reached || full.length)
		return {
			kind: "usage_limit",
			detail: `the ChatGPT plan's Codex usage is ${reached || limits.ordinaryUsageAllowed === false ? "at its limit" : `at ${CODEX_HEADROOM_PERCENT}% or more of a window`}${resetsAt ? ` until ${resetsAt.toISOString()}` : ""}, and the rest would come from credits. Preparation waits; it resumes after a later scan once the window resets, with status in Settings › Models.`,
			resetsAt,
		};
	if (limits.ordinaryUsageAllowed !== true)
		return {
			kind: "extra_usage",
			detail: `Codex did not say whether the plan's included usage is available; nothing was sent. ${CODEX_CREDITS_HOWTO}`,
		};
	if (unknownHeadroom)
		return {
			kind: "extra_usage",
			detail: `Codex did not report a usable share used for every usage window, so the plan's headroom is unknown; nothing was sent. ${CODEX_CREDITS_HOWTO}`,
		};
	if (snapshots.some((s) => s.credits?.unlimited))
		return {
			kind: "extra_usage",
			detail: `the ChatGPT account has unlimited credits, so a paid call could not be told apart; nothing was sent. ${CODEX_CREDITS_HOWTO}`,
		};
	if (!creditBalances(limits))
		return {
			kind: "extra_usage",
			detail: `Codex did not report the account's credit balance; nothing was sent. ${CODEX_CREDITS_HOWTO}`,
		};
	return null;
}

// ---------------------------------------------------------------------------------------------
// One turn.

/** Each defence can be switched off alone, so the tests prove each one holds by itself. */
export interface CodexLayers {
	/** Feature flags off (`CODEX_DISABLED_FEATURES`) and the config overrides. */
	lockdown: boolean;
	/** `environments: []` on the thread: no execution environment for any tool. */
	noEnvironments: boolean;
	/** `sandbox-exec` around the whole process, denying the home and shared temp directories. */
	sandboxExec: boolean;
	/**
	 * `approvalPolicy: "untrusted"` with a client that declines every request, and aborts the
	 * turn (interrupt, then kill) on any tool item, raw tool call or server request.
	 */
	approvalAndAbort: boolean;
	/** `ephemeral: true`: Codex keeps no rollout or thread history. */
	ephemeral: boolean;
}

export const ALL_LAYERS: CodexLayers = {
	lockdown: true,
	noEnvironments: true,
	sandboxExec: true,
	approvalAndAbort: true,
	ephemeral: true,
};

export type CodexAuthInput =
	| {
			type: "chatgpt";
			login: CodexLogin;
			authFile: string;
			/** Tests only: a capture server in place of chatgpt.com. */
			chatgptBaseUrl?: string;
	  }
	/** Tests only: an API key against a local capture server. Never built by the CLI. */
	| { type: "capture"; baseUrl: string };

export interface CodexTurnInput {
	binary: string;
	auth: CodexAuthInput;
	system: string;
	prompt: string;
	outputSchema?: Record<string, unknown>;
	model?: string;
	effort?: string;
	layers?: CodexLayers;
	/** Without `approvalAndAbort` (tests): the policy and sandbox Codex itself applies. */
	approvalPolicy?: "untrusted" | "on-request" | "never";
	codexSandbox?: "read-only" | "danger-full-access";
	/** Before the prompt exists for Codex: refuse here (account, credits) and nothing is sent. */
	beforeTurn?: (session: {
		account: unknown;
		rateLimits: CodexRateLimits | null;
	}) => Error | null;
	onModelCall?: () => void;
	timeoutMs?: number;
	/** Tests: inspect the call's private root before it is deleted. */
	beforeCleanup?: (root: string) => Promise<void>;
	/** The parent environment; only the allowlist reaches the CLI (plus its private dirs). */
	parentEnv?: Record<string, string | undefined>;
	/**
	 * Read the account's credit balance and stop: no thread, no prompt (`creditsBefore` holds
	 * it). Used for the second read when the call's own process could not make it.
	 */
	creditsOnly?: boolean;
}

export interface CodexTurnResult {
	/** The final agent message, when the turn completed. */
	text: string | null;
	usage: {
		inputTokens: number;
		cachedInputTokens: number;
		cacheWriteTokens: number;
		outputTokens: number;
	} | null;
	model: string | null;
	/** Set when the model tried any tool (the call is failed and discarded). */
	toolAttempt: string | null;
	/** Set when Codex itself was not the expected locked-down session. */
	boundary: string | null;
	/** Refused before the prompt was sent (by `beforeTurn`). */
	refused: Error | null;
	/** ChatGPT credit balances read before the prompt, and again after the answer. */
	creditsBefore: Record<string, number> | null;
	creditsAfter: Record<string, number> | null;
	/** The plan's usage as read before the prompt, and again after the answer. */
	rateLimitsBefore: CodexRateLimits | null;
	rateLimitsAfter: CodexRateLimits | null;
	/** A turn error Codex reported, with its classification. */
	turnError: { message: string; info: unknown } | null;
	status: string | null;
	sent: boolean;
	rawTypes: string[];
	toolNames: string[];
	codexVersion: string | null;
	removedEnv: string[];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function emptyTurnResult(removedEnv: string[]): CodexTurnResult {
	return {
		text: null,
		usage: null,
		model: null,
		toolAttempt: null,
		boundary: null,
		refused: null,
		creditsBefore: null,
		creditsAfter: null,
		rateLimitsBefore: null,
		rateLimitsAfter: null,
		turnError: null,
		status: null,
		sent: false,
		rawTypes: [],
		toolNames: [],
		codexVersion: null,
		removedEnv,
	};
}

/**
 * Runs one turn in a fresh `codex app-server` in a private temp root (home, CODEX_HOME, TMPDIR,
 * an empty cwd), deleted afterwards. With every layer on this is a pure model call: no tool can
 * run, nothing outside the root is readable, and nothing is kept.
 */
export async function runCodexTurn(
	input: CodexTurnInput,
): Promise<CodexTurnResult> {
	const layers = input.layers ?? ALL_LAYERS;
	const base = await realpath(tmpdir());
	const root = await mkdtemp(join(base, "offerfinch-codex-"));
	const dirs = {
		home: join(root, "home"),
		codexHome: join(root, "codex-home"),
		tmp: join(root, "tmp"),
		cwd: join(root, "cwd"),
	};
	for (const dir of Object.values(dirs)) await mkdir(dir);
	const { env: allowed, removed } = subscriptionEnv(
		input.parentEnv ?? process.env,
	);
	const env: Record<string, string> = {
		PATH: allowed.PATH ?? "/usr/bin:/bin",
		...(allowed.LANG ? { LANG: allowed.LANG } : {}),
		...(allowed.TZ ? { TZ: allowed.TZ } : {}),
		HOME: dirs.home,
		CODEX_HOME: dirs.codexHome,
		TMPDIR: dirs.tmp,
	};
	const result = emptyTurnResult(removed);
	const extraConfig =
		input.auth.type === "capture"
			? [
					`openai_base_url=${JSON.stringify(input.auth.baseUrl)}`,
					...codexProviderConfig(input.auth.baseUrl),
				]
			: [
					...(input.auth.chatgptBaseUrl
						? [`chatgpt_base_url=${JSON.stringify(input.auth.chatgptBaseUrl)}`]
						: []),
					...codexProviderConfig(
						`${input.auth.chatgptBaseUrl ?? CHATGPT_BACKEND}/codex`,
					),
				];
	const args = layers.lockdown
		? codexLaunchArgs(extraConfig)
		: [
				"app-server",
				...extraConfig.flatMap((v) => ["-c", v]),
				"-c",
				"project_doc_max_bytes=0",
			];
	let command = input.binary;
	let commandArgs = args;
	if (layers.sandboxExec) {
		if (!existsSync(SANDBOX_EXEC)) {
			await rm(root, { recursive: true, force: true });
			result.boundary = `${SANDBOX_EXEC} is missing; codex-subscription runs only inside it`;
			return result;
		}
		const profile = sandboxProfile({
			deny: [
				...new Set(
					[
						await realpath(homedir()),
						base,
						"/private/tmp",
						"/private/var/tmp",
					].filter(Boolean),
				),
			],
			readOnly: [dirname(input.binary)],
			readWrite: [root],
		});
		const profileFile = join(root, "sandbox.sb");
		await writeFile(profileFile, profile);
		command = SANDBOX_EXEC;
		commandArgs = ["-f", profileFile, input.binary, ...args];
	}

	let threadId: string | null = null;
	let turnId: string | null = null;
	let server: AppServerProcess | null = null;
	let alive = true;
	let finished: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		finished = resolve;
	});
	const abort = (reason: string) => {
		result.toolAttempt ??= reason;
		if (server && threadId && turnId)
			server.request("turn/interrupt", { threadId, turnId }).catch(() => {});
		server?.kill();
		finished();
	};
	const failBoundary = (reason: string) => {
		result.boundary ??= reason;
		server?.kill();
		finished();
	};

	const onServerRequest = (message: RpcMessage): ServerRequestAnswer => {
		const method = message.method ?? "";
		if (method === "account/chatgptAuthTokens/refresh") {
			// ChatGPT refused the access token: never refresh here (that is the user's Codex's job);
			// the turn then fails as unauthorized and the call pauses as logged out.
			return {
				error: {
					code: -32000,
					message: "refresh refused: OfferFinch never refreshes the login",
				},
			};
		}
		if (layers.approvalAndAbort) abort(`server request ${method}`);
		else result.toolAttempt ??= `server request ${method}`;
		if (/requestApproval$/.test(method))
			return { result: { decision: "decline" } };
		if (method === "execCommandApproval" || method === "applyPatchApproval")
			return { result: { decision: "denied" } };
		return { error: { code: -32601, message: "refused by OfferFinch" } };
	};

	const onNotification = (message: RpcMessage) => {
		// biome-ignore lint/suspicious/noExplicitAny: app-server notification JSON, read defensively field by field
		const params = (message.params ?? {}) as Record<string, any>;
		const method = message.method ?? "";
		const fromOtherThread =
			threadId !== null &&
			typeof params.threadId === "string" &&
			params.threadId !== threadId;
		if (method === "rawResponseItem/completed") {
			const item = params.item ?? {};
			const type = String(item.type ?? "?");
			result.rawTypes.push(type);
			if (type === "additional_tools") {
				const names: string[] = (item.tools ?? []).flatMap(
					(ns: { name?: string; tools?: { name?: string }[] }) =>
						(ns.tools ?? []).map((t) => `${ns.name}.${t.name}`),
				);
				result.toolNames = names;
				const unexpected = names.filter(
					(n) => !CODEX_EXPECTED_TOOLS.includes(n),
				);
				if (layers.lockdown && unexpected.length)
					failBoundary(
						`Codex offered tools outside the tested list: ${unexpected.join(", ")}`,
					);
			} else if (!SAFE_RAW_ITEMS.has(type) || fromOtherThread) {
				if (layers.approvalAndAbort)
					abort(
						`raw ${type}${item.name ? ` ${item.name}` : ""}${fromOtherThread ? " (another thread)" : ""}`,
					);
				else
					result.toolAttempt ??= `raw ${type}${item.name ? ` ${item.name}` : ""}`;
			}
			return;
		}
		if (method === "item/started" || method === "item/completed") {
			const item = params.item ?? {};
			const type = String(item.type ?? "?");
			if (!SAFE_ITEMS.has(type) || fromOtherThread) {
				if (layers.approvalAndAbort) abort(`item ${type}`);
				else result.toolAttempt ??= `item ${type}`;
				return;
			}
			if (method === "item/completed" && type === "agentMessage")
				result.text = String(item.text ?? "");
			return;
		}
		if (fromOtherThread) {
			if (layers.approvalAndAbort)
				abort(`event from another thread (${method})`);
			return;
		}
		if (method === "thread/tokenUsage/updated") {
			const last = params.tokenUsage?.total ?? params.tokenUsage?.last;
			if (last)
				result.usage = {
					inputTokens: Math.max(
						0,
						(last.inputTokens ?? 0) - (last.cachedInputTokens ?? 0),
					),
					cachedInputTokens: last.cachedInputTokens ?? 0,
					cacheWriteTokens: last.cacheWriteInputTokens ?? 0,
					outputTokens: last.outputTokens ?? 0,
				};
			return;
		}
		if (method === "error") {
			// Retries are off (`codexProviderConfig`); a Codex that retries anyway would send a
			// prompt nobody reserved: stop the turn before more go out.
			if (params.willRetry) {
				failBoundary(
					`Codex retried a request inside the turn (${String(params.error?.message ?? "error").slice(0, 100)}), although its retries are off`,
				);
				return;
			}
			result.turnError = {
				message: String(params.error?.message ?? "Codex error"),
				info: params.error?.codexErrorInfo ?? null,
			};
			return;
		}
		if (method === "turn/completed") {
			result.status = String(params.turn?.status ?? "?");
			if (params.turn?.error && !result.turnError)
				result.turnError = {
					message: String(params.turn.error.message ?? "turn failed"),
					info: params.turn.error.codexErrorInfo ?? null,
				};
			finished();
		}
	};

	const timer = setTimeout(
		() => {
			result.turnError ??= { message: "timed out", info: "timeout" };
			server?.kill();
			finished();
		},
		input.timeoutMs ?? 15 * 60_000,
	);

	try {
		server = startAppServer({
			command,
			args: commandArgs,
			env,
			cwd: dirs.cwd,
			onServerRequest,
			onNotification,
		});
		const exited = server.exited.then(() => {
			alive = false;
			finished();
		});
		const init = await Promise.race([
			server.request<{ userAgent?: string }>("initialize", {
				clientInfo: { name: "offerfinch", title: null, version: "1" },
				capabilities: { experimentalApi: true, requestAttestation: false },
			}),
			done.then(() => null),
		]);
		if (!init)
			throw new Error(
				`codex app-server did not start: ${server.stderrTail().slice(-300)}`,
			);
		result.codexVersion =
			/(\d+\.\d+\.\d+)/.exec(init.userAgent ?? "")?.[1] ?? null;
		server.notify("initialized", {});
		if (input.auth.type === "chatgpt")
			await server.request("account/login/start", {
				type: "chatgptAuthTokens",
				accessToken: input.auth.login.accessToken,
				chatgptAccountId: input.auth.login.accountId,
				chatgptPlanType: input.auth.login.planType,
			});
		else
			await server.request("account/login/start", {
				type: "apiKey",
				apiKey: "sk-capture-only",
			});
		const account = await server.request<{ account: unknown }>(
			"account/read",
			{},
		);
		let rateLimits: CodexRateLimits | null = null;
		if (input.auth.type === "chatgpt")
			rateLimits = await server
				.request<CodexRateLimits>("account/rateLimits/read", {})
				.catch(() => null);
		result.rateLimitsBefore = rateLimits;
		if (rateLimits) result.creditsBefore = creditBalances(rateLimits);
		if (input.creditsOnly) return result;
		result.refused =
			input.beforeTurn?.({ account: account.account, rateLimits }) ?? null;
		if (result.refused) return result;
		const thread = await server.request<{
			thread: { id: string };
			model: string;
			instructionSources?: unknown[];
		}>("thread/start", {
			cwd: dirs.cwd,
			...(input.model ? { model: input.model } : {}),
			approvalPolicy: layers.approvalAndAbort
				? "untrusted"
				: (input.approvalPolicy ?? "never"),
			sandbox: layers.approvalAndAbort
				? "read-only"
				: (input.codexSandbox ?? "danger-full-access"),
			ephemeral: layers.ephemeral,
			...(layers.noEnvironments ? { environments: [] } : {}),
			experimentalRawEvents: true,
			baseInstructions: input.system,
		});
		threadId = thread.thread.id;
		result.model = thread.model ?? null;
		if (layers.lockdown && thread.instructionSources?.length)
			failBoundary(
				`Codex loaded instruction files: ${thread.instructionSources.length}`,
			);
		if (result.boundary) return result;
		input.onModelCall?.();
		result.sent = true;
		const turn = await server.request<{ turn: { id: string } }>("turn/start", {
			threadId,
			input: [{ type: "text", text: input.prompt, text_elements: [] }],
			...(input.effort ? { effort: input.effort } : {}),
			summary: "none",
			...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
		});
		turnId = turn.turn.id;
		await done;
		void exited;
		// The answer is in: read the credit balance again, so a call that spent credits is seen.
		if (input.auth.type === "chatgpt" && alive && result.status !== null) {
			const after = await Promise.race([
				server
					.request<CodexRateLimits>("account/rateLimits/read", {})
					.catch(() => null),
				new Promise<null>((r) => setTimeout(() => r(null), 15_000)),
			]);
			result.rateLimitsAfter = after;
			result.creditsAfter = after ? creditBalances(after) : null;
		}
	} catch (error) {
		if (!result.toolAttempt && !result.boundary && !result.turnError)
			result.turnError = { message: errorMessage(error), info: "client" };
	} finally {
		clearTimeout(timer);
		await server?.close(2000);
		if (input.beforeCleanup) await input.beforeCleanup(root).catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
	return result;
}

// ---------------------------------------------------------------------------------------------
// The provider.

export type CodexEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface CodexSubscriptionOptions {
	/** Empty: the account's default Codex model. */
	model?: string;
	effort?: CodexEffort;
	ownerUserId: string;
	parentEnv?: Record<string, string | undefined>;
	/** Default `$CODEX_HOME/auth.json` or `~/.codex/auth.json`; read only. */
	authFile?: string;
	/** Default: `codex` on PATH, resolved to its real path. */
	binary?: string;
	log?: (message: string, data?: Record<string, unknown>) => void;
	breaker?: Breaker;
	now?: () => Date;
	timeoutMs?: number;
	/** Tests only: a local capture server instead of ChatGPT (API-key login to it). */
	captureBaseUrl?: string;
	/** Tests only: keep the ChatGPT login, but send it to a capture server, not chatgpt.com. */
	captureChatgptBaseUrl?: string;
	/** Tests only: stands in for `runCodexTurn` (no process, no network). */
	runTurn?: (input: CodexTurnInput) => Promise<CodexTurnResult>;
	/** Where the plan's usage, as each call reads it, is reported (Settings › Models). */
	planUsage?: PlanUsageSink;
}

/** One process-wide breaker for Codex: a limit or logout stops every caller. */
const CODEX_BREAKER = new Breaker();

/**
 * The user reconciled every held Codex call and resumed Codex (Settings > Models): lifts this
 * process's pause for a call that spent credits or whose payment is unknown, so the next call is
 * sent. Any other pause (a usage limit, a logout, credits or headroom not readable) stays.
 */
export function resumeCodexCalls(breaker: Breaker = CODEX_BREAKER): void {
	breaker.clear("extra_usage", { paidOnly: true });
}

/**
 * A tool attempt fails this call: it comes from the posting, not from the setup. On a ChatGPT
 * login whose account holds credits, the abort ends the session before the second credit read,
 * so the call is a payment-unknown pause instead (`codexPayment`).
 */
export class CodexToolAttemptError extends Error {
	constructor(provider: string, task: string, attempt: string) {
		super(
			`${provider}: the model tried to use a tool during ${task} (${attempt}); the call was declined, aborted and discarded. No tool ran: Codex has no execution environment or shell here, and runs inside sandbox-exec.`,
		);
		this.name = "CodexToolAttemptError";
	}
}

function errorKind(info: unknown): SubscriptionPauseKind | null {
	const tag =
		typeof info === "string"
			? info
			: info && typeof info === "object"
				? Object.keys(info)[0]
				: "";
	if (
		tag === "usageLimitExceeded" ||
		tag === "rateLimitExceeded" ||
		tag === "sessionBudgetExceeded"
	)
		return "usage_limit";
	if (tag === "unauthorized") return "logged_out";
	return null;
}

/**
 * Structured generation on the user's ChatGPT plan through `codex app-server`. Local only: it
 * starts a subprocess. Each call is a pure model call in a fresh, deleted temp root, behind
 * five independent defences (`CodexLayers`), each proven alone in `test/codex-layers.test.ts`.
 */
export class CodexSubscriptionProvider implements LlmProvider {
	readonly name: string;
	readonly billing = "subscription" as const;
	readonly vendor = "openai";
	readonly ownerUserId: string;
	private readonly breaker: Breaker;
	private readonly now: () => Date;

	constructor(private readonly options: CodexSubscriptionOptions) {
		if (!options.ownerUserId)
			throw new Error("codex-subscription needs the owner's account id");
		this.name = `${CODEX_SUBSCRIPTION}:${options.model || "default"}`;
		this.ownerUserId = options.ownerUserId;
		this.breaker = options.breaker ?? CODEX_BREAKER;
		this.now = options.now ?? (() => new Date());
	}

	private pause(
		kind: SubscriptionPauseKind,
		detail: string,
		resetsAt?: Date,
	): SubscriptionUnavailableError {
		return new SubscriptionUnavailableError(kind, this.name, detail, resetsAt);
	}

	async generateObject<T>(raw: GenerateObjectRequest<T>): Promise<T> {
		const request = redactRequest(raw);
		const open = this.breaker.current(this.now());
		if (open) throw open;
		try {
			return await this.call(request);
		} catch (error) {
			if (error instanceof SubscriptionUnavailableError)
				this.breaker.trip(error, this.now());
			throw error;
		}
	}

	private async call<T>(request: GenerateObjectRequest<T>): Promise<T> {
		const parentEnv = this.options.parentEnv ?? process.env;
		const binary =
			this.options.binary ?? (await findCodexBinary(parentEnv.PATH));
		if (!binary)
			throw this.pause(
				"logged_out",
				"the Codex CLI (`codex`) was not found on PATH. Install Codex, run `codex login`, then check Settings › Models. Preparation retries after the next scan.",
			);
		let auth: CodexAuthInput;
		if (this.options.captureBaseUrl) {
			auth = { type: "capture", baseUrl: this.options.captureBaseUrl };
		} else {
			const authFile = this.options.authFile ?? codexAuthFile(parentEnv);
			const read = await readCodexLogin(authFile, this.now());
			if (!read.ok) throw this.pause(read.kind, read.detail);
			auth = {
				type: "chatgpt",
				login: read.login,
				authFile,
				chatgptBaseUrl: this.options.captureChatgptBaseUrl,
			};
		}
		const schema = toStrictJsonSchema(request.schema as z.ZodType);
		const usageCall = this.options.planUsage?.call();
		const report = (limits: CodexRateLimits | null, after: boolean) => {
			const snapshot = limits && codexUsageSnapshot(limits, this.now());
			if (!snapshot) return;
			if (after) usageCall?.sample(snapshot);
			else this.options.planUsage?.sample(snapshot);
		};
		try {
			return await this.turn(request, binary, auth, schema, parentEnv, {
				sent: () => usageCall?.sent(),
				report,
			});
		} finally {
			usageCall?.done();
		}
	}

	// biome-ignore lint/complexity/useMaxParams: One turn's inputs, kept positional so the call above stays readable.
	private async turn<T>(
		request: GenerateObjectRequest<T>,
		binary: string,
		auth: CodexAuthInput,
		schema: Record<string, unknown>,
		parentEnv: Record<string, string | undefined>,
		plan: {
			sent: () => void;
			report: (limits: CodexRateLimits | null, after: boolean) => void;
		},
	): Promise<T> {
		const result = await (this.options.runTurn ?? runCodexTurn)({
			binary,
			auth,
			system: request.system,
			prompt: fullPrompt(request),
			outputSchema: schema,
			model: this.options.model || undefined,
			effort: this.options.effort,
			parentEnv,
			timeoutMs: this.options.timeoutMs,
			onModelCall: () => {
				plan.sent();
				request.onModelCall?.();
			},
			beforeTurn: ({ account, rateLimits }) => {
				plan.report(rateLimits, false);
				if (auth.type === "capture") return null;
				const acct = account as { type?: string; planType?: string } | null;
				if (acct?.type !== "chatgpt")
					return this.pause(
						acct ? "not_subscription" : "logged_out",
						acct
							? `Codex would bill ${acct.type}, not the ChatGPT plan; nothing was sent.`
							: `Codex did not accept the ChatGPT login; nothing was sent. ${LOGIN_HOWTO}`,
					);
				if (!rateLimits)
					return this.pause(
						"extra_usage",
						`Codex did not report the plan's usage; nothing was sent. ${CODEX_CREDITS_HOWTO}`,
					);
				const problem = rateLimitProblem(rateLimits);
				return problem
					? this.pause(problem.kind, problem.detail, problem.resetsAt)
					: null;
			},
		});
		// The call's own process could not read the balance again (a tool attempt aborted it, the
		// stream dropped): read it in a fresh process that gets no prompt. If that fails too, the
		// payment stays unknown.
		if (
			auth.type === "chatgpt" &&
			result.sent &&
			result.creditsBefore &&
			result.creditsAfter === null
		) {
			const fresh = await (this.options.runTurn ?? runCodexTurn)({
				binary,
				auth,
				system: "",
				prompt: "",
				parentEnv,
				timeoutMs: 30_000,
				creditsOnly: true,
			}).catch(() => null);
			result.creditsAfter = fresh?.creditsBefore ?? null;
			result.rateLimitsAfter = fresh?.rateLimitsBefore ?? null;
			this.options.log?.("codex credits read again in a fresh process", {
				provider: this.name,
				read: result.creditsAfter !== null,
			});
		}
		if (result.sent) plan.report(result.rateLimitsAfter, true);
		this.options.log?.("codex subscription session", {
			provider: this.name,
			codexVersion: result.codexVersion,
			model: result.model,
			tools: result.toolNames,
			rawTypes: [...new Set(result.rawTypes)],
			status: result.status,
			toolAttempt: result.toolAttempt,
			boundary: result.boundary,
			cwd: "(empty temp directory, deleted)",
			sandbox: "sandbox-exec: home and shared temp unreadable",
			removedEnv: result.removedEnv,
		});
		if (result.usage) {
			const usage: LlmUsage = {
				model: result.model ?? this.options.model ?? "codex",
				inputTokens: result.usage.inputTokens,
				outputTokens: result.usage.outputTokens,
				cachedInputTokens: result.usage.cachedInputTokens,
				cacheWriteTokens: result.usage.cacheWriteTokens,
			};
			request.onUsage?.(usage);
		}
		if (result.refused) throw result.refused;
		// One rule for every sent call, however the turn ended: unless the balances prove it was
		// not paid, it is paid or unknown, and either pauses every later call.
		const payment =
			auth.type === "chatgpt" && result.sent
				? codexPayment(result.creditsBefore, result.creditsAfter)
				: "fine";
		if (payment === "paid")
			throw new SubscriptionUnavailableError(
				"extra_usage",
				this.name,
				`Codex spent ChatGPT credits on this call (the balance went down): it is recorded at its estimated API price and every subscription call is paused. ${CODEX_CREDITS_HOWTO}`,
				undefined,
				true,
			);
		if (payment === "unknown")
			throw new SubscriptionUnavailableError(
				"extra_usage",
				this.name,
				`the ChatGPT credit balance could not be read again after ${request.task}, so whether credits paid for it is unknown: the answer is discarded, the call is held at its worst case, and every subscription call is paused until you check the ChatGPT usage page, reconcile it, and confirm extra usage off again. ${CODEX_CREDITS_HOWTO}`,
				undefined,
				"unknown",
			);
		if (result.boundary)
			throw this.pause(
				"boundary",
				`the Codex session was not a pure model call (${result.boundary}); nothing is kept. Re-run \`pnpm --filter @offerfinch/local-llm test\` against the installed Codex (tested: ${CODEX_TESTED_VERSION}).`,
			);
		if (result.toolAttempt)
			throw new CodexToolAttemptError(
				this.name,
				request.task,
				result.toolAttempt,
			);
		if (result.turnError) {
			const kind = errorKind(result.turnError.info);
			if (kind === "usage_limit")
				throw this.pause(
					"usage_limit",
					"the ChatGPT plan's Codex usage limit is reached. Preparation waits; it resumes after a later scan once the limit resets, with status in Settings › Models.",
				);
			if (kind === "logged_out")
				throw this.pause(
					"logged_out",
					`ChatGPT refused Codex's login. ${LOGIN_HOWTO}`,
				);
			throw new Error(
				`${this.name}: ${request.task} failed: ${result.turnError.message.slice(0, 300)}`,
			);
		}
		if (result.status !== "completed" || result.text === null)
			throw new Error(
				`${this.name}: ${request.task} ended without an answer (${result.status ?? "no status"})`,
			);
		let parsed: unknown;
		try {
			parsed = JSON.parse(result.text);
		} catch {
			throw new Error(
				`${this.name}: no valid structured output for ${request.task}: ${result.text.slice(0, 300)}`,
			);
		}
		return request.schema.parse(parsed);
	}
}

// ---------------------------------------------------------------------------------------------

/** What codex-subscription is, for `llm:status` and Settings > Models. */
export const CODEX_STATUS = [
	"codex-subscription runs the claims check on your ChatGPT plan through the installed Codex CLI (`codex app-server`), on your Mac only.",
	"Each call is a pure model call: no tool can run (every tool feature off, no execution environment, untrusted approval with every request declined and the turn aborted), the process runs in sandbox-exec with your home unreadable, in an empty temp directory deleted afterwards, and Codex keeps no session.",
	"It reads Codex's ChatGPT access token without changing your login, starts only while every usage window is below 90%, and records a call that spent ChatGPT credits as paid.",
].join(" ");

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AccountInfo,
	ApiKeySource,
	Options,
	PermissionMode,
	SDKAssistantMessageError,
	SDKControlGetUsageResponse,
	SDKMessage,
	SDKRateLimitInfo,
	SDKResultError,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
	fullPrompt,
	type GenerateObjectRequest,
	type LlmProvider,
	type LlmUsage,
	redactRequest,
	type SubscriptionPauseKind,
	SubscriptionUnavailableError,
} from "@offerfinch/core/scoring/llm";
import type {
	PlanUsageCall,
	PlanUsageSink,
} from "@offerfinch/core/scoring/plan-usage";
import { z } from "zod";

import {
	ERROR_NAMES,
	knownName,
	parseAnswer,
	schemaCheckFailure,
} from "./answer";
import { Breaker } from "./breaker";
import { subscriptionEnv } from "./env";
import {
	type ClaudeQuery,
	type ClaudeSession,
	isolatedQuery,
} from "./isolated";
import { claudeRateLimitSnapshot, claudeUsageSnapshot } from "./plan-usage";

export const CLAUDE_SUBSCRIPTION = "claude-subscription";
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * The only tool the model may see: the SDK's structured-output carrier, which returns the JSON
 * answer and touches nothing. The SDK also sends an inert `DeferredToolPlaceholder` (deferred,
 * "never call this tool") on some requests; the wire test allows exactly these two.
 */
export const ALLOWED_TOOLS: readonly string[] = ["StructuredOutput"];

/** Skills built into the pinned CLI that `skills: []` and the disable switches do not unlist. */
export const BUILTIN_SKILLS: readonly string[] = ["doctor", "plugin-authoring"];

/**
 * The tool names a log or error may name: the allowed carrier and the SDK's inert placeholder.
 * Any other name (tool, MCP server, skill, plugin, agent) in a session report is counted, never
 * kept: it comes from the CLI's output, and a name that is not the protocol's may be the user's
 * text.
 */
const KNOWN_TOOLS: ReadonlySet<string> = new Set([
	...ALLOWED_TOOLS,
	"DeferredToolPlaceholder",
]);
const KNOWN_SKILLS: ReadonlySet<string> = new Set(BUILTIN_SKILLS);
const PERMISSION_MODES: ReadonlySet<string> = new Set(
	Object.keys({
		default: 1,
		acceptEdits: 1,
		bypassPermissions: 1,
		plan: 1,
		dontAsk: 1,
		auto: 1,
	} satisfies Record<PermissionMode, 1>),
);
const API_KEY_SOURCES: ReadonlySet<string> = new Set(
	Object.keys({
		ANTHROPIC_API_KEY: 1,
		apiKeyHelper: 1,
		"/login managed key": 1,
		none: 1,
		user: 1,
		project: 1,
		org: 1,
		temporary: 1,
		oauth: 1,
	} satisfies Record<ApiKeySource, 1>),
);
const API_PROVIDERS: ReadonlySet<string> = new Set(
	Object.keys({
		firstParty: 1,
		bedrock: 1,
		vertex: 1,
		foundry: 1,
		anthropicAws: 1,
		anthropicGoogleCloud: 1,
		mantle: 1,
		gateway: 1,
	} satisfies Record<NonNullable<AccountInfo["apiProvider"]>, 1>),
);

/**
 * The plan and token source a log may name (the SDK types both as plain strings: these are the
 * values seen from the pinned CLI); anything else is "other".
 */
const SUBSCRIPTION_TYPES: ReadonlySet<string> = new Set([
	"pro",
	"max",
	"team",
	"enterprise",
]);
const TOKEN_SOURCES: ReadonlySet<string> = new Set(["claude.ai"]);

function counted(n: number, what: string): string {
	return `${n} ${what}${n === 1 ? "" : "s"}`;
}

/**
 * Environment additions for every subscription CLI run. No telemetry or other nonessential
 * traffic carries posting text; no CLI-side retries, so one call is one request (the workflow
 * step retries instead); no bundled skills or auto-memory.
 */
const EXTRA_ENV = {
	CLAUDE_CODE_MAX_RETRIES: "0",
	MAX_STRUCTURED_OUTPUT_RETRIES: "1",
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
	DISABLE_TELEMETRY: "1",
	DISABLE_AUTOUPDATER: "1",
	CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
	CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
	CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
	CLAUDE_CODE_DISABLE_WORKFLOWS: "1",
	CLAUDE_AGENT_SDK_CLIENT_APP: "offerfinch/local",
} as const;

export interface ClaudeQueryInput {
	model: string;
	effort?: ClaudeEffort;
	system: string;
	schema: Record<string, unknown>;
	/** An empty directory made for this call. */
	cwd: string;
	env: Record<string, string>;
	maxTokens?: number;
	abortController?: AbortController;
}

/**
 * The SDK options of every subscription call: a pure model call. No built-in tools, no MCP
 * servers (strict: none from settings or plugins), no filesystem settings (so no CLAUDE.md,
 * hooks, permissions, skills or plugins of the user's), no plugins, no skills, no session
 * written to disk, hooks and auto-memory off in the policy tier, an empty working directory,
 * and `dontAsk`, so anything not allowed is denied rather than asked about.
 */
export function claudeQueryOptions(input: ClaudeQueryInput): Options {
	return {
		model: input.model,
		...(input.effort ? { effort: input.effort } : {}),
		systemPrompt: input.system,
		tools: [],
		allowedTools: [],
		settingSources: [],
		strictMcpConfig: true,
		mcpServers: {},
		plugins: [],
		skills: [],
		agents: {},
		persistSession: false,
		permissionMode: "dontAsk",
		cwd: input.cwd,
		env: {
			...input.env,
			...EXTRA_ENV,
			...(input.maxTokens
				? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(input.maxTokens) }
				: {}),
		},
		managedSettings: {
			disableAllHooks: true,
			autoMemoryEnabled: false,
			disableBundledSkills: true,
		},
		outputFormat: { type: "json_schema", schema: input.schema },
		...(input.abortController
			? { abortController: input.abortController }
			: {}),
	};
}

/** The structured-output schema as the SDK takes it (JSON Schema, draft 7). */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
	const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<
		string,
		unknown
	>;
	delete json.$schema;
	return json;
}

/** What the session reported at start, checked before the prompt is sent. */
export interface SessionReport {
	tools: string[];
	mcpServers: string[];
	skills: string[];
	plugins: string[];
	agents: string[];
	slashCommands: number;
	apiKeySource: string;
	model: string;
	cwd: string;
	permissionMode: string;
}

export function sessionReport(
	init: Extract<SDKMessage, { type: "system"; subtype: "init" }>,
): SessionReport {
	return {
		tools: init.tools,
		mcpServers: init.mcp_servers.map((s) => s.name),
		skills: init.skills,
		plugins: init.plugins.map((p) => p.name),
		agents: init.agents ?? [],
		slashCommands: init.slash_commands.length,
		apiKeySource: init.apiKeySource,
		model: init.model,
		cwd: init.cwd,
		permissionMode: init.permissionMode,
	};
}

/**
 * Every way the session could reach past a pure model call; empty when it cannot. Decided on the
 * real names; said with counts and protocol-defined values only (this text reaches the error,
 * so the spending ledger and logs).
 */
export function boundaryViolations(
	report: SessionReport,
	cwd: string,
): string[] {
	const problems: string[] = [];
	const extraTools = report.tools.filter((t) => !ALLOWED_TOOLS.includes(t));
	if (extraTools.length)
		problems.push(counted(extraTools.length, "unexpected tool"));
	if (report.mcpServers.length)
		problems.push(counted(report.mcpServers.length, "MCP server"));
	// The CLI's own built-in skills stay listed; with no Skill tool they cannot run, and the
	// wire test shows they are not sent. Any other skill (the user's) is refused.
	const userSkills = report.skills.filter((s) => !BUILTIN_SKILLS.includes(s));
	if (userSkills.length)
		problems.push(counted(userSkills.length, "unexpected skill"));
	const userPlugins = report.plugins.filter((p) => !p.startsWith("cc-plugin-"));
	if (userPlugins.length)
		problems.push(counted(userPlugins.length, "unexpected plugin"));
	if (report.permissionMode !== "dontAsk")
		problems.push(
			`permission mode ${knownName(report.permissionMode, PERMISSION_MODES)}`,
		);
	// macOS reports /var/folders/... as /private/var/folders/...
	if (report.cwd.replace(/^\/private/, "") !== cwd.replace(/^\/private/, ""))
		problems.push("a working directory other than the call's own");
	return problems;
}

/**
 * The session report as it may be logged: the allowlisted tool and skill names and the
 * protocol's own values; every other name only counted. `model` is kept when it is the one asked
 * for.
 */
export function loggableSessionReport(
	report: SessionReport,
	model: string,
): Record<string, unknown> {
	const known = (names: string[], allowed: ReadonlySet<string>) =>
		names.filter((name) => allowed.has(name));
	return {
		tools: known(report.tools, KNOWN_TOOLS),
		otherTools: report.tools.length - known(report.tools, KNOWN_TOOLS).length,
		mcpServers: report.mcpServers.length,
		skills: known(report.skills, KNOWN_SKILLS),
		otherSkills:
			report.skills.length - known(report.skills, KNOWN_SKILLS).length,
		plugins: report.plugins.length,
		agents: report.agents.length,
		slashCommands: report.slashCommands,
		apiKeySource: knownName(report.apiKeySource, API_KEY_SOURCES),
		model: report.model === model ? model : "other",
		permissionMode: knownName(report.permissionMode, PERMISSION_MODES),
	};
}

/** The login as it may be logged: known values only, anything else "other". */
function loggableAuth(auth: AuthReport | null): Record<string, unknown> | null {
	const named = (value: string | null, known: ReadonlySet<string>) =>
		value === null ? null : knownName(value, known);
	return (
		auth && {
			loggedIn: auth.loggedIn,
			subscriptionType: named(auth.subscriptionType, SUBSCRIPTION_TYPES),
			tokenSource: named(auth.tokenSource, TOKEN_SOURCES),
			apiKeySource:
				auth.apiKeySource === null
					? null
					: knownName(auth.apiKeySource, API_KEY_SOURCES),
			apiProvider:
				auth.apiProvider === null
					? null
					: knownName(auth.apiProvider, API_PROVIDERS),
		}
	);
}

/** The login, from non-secret fields only. */
export interface AuthReport {
	loggedIn: boolean;
	subscriptionType: string | null;
	tokenSource: string | null;
	apiKeySource: string | null;
	apiProvider: string | null;
}

export function authReport(account: AccountInfo): AuthReport {
	return {
		loggedIn: Boolean(account.subscriptionType || account.email),
		subscriptionType: account.subscriptionType ?? null,
		tokenSource: account.tokenSource ?? null,
		apiKeySource: account.apiKeySource ?? null,
		apiProvider: account.apiProvider ?? null,
	};
}

/** True when a rate-limit report says this request drew, or would draw, on extra usage. */
export function drawsOnExtraUsage(info: {
	status?: string;
	rateLimitType?: string;
	overageStatus?: string;
	isUsingOverage?: boolean;
	overageInUse?: boolean;
}): boolean {
	return Boolean(
		info.isUsingOverage ||
			info.overageInUse ||
			info.rateLimitType === "overage" ||
			(info.status === "rejected" &&
				(info.overageStatus === "allowed" ||
					info.overageStatus === "allowed_warning")),
	);
}

/** How long the usage probe may take before it counts as unread. */
const USAGE_CHECK_MS = 30_000;
/**
 * How long a session may go on after its result or its first problem before it is closed. A
 * session closed this way after its result keeps its answer; the call is logged as unclear and
 * settled on the plan.
 */
const DRAIN_MS = 15_000;
/**
 * How the pinned SDK (0.3.316) ends a session whose CLI exited after an error result: it throws
 * `Error("Claude Code returned an error result: <the result's text>")`. When that result was
 * already read, the throw only repeats it; the session ended by itself.
 */
const SDK_ERROR_RESULT_ECHO = "Claude Code returned an error result";

/**
 * The values the SDK's protocol defines for the fields an error may name (`satisfies` keeps each
 * list whole against the installed SDK's types). Anything else is kept as "other": these fields
 * come from the CLI's output, and a value that is not the protocol's may be the user's text.
 */
const API_ERRORS = new Set(
	Object.keys({
		authentication_failed: 1,
		oauth_org_not_allowed: 1,
		account_on_hold: 1,
		verification_required: 1,
		billing_error: 1,
		rate_limit: 1,
		overloaded: 1,
		invalid_request: 1,
		model_not_found: 1,
		server_error: 1,
		unknown: 1,
		max_output_tokens: 1,
		cloud_credential_error: 1,
	} satisfies Record<SDKAssistantMessageError, 1>),
);
const RESULT_ERRORS = new Set(
	Object.keys({
		error_during_execution: 1,
		error_max_turns: 1,
		error_max_budget_usd: 1,
		error_max_structured_output_retries: 1,
	} satisfies Record<SDKResultError["subtype"], 1>),
);
const RATE_LIMITS = new Set(
	Object.keys({
		five_hour: 1,
		seven_day: 1,
		seven_day_opus: 1,
		seven_day_sonnet: 1,
		seven_day_overage_included: 1,
		overage: 1,
	} satisfies Record<NonNullable<SDKRateLimitInfo["rateLimitType"]>, 1>),
);
/**
 * A call needs a plan-usage read this recent before it starts, or a probe reads one: what the
 * plan did since (the user's own work) would otherwise be read as the call's.
 */
const USAGE_BASELINE_MS = 10_000;

/** The system prompt of a probe session: it never receives a prompt. */
export const USAGE_PROBE_SYSTEM = "usage probe; no prompt is sent";

/**
 * A session that sends no prompt and reads the login and the plan's usage report. Allowed
 * nonessential traffic (the pinned CLI fetches the usage report only then); no prompt, so
 * nothing of the user's is in it.
 */
export async function probeUsage(
	query: ClaudeQuery,
	model: string,
	env: Record<string, string>,
): Promise<{
	auth: { kind: SubscriptionPauseKind; detail: string } | null;
	account: AuthReport | null;
	/** The plan's usage report as read, for Settings › Models; null when it could not be. */
	usage: SDKControlGetUsageResponse | null;
}> {
	const cwd = await mkdtemp(join(tmpdir(), "offerfinch-claude-probe-"));
	let stop: () => void = () => {};
	const closed = new Promise<boolean>((resolve) => {
		stop = () => resolve(false);
	});
	// The prompt never comes: the session ends at `stop`, having sent nothing.
	async function* input(): AsyncGenerator<SDKUserMessage> {
		if (await closed) yield undefined as never;
	}
	const options = claudeQueryOptions({
		model,
		system: USAGE_PROBE_SYSTEM,
		schema: { type: "object" },
		cwd,
		env,
	});
	const probeEnv = { ...(options.env as Record<string, string>) };
	delete probeEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
	const session = query({
		prompt: input(),
		options: { ...options, env: probeEnv },
	});
	const timeout = <T>(promise: Promise<T>): Promise<T | null> =>
		Promise.race([
			promise.catch(() => null),
			new Promise<null>((resolve) =>
				setTimeout(() => resolve(null), USAGE_CHECK_MS).unref(),
			),
		]);
	try {
		const init = await timeout(session.initializationResult());
		if (!init)
			return {
				auth: {
					kind: "logged_out",
					detail:
						"the Claude Code CLI did not start or did not report its login. Check Settings › Models.",
				},
				account: null,
				usage: null,
			};
		const account = authReport(init.account);
		const auth = authProblem(account, "none");
		if (auth) return { auth, account, usage: null };
		const usage = await timeout(Promise.resolve().then(() => session.usage()));
		return { auth: null, account, usage };
	} finally {
		stop();
		session.close();
		await rm(cwd, { recursive: true, force: true });
	}
}

/** Why this login must not be used for a subscription call, or null when it may. */
export function authProblem(
	auth: AuthReport,
	sessionApiKeySource: string,
): { kind: SubscriptionPauseKind; detail: string } | null {
	const keySource = auth.apiKeySource ?? sessionApiKeySource;
	if (keySource && keySource !== "none")
		return {
			kind: "not_subscription",
			detail: `Claude Code would authenticate with an API key (${knownName(keySource, API_KEY_SOURCES)}), billed per token. Remove it from Claude Code's own configuration; this app never passes one.`,
		};
	if (auth.apiProvider && auth.apiProvider !== "firstParty")
		return {
			kind: "not_subscription",
			detail: `Claude Code is set to ${knownName(auth.apiProvider, API_PROVIDERS)}, not a Claude subscription.`,
		};
	if (!auth.subscriptionType)
		return {
			kind: "logged_out",
			detail:
				"Claude Code is not logged in to a Claude subscription. Run `claude` and `/login` with your Claude Pro or Max account, then check Settings › Models. Preparation retries after the next scan.",
		};
	return null;
}

export interface ClaudeSubscriptionOptions {
	model: string;
	effort?: ClaudeEffort;
	/** The one user whose plan this is (the owner account id). */
	ownerUserId: string;
	/** The parent environment; only the allowlist reaches the CLI. */
	parentEnv?: Record<string, string | undefined>;
	/** Injected in tests. Default: the SDK in its own scrubbed process (`isolated.ts`). */
	query?: ClaudeQuery;
	log?: (message: string, data?: Record<string, unknown>) => void;
	breaker?: Breaker;
	now?: () => Date;
	/** How long a session is read after its result or first problem. Default `DRAIN_MS`. */
	drainMs?: number;
	/** Where the plan's usage, as each probe and call reads it, is reported (Settings › Models). */
	planUsage?: PlanUsageSink;
}

/** One process-wide breaker per vendor: a limit or logout stops every caller, not just one. */
const CLAUDE_BREAKER = new Breaker();

/** What `inspect` reads a message against. */
interface InspectContext {
	cwd: string;
	removed: string[];
	account: () => AuthReport | null;
	usageCall?: PlanUsageCall;
}

/** The one prompt, handed over once the gate opens; nothing when it closes. */
async function* promptInput(
	gate: Promise<boolean>,
	prompt: string,
	sent: () => void,
): AsyncGenerator<SDKUserMessage> {
	if (!(await gate)) return;
	sent();
	yield {
		type: "user",
		message: { role: "user", content: prompt },
		parent_tool_use_id: null,
	} as SDKUserMessage;
}

/**
 * Structured generation on the user's Claude subscription through the Claude Agent SDK (the
 * local Claude Code CLI). Local only: it starts a subprocess. Each call runs in an empty temp
 * directory with no tools but the structured-output carrier, no settings, MCP, skills, plugins,
 * hooks or memory, and an allowlisted environment (no API keys). The prompt is sent only after
 * the session has shown it holds that boundary and is logged in to a subscription.
 */
export class ClaudeSubscriptionProvider implements LlmProvider {
	readonly name: string;
	readonly billing = "subscription" as const;
	readonly vendor = "anthropic";
	readonly ownerUserId: string;
	private readonly query: ClaudeQuery;
	private readonly breaker: Breaker;
	private readonly now: () => Date;

	constructor(private readonly options: ClaudeSubscriptionOptions) {
		if (!options.ownerUserId)
			throw new Error("claude-subscription needs the owner's account id");
		this.name = `${CLAUDE_SUBSCRIPTION}:${options.model}`;
		this.ownerUserId = options.ownerUserId;
		this.query = options.query ?? isolatedQuery;
		this.breaker = options.breaker ?? CLAUDE_BREAKER;
		this.now = options.now ?? (() => new Date());
	}

	async generateObject<T>(raw: GenerateObjectRequest<T>): Promise<T> {
		const request = redactRequest(raw);
		// A limit or logout seen by another call: fail fast, no CLI started.
		const open = this.breaker.current(this.now());
		if (open) throw open;
		await this.sampleBaseline();
		const schema = jsonSchemaOf(request.schema as z.ZodType);
		const usageCall = this.options.planUsage?.call();
		try {
			// One prompt, exactly the request the caller reserved for. An answer that fails the
			// schema (the CLI's own check, MAX_STRUCTURED_OUTPUT_RETRIES=1: one attempt, or Zod's)
			// is an ordinary failed call; a retry is the caller's, metered as a call of its own.
			const answer = await this.run(
				request.system,
				fullPrompt(request),
				schema,
				request.maxTokens,
				() => {
					usageCall?.sent();
					request.onModelCall?.();
				},
				request.onUsage,
				usageCall,
			);
			if (answer.invalid !== undefined)
				throw new Error(
					`${this.name}: no valid structured output for ${request.task}: ${answer.invalid}`,
				);
			return parseAnswer(
				request.schema,
				answer.output,
				this.name,
				request.task,
			);
		} catch (error) {
			if (error instanceof SubscriptionUnavailableError)
				this.breaker.trip(error, this.now());
			throw error;
		} finally {
			usageCall?.done();
		}
	}

	/**
	 * Before a call, reads the plan's usage when no read is recent enough to be the call's
	 * baseline (Settings › Models shows OfferFinch's share). Display only: it never pauses or
	 * refuses a call. Whether extra usage may pay is the user's account setting, as in T3 Code.
	 * The probe sends no prompt; it runs without CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
	 * because the pinned CLI fetches the plan's usage only then.
	 */
	private async sampleBaseline(): Promise<void> {
		if (!this.options.planUsage?.baselineNeeded(USAGE_BASELINE_MS)) return;
		const report = await probeUsage(
			this.query,
			this.options.model,
			subscriptionEnv(this.options.parentEnv).env,
		).catch(() => null);
		if (!report?.usage) return;
		const snapshot = claudeUsageSnapshot(report.usage, this.now());
		if (snapshot) this.options.planUsage?.sample(snapshot);
	}

	private pause(
		kind: SubscriptionPauseKind,
		detail: string,
		resetsAt?: Date,
	): SubscriptionUnavailableError {
		return new SubscriptionUnavailableError(kind, this.name, detail, resetsAt);
	}

	/**
	 * One CLI session. The login is checked from the CLI's initialize answer before the prompt
	 * exists for it (a refused login sends nothing). The session's init report (tools, MCP,
	 * skills) arrives with the first request; a violation there aborts and discards the answer,
	 * a tripwire behind the pinned, wire-tested options.
	 *
	 * Every ending is on the plan, as T3 Code treats it; extra usage, when the user's account
	 * allows it, never stops a call. A session that ended unclearly around its answer (an error or crash result, an
	 * assistant error, an abort, a stream error, or still open `DRAIN_MS` after its result) keeps
	 * the answer and is logged as a warning.
	 */
	// biome-ignore lint/complexity/useMaxParams: Keep the metering callbacks and their positional contract unchanged.
	private async run(
		system: string,
		prompt: string,
		schema: Record<string, unknown>,
		maxTokens?: number,
		onModelCall?: () => void,
		onUsage?: (usage: LlmUsage) => void,
		usageCall?: PlanUsageCall,
	): Promise<{ output: unknown; invalid?: string }> {
		const cwd = await mkdtemp(join(tmpdir(), "offerfinch-claude-"));
		const abort = new AbortController();
		let release: (send: boolean) => void = () => {};
		const gate = new Promise<boolean>((resolve) => {
			release = resolve;
		});
		/** The prompt was handed to the CLI: a result before it answers nothing of ours. */
		let promptSent = false;
		const { env, removed } = subscriptionEnv(this.options.parentEnv);
		const session: ClaudeSession = this.query({
			prompt: promptInput(gate, prompt, () => {
				promptSent = true;
			}),
			options: claudeQueryOptions({
				model: this.options.model,
				effort: this.options.effort,
				system,
				schema,
				cwd,
				env,
				abortController: abort,
				maxTokens,
			}),
		});
		let failure: Error | null = null;
		/** This side cancelled the session: whatever it says after, it is not complete. */
		let aborted = false;
		const stop = (error: Error) => {
			failure ??= error;
			release(false);
			aborted = true;
			abort.abort();
		};
		let account: AuthReport | null = null;
		const ctx = { cwd, removed, account: () => account, usageCall };
		const authChecked = session.initializationResult().then(
			async (init) => {
				account = authReport(init.account);
				const problem = authProblem(account, "none");
				if (problem) {
					stop(this.pause(problem.kind, problem.detail));
					return;
				}
				onModelCall?.();
				release(true);
			},
			(error: unknown) =>
				stop(
					this.pause(
						"logged_out",
						// The error's name only: its text can carry the CLI's stderr.
						`the Claude Code CLI did not start (${knownName(error instanceof Error ? error.name : null, ERROR_NAMES)}). Check Settings › Models.`,
					),
				),
		);
		let output: unknown;
		let resultError: string | null = null;
		let invalid: string | undefined;
		let gotResult = false;
		/** The stream itself failed (the CLI exits non-zero after an error result, or on abort). */
		let streamError: Error | null = null;
		/**
		 * Nothing in the session failed: every result says the model produced output (not a crash,
		 * startup or error result), for the prompt that was sent, and no assistant message carried
		 * an error (paused or not). Only for the log.
		 */
		let clean = true;
		let timedOut = false;
		let drainTimer: ReturnType<typeof setTimeout> | undefined;
		let expire: () => void = () => {};
		const drained = new Promise<"drained">((resolve) => {
			expire = () => resolve("drained");
		});
		const drainSoon = () => {
			drainTimer ??= setTimeout(expire, this.options.drainMs ?? DRAIN_MS);
		};
		const messages = session[Symbol.asyncIterator]();
		try {
			while (true) {
				const next = await Promise.race([messages.next(), drained]);
				if (next === "drained") {
					timedOut = true;
					break;
				}
				if (next.done) break;
				const message = next.value;
				if (message.type === "assistant" && message.error) clean = false;
				const problem = this.inspect(message, ctx);
				if (problem) {
					stop(problem);
					drainSoon();
				}
				if (message.type === "result") {
					gotResult = true;
					if (
						!promptSent ||
						!(
							(message.subtype === "success" && !message.is_error) ||
							message.subtype === "error_max_structured_output_retries"
						)
					)
						clean = false;
					drainSoon();
					// Reported as soon as the answer arrives, whatever it says: it was used.
					const usage = resultUsage(message, this.options.model);
					if (usage) onUsage?.(usage);
					if (message.subtype === "success" && !message.is_error)
						output = message.structured_output;
					else if (message.subtype === "error_max_structured_output_retries")
						invalid = schemaCheckFailure(message.errors, schema);
					else resultError = resultFailure(message);
				}
			}
		} catch (error) {
			// The SDK re-throws an error result it already delivered (an answer that failed the
			// schema, for one) when the CLI exits: the result decides, not the repeat.
			streamError = streamFailure(error, gotResult);
		} finally {
			clearTimeout(drainTimer);
			release(false);
			await authChecked.catch(() => {});
			session.close();
			await rm(cwd, { recursive: true, force: true });
		}
		// The prompt went out but no answer came back (the stream was lost, the CLI exited without
		// one, this side stopped it): the call settles on the plan at $0 all the same, logged.
		if (promptSent && !gotResult) this.warnNoAnswer(failure, streamError);
		// The answer arrived from a session that did not end cleanly: on the plan all the same
		// but logged.
		if (gotResult && !refusal(failure)) {
			const unclear = [
				resultError,
				!clean && resultError === null && "an error in the session",
				aborted && failure && `stopped: ${(failure as Error).message}`,
				streamError && `stream: ${streamError.message}`,
				timedOut &&
					`still open ${Math.round((this.options.drainMs ?? DRAIN_MS) / 1000)} s after its answer`,
			].filter(Boolean);
			if (!clean || aborted || streamError || timedOut)
				this.options.log?.(
					"warning: claude subscription call ended unclearly; settled on the plan",
					{
						provider: this.name,
						detail: unclear.join("; ").slice(0, 300),
					},
				);
		}
		if (failure) throw failure;
		// The CLI exits non-zero after an error result, or when aborted: the result decides.
		if (!gotResult && streamError) throw streamError;
		if (!gotResult)
			throw new Error(`${this.name}: the CLI ended without an answer`);
		if (invalid !== undefined) return { output: undefined, invalid };
		if (resultError !== null && output === undefined)
			throw new Error(`${this.name} returned no answer: ${resultError}`);
		return { output };
	}

	/**
	 * A sent prompt got no answer (the stream was lost, the CLI exited without one, this side
	 * stopped it): it settles on the plan at $0 like an unclear answer, so it is logged the same
	 * way. A usage-limit or logout refusal is the vendor's answer, not unclear.
	 */
	private warnNoAnswer(failure: Error | null, streamError: Error | null) {
		if (refusal(failure)) return;
		const detail = [
			streamError && `stream: ${streamError.message}`,
			failure && `stopped: ${failure.message}`,
			!streamError && !failure && "the CLI ended without an answer",
		].filter(Boolean);
		this.options.log?.(
			"warning: claude subscription call got no answer after its prompt was sent; settled on the plan",
			{ provider: this.name, detail: detail.join("; ").slice(0, 300) },
		);
	}

	/** A reason to stop the session now, from one of its messages, or null. */
	private inspect(
		message: SDKMessage,
		{ cwd, removed, account, usageCall }: InspectContext,
	): Error | null {
		if (message.type === "system" && message.subtype === "init") {
			const report = sessionReport(message);
			this.options.log?.("claude subscription session", {
				provider: this.name,
				claudeCodeVersion: /^\d+\.\d+\.\d+$/.test(message.claude_code_version)
					? message.claude_code_version
					: "other",
				...loggableSessionReport(report, this.options.model),
				// The login from the CLI's initialize answer, apart from the session's own fields.
				auth: loggableAuth(account()),
				// Names of variables this side removed from the parent's environment (its own
				// filter's matches: API keys and the like), never values.
				removedEnv: removed,
			});
			const problems = boundaryViolations(report, cwd);
			if (problems.length)
				return this.pause(
					"boundary",
					`the Claude Agent SDK session was not a pure model call (${problems.join("; ")}); the answer is discarded.`,
				);
			const auth = authProblem(
				account() ?? {
					loggedIn: false,
					subscriptionType: null,
					tokenSource: null,
					apiKeySource: null,
					apiProvider: null,
				},
				report.apiKeySource,
			);
			return auth ? this.pause(auth.kind, auth.detail) : null;
		}
		if (message.type === "rate_limit_event") {
			const info = message.rate_limit_info;
			const snapshot = usageCall && claudeRateLimitSnapshot(info, this.now());
			if (snapshot) usageCall?.sample(snapshot);
			const resetsAt = info.resetsAt
				? new Date(info.resetsAt * 1000)
				: undefined;
			// Extra usage paid for it: the user's account setting allows that, so the call goes on.
			if (drawsOnExtraUsage(info)) return null;
			if (info.status === "rejected")
				return this.pause(
					"usage_limit",
					`the Claude plan's ${info.rateLimitType ? knownName(info.rateLimitType, RATE_LIMITS) : "usage"} limit is reached${resetsAt ? ` until ${resetsAt.toISOString()}` : ""}. Preparation waits; it resumes after a later scan once the limit resets, with status in Settings › Models.`,
					resetsAt,
				);
			return null;
		}
		if (message.type === "system" && message.subtype === "api_retry") {
			const kind = assistantErrorKind(message.error);
			if (kind) return this.pause(kind, PAUSE_DETAIL[kind]);
			// One call is one request: the workflow step retries, not the CLI.
			return new Error(
				`${this.name}: request failed (${knownName(message.error, API_ERRORS)}, HTTP ${typeof message.error_status === "number" ? message.error_status : "?"}); not retried by the CLI`,
			);
		}
		if (message.type === "assistant" && message.error) {
			const kind = assistantErrorKind(message.error);
			if (kind) return this.pause(kind, PAUSE_DETAIL[kind]);
		}
		return null;
	}
}

/**
 * An error result in fixed words and counts: its text and errors can quote the answer, and error
 * messages are kept (the spending ledger).
 */
function resultFailure(
	message: Extract<SDKMessage, { type: "result" }>,
): string {
	if (message.subtype === "success")
		return `an error result of ${String(message.result ?? "").length} characters, not kept`;
	return `${knownName(message.subtype, RESULT_ERRORS)} (${(message.errors ?? []).length} errors, not kept)`;
}

/**
 * A stream error that is a session failure, or null when the SDK only repeated an error result
 * the session already delivered (the session then ended by itself).
 */
function streamFailure(error: unknown, gotResult: boolean): Error | null {
	const thrown = error instanceof Error ? error : new Error(String(error));
	if (gotResult && thrown.message.startsWith(SDK_ERROR_RESULT_ECHO))
		return null;
	// Its text is not kept: the SDK's errors carry the result's text or the CLI's stderr.
	const kept = new Error(
		thrown.message.startsWith(SDK_ERROR_RESULT_ECHO)
			? "the Claude Code CLI ended with an error result (its text is not kept)"
			: `the Claude Code CLI's stream failed (${knownName(thrown.name, ERROR_NAMES)}; its text is not kept)`,
	);
	kept.name = ERROR_NAMES.has(thrown.name) ? thrown.name : "Error";
	return kept;
}

/** The vendor refused the request before processing it (a 429 or a logout): not billed. */
function refusal(error: Error | null): boolean {
	return (
		error instanceof SubscriptionUnavailableError &&
		!error.paid &&
		(error.kind === "usage_limit" || error.kind === "logged_out")
	);
}

const PAUSE_DETAIL: Record<SubscriptionPauseKind, string> = {
	usage_limit:
		"the Claude plan's usage limit is reached. Preparation waits; it resumes after a later scan once the limit resets, with status in Settings › Models.",
	logged_out:
		"Claude Code is not logged in, or its login was refused. Run `claude` and `/login`, then check Settings › Models. Preparation retries after the next scan.",
	not_subscription:
		"Claude Code would bill something other than the subscription.",
	boundary: "the session was not a pure model call.",
	extra_usage: "paid extra usage could pay for this call.",
	not_owner: "another account's call.",
	call_budget:
		"the subscription's call budget for the last 24 hours is used up.",
};

function assistantErrorKind(
	error: string | null | undefined,
): SubscriptionPauseKind | null {
	if (error === "rate_limit" || error === "billing_error") return "usage_limit";
	if (
		error === "authentication_failed" ||
		error === "oauth_org_not_allowed" ||
		error === "account_on_hold" ||
		error === "verification_required"
	)
		return "logged_out";
	return null;
}

/**
 * The tokens a result reports: `modelUsage` (every model call), else the main loop's `usage`
 * when a result carries no per-model entry. All zeros is no report (a zeroed crash result).
 */
export function resultUsage(
	message: {
		modelUsage?: Parameters<typeof usageOf>[0];
		usage?: {
			input_tokens?: number | null;
			output_tokens?: number | null;
			cache_read_input_tokens?: number | null;
			cache_creation_input_tokens?: number | null;
		};
	},
	fallbackModel: string,
): LlmUsage | null {
	const usage =
		usageOf(message.modelUsage ?? {}, fallbackModel) ??
		(message.usage
			? {
					model: fallbackModel,
					inputTokens: message.usage.input_tokens ?? 0,
					outputTokens: message.usage.output_tokens ?? 0,
					cachedInputTokens: message.usage.cache_read_input_tokens ?? 0,
					cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
				}
			: null);
	if (!usage) return null;
	const total =
		usage.inputTokens +
		usage.outputTokens +
		usage.cachedInputTokens +
		usage.cacheWriteTokens;
	return total > 0 ? usage : null;
}

/** The tokens of every model the session used; the model is the one that wrote the most. */
export function usageOf(
	modelUsage: Record<
		string,
		{
			inputTokens: number;
			outputTokens: number;
			cacheReadInputTokens: number;
			cacheCreationInputTokens: number;
		}
	>,
	fallbackModel: string,
): LlmUsage | null {
	const entries = Object.entries(modelUsage ?? {});
	if (entries.length === 0) return null;
	const main = entries.reduce((a, b) =>
		b[1].outputTokens > a[1].outputTokens ? b : a,
	);
	const sum: LlmUsage = {
		model: main[0] || fallbackModel,
		inputTokens: 0,
		outputTokens: 0,
		cachedInputTokens: 0,
		cacheWriteTokens: 0,
	};
	for (const [, u] of entries) {
		sum.inputTokens += u.inputTokens;
		sum.outputTokens += u.outputTokens;
		sum.cachedInputTokens += u.cacheReadInputTokens;
		sum.cacheWriteTokens += u.cacheCreationInputTokens;
	}
	return sum;
}

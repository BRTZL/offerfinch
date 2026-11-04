import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AccountInfo,
	Options,
	SDKControlGetUsageResponse,
	SDKMessage,
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

/** Every way the session could reach past a pure model call; empty when it cannot. */
export function boundaryViolations(
	report: SessionReport,
	cwd: string,
): string[] {
	const problems: string[] = [];
	const extraTools = report.tools.filter((t) => !ALLOWED_TOOLS.includes(t));
	if (extraTools.length) problems.push(`tools ${extraTools.join(", ")}`);
	if (report.mcpServers.length)
		problems.push(`MCP servers ${report.mcpServers.join(", ")}`);
	// The CLI's own built-in skills stay listed; with no Skill tool they cannot run, and the
	// wire test shows they are not sent. Any other skill (the user's) is refused.
	const userSkills = report.skills.filter((s) => !BUILTIN_SKILLS.includes(s));
	if (userSkills.length) problems.push(`skills ${userSkills.join(", ")}`);
	const userPlugins = report.plugins.filter((p) => !p.startsWith("cc-plugin-"));
	if (userPlugins.length) problems.push(`plugins ${userPlugins.join(", ")}`);
	if (report.permissionMode !== "dontAsk")
		problems.push(`permission mode ${report.permissionMode}`);
	// macOS reports /var/folders/... as /private/var/folders/...
	if (report.cwd.replace(/^\/private/, "") !== cwd.replace(/^\/private/, ""))
		problems.push(`working directory ${report.cwd}`);
	return problems;
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

/** Whether the Claude account can draw on paid extra usage, from the plan's usage report. */
export interface ExtraUsageReport {
	state: "off" | "on" | "unknown";
	detail: string;
}

export const EXTRA_USAGE_OFF_HOWTO =
	"Turn extra usage off at claude.ai > Settings > Usage; Claude calls continue by themselves once it is off.";

/**
 * Read from the SDK's `get_usage` control before the prompt is sent. Neither the pinned SDK
 * nor its CLI has a per-request switch that keeps a call off extra usage (the CLI learns it
 * from the answer's headers, after the request is billed), so the only guard before sending is
 * the account's own setting: `is_enabled` true means extra usage could pay for this call. A
 * report without plan limits (or none at all) is unknown. A report with plan limits and no
 * `extra_usage` entry means the plan has none ("when the plan has it", in the SDK's types).
 */
export function extraUsageReport(
	usage: SDKControlGetUsageResponse | null,
): ExtraUsageReport {
	if (!usage?.rate_limits_available || !usage.rate_limits)
		return {
			state: "unknown",
			detail:
				"the Claude plan's usage could not be read, so it is not known whether extra usage could pay for this call.",
		};
	const extra = usage.rate_limits.extra_usage;
	if (extra?.is_enabled)
		return {
			state: "on",
			detail: `extra usage is on for this Claude account${extra.monthly_limit !== null ? ` (monthly limit ${extra.monthly_limit} ${extra.currency ?? "minor units"})` : ""}: a call past the plan's limits would be billed per token.`,
		};
	return {
		state: "off",
		detail: extra
			? "extra usage is off for this Claude account."
			: "this Claude plan reports no extra usage.",
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

/** How long the extra-usage check may take before it counts as unknown. */
const USAGE_CHECK_MS = 30_000;
/**
 * How long a session may go on after its result or its first problem before it is closed. A
 * session closed this way after its result has an unknown payment (held).
 */
const DRAIN_MS = 15_000;
/** How long a probe's "extra usage is off" is trusted by the same provider. */
const EXTRA_USAGE_TRUST_MS = 60_000;
/**
 * A call needs a plan-usage read this recent before it starts, or the probe runs even while
 * the extra-usage answer is still trusted: what the plan did since (the user's own work)
 * would otherwise be read as the call's.
 */
const USAGE_BASELINE_MS = 10_000;

/** The system prompt of a probe session: it never receives a prompt. */
export const USAGE_PROBE_SYSTEM = "usage probe; no prompt is sent";

/**
 * A session that sends no prompt and reads the login and the plan's usage report. Allowed
 * nonessential traffic (the pinned CLI fetches the usage report only then); no prompt, so
 * nothing of the user's is in it.
 */
export async function probeExtraUsage(
	query: ClaudeQuery,
	model: string,
	env: Record<string, string>,
): Promise<{
	auth: { kind: SubscriptionPauseKind; detail: string } | null;
	extra: ExtraUsageReport;
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
				extra: extraUsageReport(null),
				account: null,
				usage: null,
			};
		const account = authReport(init.account);
		const auth = authProblem(account, "none");
		if (auth)
			return { auth, extra: extraUsageReport(null), account, usage: null };
		const usage = await timeout(Promise.resolve().then(() => session.usage()));
		return { auth: null, extra: extraUsageReport(usage), account, usage };
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
			detail: `Claude Code would authenticate with an API key (${keySource}), billed per token. Remove it from Claude Code's own configuration; this app never passes one.`,
		};
	if (auth.apiProvider && auth.apiProvider !== "firstParty")
		return {
			kind: "not_subscription",
			detail: `Claude Code is set to ${auth.apiProvider}, not a Claude subscription.`,
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

/**
 * The user reconciled every held Claude call and resumed Claude (Settings > Models): lifts this
 * process's extra-usage pause (a paid call, a payment-unknown or unclear one, extra usage seen
 * on), so the next call is sent. A usage-limit or logout pause stays until it ends by itself.
 */
export function resumeClaudeCalls(breaker: Breaker = CLAUDE_BREAKER): void {
	breaker.clear("extra_usage");
}

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
		try {
			await this.checkExtraUsage();
		} catch (error) {
			if (error instanceof SubscriptionUnavailableError)
				this.breaker.trip(error, this.now());
			throw error;
		}
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
				request.onAnswered,
				request.onBillingUnclear,
				usageCall,
			);
			if (answer.invalid !== undefined)
				throw new Error(
					`${this.name}: no valid structured output for ${request.task}: ${answer.invalid.slice(0, 500)}`,
				);
			return request.schema.parse(answer.output);
		} catch (error) {
			if (error instanceof SubscriptionUnavailableError)
				this.breaker.trip(error, this.now());
			throw error;
		} finally {
			usageCall?.done();
		}
	}

	/** Until when the last probe's "extra usage is off" is trusted. */
	private extraUsageOffUntil = 0;

	/**
	 * No vendor switch keeps a request off extra usage: before a prompt exists, a probe session
	 * reads the plan's usage report and refuses unless the account's own setting says extra
	 * usage cannot pay for a call (fails closed when unknown). The probe sends no prompt; it
	 * runs without CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, because the pinned CLI fetches the
	 * plan's usage only then (with it, `rate_limits` is null). An "off" holds for a minute.
	 */
	private async checkExtraUsage(): Promise<void> {
		const now = this.now().getTime();
		if (
			now < this.extraUsageOffUntil &&
			!this.options.planUsage?.baselineNeeded(USAGE_BASELINE_MS)
		)
			return;
		const report = await probeExtraUsage(
			this.query,
			this.options.model,
			subscriptionEnv(this.options.parentEnv).env,
		);
		if (report.usage) {
			const snapshot = claudeUsageSnapshot(report.usage, this.now());
			if (snapshot) this.options.planUsage?.sample(snapshot);
		}
		if (report.auth) throw this.pause(report.auth.kind, report.auth.detail);
		if (report.extra.state !== "off")
			throw this.pause(
				"extra_usage",
				`${report.extra.detail} Nothing was sent. ${EXTRA_USAGE_OFF_HOWTO}`,
			);
		this.extraUsageOffUntil = now + EXTRA_USAGE_TRUST_MS;
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
	 * Billing is read from the session, and fails closed. A sign of paid extra usage anywhere
	 * wins over every other outcome. `onAnswered` (billed like any answered call, $0 on the plan,
	 * even without tokens) is reported only when all of these hold: the prompt was sent; every
	 * result says the model produced output (`success` without `is_error`, or
	 * `error_max_structured_output_retries`); the session then ended on its own (never aborted:
	 * an abort closes the isolated session at once, exactly like a clean end, so it cannot be
	 * told apart and counts against); no stream error; no problem; no paid sign. A session still
	 * open `DRAIN_MS` after its result is closed and its payment is unknown (held, whatever its
	 * tokens), since a paid sign could still have come.
	 */
	// biome-ignore lint/complexity/useMaxParams: Keep the protected billing callbacks and their positional contract unchanged.
	private async run(
		system: string,
		prompt: string,
		schema: Record<string, unknown>,
		maxTokens?: number,
		onModelCall?: () => void,
		onUsage?: (usage: LlmUsage) => void,
		onAnswered?: () => void,
		onBillingUnclear?: (detail: string) => void,
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
						`the Claude Code CLI did not start (${error instanceof Error ? error.message : String(error)}). Check Settings › Models.`,
					),
				),
		);
		let output: unknown;
		let resultError: string | null = null;
		let invalid: string | undefined;
		let gotResult = false;
		/** The vendor said this call drew on paid extra usage: wins over every other outcome. */
		let paid: SubscriptionUnavailableError | null = null;
		/** The stream itself failed (the CLI exits non-zero after an error result, or on abort). */
		let streamError: Error | null = null;
		/**
		 * Nothing in the session failed: every result says the model produced output (not a crash,
		 * startup or error result), for the prompt that was sent, and no assistant message carried
		 * an error (paused or not).
		 */
		let clean = true;
		/** The iterator ended by itself (also true after an abort; `aborted` tells them apart). */
		let ended = false;
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
				if (next.done) {
					ended = true;
					break;
				}
				const message = next.value;
				if (message.type === "assistant" && message.error) clean = false;
				const problem = this.inspect(message, ctx);
				if (problem) {
					if (
						problem instanceof SubscriptionUnavailableError &&
						problem.paid === true
					) {
						paid ??= problem;
						// Every other caller stops now, not when this session ends.
						this.breaker.trip(problem, this.now());
					}
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
						invalid = message.errors.join("; ") || message.subtype;
					else
						resultError =
							message.subtype === "success"
								? String(message.result).slice(0, 500)
								: `${message.subtype}: ${message.errors.join("; ").slice(0, 500)}`;
				}
			}
		} catch (error) {
			streamError = error instanceof Error ? error : new Error(String(error));
		} finally {
			clearTimeout(drainTimer);
			release(false);
			await authChecked.catch(() => {});
			session.close();
			await rm(cwd, { recursive: true, force: true });
		}
		if (paid) throw paid;
		// Still open after its result: closed here, so a paid sign could have been missed.
		if (timedOut && gotResult && !failure)
			throw new SubscriptionUnavailableError(
				"extra_usage",
				this.name,
				`the Claude session did not end within ${Math.round((this.options.drainMs ?? DRAIN_MS) / 1000)} s of its answer, so whether it drew on paid extra usage is unknown: the answer is discarded, the call is held at its worst case, and Claude calls stop until you check claude.ai usage, reconcile it in Settings > Models, and resume.`,
				undefined,
				"unknown",
			);
		const answeredOnPlan =
			gotResult &&
			clean &&
			ended &&
			!aborted &&
			!timedOut &&
			!streamError &&
			!failure;
		if (answeredOnPlan) onAnswered?.();
		// A result arrived from a session that is not clean or did not end by itself (an error or
		// crash result, an assistant error, an abort or a stream error after it): what it cost is
		// unclear, whatever the answer says and whatever tokens it reported. Decided here, before
		// the answer is checked against the schema. A vendor refusal (a 429 or a logout) is not.
		if (gotResult && !answeredOnPlan && !refusal(failure)) {
			const detail = `${this.name}: the answer arrived, but its session also failed (${
				[
					resultError,
					!clean && resultError === null && "an error in the session",
					aborted && failure && `stopped: ${(failure as Error).message}`,
					streamError && `stream: ${streamError.message}`,
				]
					.filter(Boolean)
					.join("; ")
					.slice(0, 300) || "it did not end cleanly"
			}); held until reconciled with claude.ai usage`;
			// Every later caller in this process stops now; the held row stops the rest.
			this.breaker.trip(
				new SubscriptionUnavailableError(
					"extra_usage",
					this.name,
					`${detail}. Claude calls stop until you check claude.ai usage, reconcile it in Settings > Models, and resume.`,
					undefined,
					"unknown",
				),
				this.now(),
			);
			onBillingUnclear?.(detail);
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

	/** A reason to stop the session now, from one of its messages, or null. */
	private inspect(
		message: SDKMessage,
		{ cwd, removed, account, usageCall }: InspectContext,
	): Error | null {
		if (message.type === "system" && message.subtype === "init") {
			const report = sessionReport(message);
			this.options.log?.("claude subscription session", {
				provider: this.name,
				claudeCodeVersion: message.claude_code_version,
				...report,
				cwd: "(empty temp directory)",
				// The login from the CLI's initialize answer, apart from the session's own fields.
				auth: account(),
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
			// The answer's headers said so: the request is already billed per token.
			if (drawsOnExtraUsage(info))
				return new SubscriptionUnavailableError(
					"extra_usage",
					this.name,
					`Claude drew on paid extra usage for this call (billed per token; recorded at its estimated API price). Every subscription call is paused and the extra-usage confirmation is cleared. ${EXTRA_USAGE_OFF_HOWTO}`,
					resetsAt,
					true,
				);
			if (info.status === "rejected")
				return this.pause(
					"usage_limit",
					`the Claude plan's ${info.rateLimitType ?? "usage"} limit is reached${resetsAt ? ` until ${resetsAt.toISOString()}` : ""}. Preparation waits; it resumes after a later scan once the limit resets, with status in Settings › Models.`,
					resetsAt,
				);
			return null;
		}
		if (message.type === "system" && message.subtype === "api_retry") {
			const kind = assistantErrorKind(message.error);
			if (kind) return this.pause(kind, PAUSE_DETAIL[kind]);
			// One call is one request: the workflow step retries, not the CLI.
			return new Error(
				`${this.name}: request failed (${message.error}, HTTP ${message.error_status ?? "?"}); not retried by the CLI`,
			);
		}
		if (message.type === "assistant" && message.error) {
			const kind = assistantErrorKind(message.error);
			if (kind) return this.pause(kind, PAUSE_DETAIL[kind]);
		}
		return null;
	}
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
	extra_usage: `paid extra usage could pay for this call. ${EXTRA_USAGE_OFF_HOWTO}`,
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

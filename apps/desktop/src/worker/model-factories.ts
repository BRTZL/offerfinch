import { type ApplyDeps, LOCAL_HOSTS } from "@offerfinch/core/apply/submit";
import type { BlobStore } from "@offerfinch/core/export/export";
import { NoopNotifier } from "@offerfinch/core/notify/ntfy";
import type {
	PipelineDeps,
	WorkflowStarter,
} from "@offerfinch/core/pipeline/ports";
import {
	AnthropicProvider,
	DEFAULT_ANTHROPIC_MODEL,
	DEFAULT_TAILOR_MODEL,
} from "@offerfinch/core/scoring/anthropic";
import {
	FakeLlmProvider,
	FakeSubscriptionProvider,
} from "@offerfinch/core/scoring/fake";
import { type LlmProvider, vendorOf } from "@offerfinch/core/scoring/llm";
import { OpenAiProvider } from "@offerfinch/core/scoring/openai";
import type { BrowserProvider } from "@offerfinch/core/scrape/browser";
import { HostRateLimiter } from "@offerfinch/core/scrape/rate-limit";
import { RobotsCache } from "@offerfinch/core/scrape/robots";
import { ScrapeSource } from "@offerfinch/core/scrape/source";
import { AshbySource } from "@offerfinch/core/sources/ashby";
import { GreenhouseSource } from "@offerfinch/core/sources/greenhouse";
import { LeverSource } from "@offerfinch/core/sources/lever";
import { type FetchLike, USER_AGENT } from "@offerfinch/core/sources/types";
import { fakeClaimsResponder } from "@offerfinch/core/tailor/fake";
import {
	type Database,
	DrizzlePipelineRepository,
	DrizzleSpendStore,
} from "@offerfinch/db";

/** Model choices supplied by desktop settings, never loaded from deployment environment variables. */
export interface ModelConfig {
	/**
	 * Fit scoring (and tailoring, unless TAILOR_LLM_PROVIDER says otherwise): `anthropic`, `fake`,
	 * `claude-subscription` (local only) or `fake-subscription` (tests). Defaults to anthropic when
	 * ANTHROPIC_API_KEY is set, else fake.
	 */
	scoringProvider?: string;
	/** Tailoring only; unset: LLM_PROVIDER. Same values. */
	tailoringProvider?: string;
	/**
	 * The one account a subscription provider answers for (its id). Required with any
	 * subscription provider; calls for every other account are refused.
	 */
	ownerUserId?: string;
	anthropicKey?: string;
	scoringModel?: string;
	scoringEffort?: string;
	/**
	 * Tailoring only (the largest call). Unset: `claude-sonnet-5-5`, with ANTHROPIC_EFFORT. Fit
	 * scoring keeps ANTHROPIC_MODEL (default `claude-opus-5-5`).
	 */
	tailoringModel?: string;
	tailoringEffort?: string;
	/** Fake claims check only: "1" makes every check throw (e2e of a failing check). */
	FAKE_CLAIMS_FAIL?: string;
	/**
	 * Claims check provider, a second model family: `openai`, `fake` or `codex-subscription`
	 * (local only: the user's ChatGPT plan through the Codex CLI, docs/decisions.md). Defaults to
	 * openai when OPENAI_API_KEY is set.
	 */
	claimsProvider?: string;
	/** codex-subscription only. Unset: the account's default Codex model. */
	codexModel?: string;
	/** codex-subscription only: low, medium, high, xhigh or max. Unset: the model's default. */
	codexEffort?: string;
	openaiKey?: string;
	/** Required with OPENAI_API_KEY; there is no default model. */
	openaiModel?: string;
	openaiEffort?: string;
	/**
	 * Comma-separated hosts automatic submission may click submit on, e.g.
	 * "jobs.ashbyhq.com,job-boards.greenhouse.io,jobs.lever.co". Default: none but 127.0.0.1 and
	 * localhost, so a real board gets the handoff until the user turns it on.
	 */
	SUBMIT_ALLOWED_HOSTS?: string;
	/** JSON object of board base URLs replacing the real hosts (fixture boards), e.g. {"lever":"http://127.0.0.1:4010/lever"}. */
	APPLY_BOARD_BASES?: string;
}

/** @public Submission-host contract retained for callers outside the desktop bundle. */
export function submitAllowedHosts(env: ModelConfig): string[] {
	return [
		...LOCAL_HOSTS,
		...(env.SUBMIT_ALLOWED_HOSTS ?? "")
			.split(",")
			.map((h) => h.trim().toLowerCase())
			.filter(Boolean),
	];
}

function boardBases(env: ModelConfig): ApplyDeps["boardBases"] {
	if (!env.APPLY_BOARD_BASES) return;
	return JSON.parse(env.APPLY_BOARD_BASES) as ApplyDeps["boardBases"];
}

/** Providers that start a vendor's local CLI on the user's own subscription. */
const SUBSCRIPTION_PROVIDERS = [
	"claude-subscription",
	"codex-subscription",
] as const;
type SubscriptionProviderName = (typeof SUBSCRIPTION_PROVIDERS)[number];
type LlmRole = "scoring" | "tailoring" | "claims";

/**
 * Builds a subscription provider using @offerfinch/local-llm. The desktop worker supplies
 * this factory; runtimes without it refuse subscription providers at start.
 */
export type LocalLlmFactory = (input: {
	role: LlmRole;
	provider: SubscriptionProviderName;
	model: string;
	effort?: (typeof EFFORTS)[number];
	ownerUserId: string;
}) => LlmProvider;

function isSubscription(name: string): name is SubscriptionProviderName {
	return (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(name);
}

/** The error a subscription provider gets anywhere but the user's own Mac. */
function localOnlyError(variable: string, provider: string): Error {
	return new Error(
		`${variable}=${provider} runs only on the user's Mac through the vendor's local CLI. Choose the subscription in the mode menu under Who does each step in Settings › Models, or choose API key. This runtime cannot start a local subscription CLI.`,
	);
}

function subscriptionOwner(env: ModelConfig, variable: string): string {
	const owner = env.ownerUserId?.trim();
	if (!owner)
		throw new Error(
			`${variable} uses a subscription, but no local owner is configured. In Settings › Models, use the mode menu under Who does each step to switch to API key and back to the subscription. Subscription models never answer for other accounts.`,
		);
	if (owner.includes("@"))
		throw new Error(
			"The subscription owner must use its account id, not its email. In Settings › Models, use the mode menu under Who does each step to switch to API key and back to the subscription.",
		);
	return owner;
}

function subscriptionProvider(
	env: ModelConfig,
	variable: string,
	input: Omit<Parameters<LocalLlmFactory>[0], "ownerUserId">,
	local: LocalLlmFactory | undefined,
): LlmProvider {
	if (!local) throw localOnlyError(variable, input.provider);
	return local({ ...input, ownerUserId: subscriptionOwner(env, variable) });
}

/**
 * Picks the scoring model. Empty strings in desktop settings count as unset.
 * The fake scorer is used only when asked for, or when `allowFake` is set (test fixtures): its
 * placeholder scores end real matches as low score, so the worker must fail loudly instead.
 */
export function createLlm(
	env: ModelConfig,
	options: { allowFake?: boolean; local?: LocalLlmFactory } = {},
): LlmProvider {
	const provider =
		env.scoringProvider ||
		(env.anthropicKey ? "anthropic" : options.allowFake ? "fake" : "");
	if (!provider)
		throw new Error(
			"No LLM configured: set ANTHROPIC_API_KEY, or LLM_PROVIDER=fake for testing",
		);
	if (provider === "fake") return new FakeLlmProvider();
	if (provider === "fake-subscription")
		return new FakeSubscriptionProvider(undefined);
	if (provider === "codex-subscription")
		throw new Error(
			"LLM_PROVIDER=codex-subscription is not supported: Codex is offered only for the claims check (CLAIMS_LLM_PROVIDER=codex-subscription), so a draft is never checked by the vendor that wrote it (docs/decisions.md).",
		);
	if (isSubscription(provider))
		return subscriptionProvider(
			env,
			"LLM_PROVIDER",
			{
				role: "scoring",
				provider,
				model: env.scoringModel || DEFAULT_ANTHROPIC_MODEL,
				effort: effortOf(env.scoringEffort),
			},
			options.local,
		);
	if (provider !== "anthropic")
		throw new Error(`Unknown LLM_PROVIDER: ${provider}`);
	if (!env.anthropicKey)
		throw new Error("LLM_PROVIDER=anthropic needs ANTHROPIC_API_KEY");
	return new AnthropicProvider({
		apiKey: env.anthropicKey,
		model: env.scoringModel || DEFAULT_ANTHROPIC_MODEL,
		effort: effortOf(env.scoringEffort),
	});
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

function effortOf(value: string | undefined) {
	if (!value) return;
	const effort = EFFORTS.find((e) => e === value);
	if (!effort)
		throw new Error(`Unknown effort "${value}": use ${EFFORTS.join(", ")}`);
	return effort;
}

/**
 * The tailoring model: `claude-sonnet-5-5` unless TAILOR_MODEL names another (Anthropic only,
 * since the claims check must stay a different provider). Effort: TAILOR_EFFORT, else
 * ANTHROPIC_EFFORT, else the provider's default (medium). The fake stays the fake. The provider
 * is TAILOR_LLM_PROVIDER when set, else the scoring one's.
 */
export function createTailorLlm(
	env: ModelConfig,
	llm: LlmProvider,
	options: { allowFake?: boolean; local?: LocalLlmFactory } = {},
): LlmProvider {
	const chosen = env.tailoringProvider;
	if (chosen && chosen !== llm.name.split(":")[0]) {
		if (chosen === "fake") return new FakeLlmProvider();
		if (chosen === "fake-subscription")
			return new FakeSubscriptionProvider(undefined);
		if (chosen === "codex-subscription")
			throw new Error(
				"TAILOR_LLM_PROVIDER=codex-subscription is not supported: Codex is offered only for the claims check (docs/decisions.md).",
			);
		if (chosen !== "anthropic" && !isSubscription(chosen))
			throw new Error(`Unknown TAILOR_LLM_PROVIDER: ${chosen}`);
		if (chosen === "anthropic" && !env.anthropicKey)
			throw new Error("TAILOR_LLM_PROVIDER=anthropic needs ANTHROPIC_API_KEY");
	}
	const provider = chosen || llm.name.split(":")[0];
	if (provider && isSubscription(provider))
		return subscriptionProvider(
			env,
			chosen ? "TAILOR_LLM_PROVIDER" : "LLM_PROVIDER",
			{
				role: "tailoring",
				provider,
				model: env.tailoringModel || DEFAULT_TAILOR_MODEL,
				effort: effortOf(env.tailoringEffort || env.scoringEffort),
			},
			options.local,
		);
	if (provider !== "anthropic") return llm;
	return new AnthropicProvider({
		apiKey: env.anthropicKey,
		model: env.tailoringModel || DEFAULT_TAILOR_MODEL,
		effort: effortOf(env.tailoringEffort || env.scoringEffort),
	});
}

/**
 * Picks the claims-check model. It must be a different provider from the tailoring model, so a
 * draft is never checked by the model that wrote it. The fake is used only when asked for or
 * allowed by the caller, such as in desktop tests.
 */
export function createClaimsLlm(
	env: ModelConfig,
	options: {
		allowFake?: boolean;
		tailoring?: LlmProvider;
		local?: LocalLlmFactory;
	} = {},
): LlmProvider {
	const provider =
		env.claimsProvider ||
		(env.openaiKey ? "openai" : options.allowFake ? "fake" : "");
	if (!provider)
		throw new Error(
			"No claims-check LLM configured: set OPENAI_API_KEY and OPENAI_MODEL, or CLAIMS_LLM_PROVIDER=fake for testing",
		);
	if (provider === "fake")
		return new FakeLlmProvider({
			"claims-check": (request) => {
				// Fake only: lets an e2e run show a check that keeps failing, then its retry. Read at
				// call time, so a running e2e server can turn it on and off.
				const live = typeof process === "undefined" ? undefined : process.env;
				if ((live?.FAKE_CLAIMS_FAIL ?? env.FAKE_CLAIMS_FAIL) === "1")
					throw new Error("Fake claims check failure (FAKE_CLAIMS_FAIL=1)");
				return fakeClaimsResponder(request);
			},
		});
	if (isSubscription(provider)) {
		const claims = subscriptionProvider(
			env,
			"CLAIMS_LLM_PROVIDER",
			provider === "codex-subscription"
				? {
						role: "claims",
						provider,
						model: env.codexModel || "",
						effort: effortOf(env.codexEffort),
					}
				: { role: "claims", provider, model: env.openaiModel || "" },
			options.local,
		);
		assertOtherVendor(claims, options.tailoring);
		return claims;
	}
	if (provider !== "openai")
		throw new Error(`Unknown CLAIMS_LLM_PROVIDER: ${provider}`);
	if (!env.openaiKey || !env.openaiModel)
		throw new Error(
			"CLAIMS_LLM_PROVIDER=openai needs OPENAI_API_KEY and OPENAI_MODEL",
		);
	const claims = new OpenAiProvider({
		apiKey: env.openaiKey,
		model: env.openaiModel,
		reasoningEffort: (env.openaiEffort || undefined) as
			| "minimal"
			| "low"
			| "medium"
			| "high"
			| undefined,
	});
	assertOtherVendor(claims, options.tailoring);
	return claims;
}

/** A draft is never checked by the vendor that wrote it (fakes aside). */
function assertOtherVendor(
	claims: LlmProvider,
	tailoring: LlmProvider | undefined,
): void {
	if (!tailoring) return;
	const vendor = vendorOf(claims);
	if (vendor.startsWith("fake")) return;
	if (vendor === vendorOf(tailoring))
		throw new Error(
			`The claims check must use a different provider from tailoring (both ${vendor})`,
		);
}

function claimsConfigured(env: ModelConfig): boolean {
	return Boolean(env.claimsProvider || env.openaiKey);
}

/** Dependencies and optional local capabilities used to build the desktop pipeline. */
export interface CreatePipelineOptions {
	env: ModelConfig;
	db: Database;
	workflows: WorkflowStarter;
	/** Local browser used for scraping and PDF export. */
	browser?: BrowserProvider;
	/** Local store for exported PDFs and DOCX files. */
	blobs?: BlobStore;
	fetch?: FetchLike;
	log?: PipelineDeps["log"];
	llm?: LlmProvider;
	claimsLlm?: LlmProvider;
	/** Allow the fake scorer when no key is set, for desktop tests. */
	allowFakeLlm?: boolean;
	/** Builds subscription providers in the desktop worker. Unset: they are refused. */
	localLlm?: LocalLlmFactory;
}

export function createPipelineDeps(
	options: CreatePipelineOptions,
): PipelineDeps {
	const fetchImpl = options.fetch ?? fetch;
	const llm =
		options.llm ??
		createLlm(options.env, {
			allowFake: options.allowFakeLlm,
			local: options.localLlm,
		});
	const tailorLlm = options.llm
		? undefined
		: createTailorLlm(options.env, llm, {
				allowFake: options.allowFakeLlm,
				local: options.localLlm,
			});
	const sources: PipelineDeps["sources"] = {
		ashby: new AshbySource(fetchImpl),
		greenhouse: new GreenhouseSource(fetchImpl),
		lever: new LeverSource(fetchImpl),
	};
	if (options.browser) {
		sources.scrape = new ScrapeSource({
			browser: options.browser,
			// No model here: a scan passes its user's metered model per company (scanCompany).
			robots: new RobotsCache(USER_AGENT, fetchImpl),
			rateLimiter: new HostRateLimiter(5_000),
			maxDetailPages: 20,
			log: options.log,
		});
	}
	const repo = new DrizzlePipelineRepository(options.db);
	const spend = new DrizzleSpendStore(options.db);
	return {
		repo,
		sources,
		llm,
		tailorLlm,
		// Left unset when no claims model is configured: scans still run, and preparing fails
		// loudly at the review step instead of every scan failing at startup.
		claimsLlm:
			options.claimsLlm ??
			(claimsConfigured(options.env) || options.allowFakeLlm
				? createClaimsLlm(options.env, {
						allowFake: options.allowFakeLlm,
						tailoring: tailorLlm ?? llm,
						local: options.localLlm,
					})
				: undefined),
		notifier: new NoopNotifier(),
		workflows: options.workflows,
		browser: options.browser,
		blobs: options.blobs,
		apply:
			options.browser && options.blobs
				? {
						store: repo,
						browser: options.browser,
						blobs: options.blobs,
						allowedHosts: submitAllowedHosts(options.env),
						boardBases: boardBases(options.env),
					}
				: undefined,
		spend,
		log: options.log,
	};
}

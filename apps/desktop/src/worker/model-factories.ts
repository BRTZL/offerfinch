import { type ApplyDeps, LOCAL_HOSTS } from "@offerfinch/core/apply/submit";
import type { BlobStore } from "@offerfinch/core/export/export";
import { NoopNotifier } from "@offerfinch/core/notify/ntfy";
import type {
	PipelineDeps,
	WorkflowStarter,
} from "@offerfinch/core/pipeline/ports";
import { FakeLlmProvider } from "@offerfinch/core/scoring/fake";
import type { LlmProvider } from "@offerfinch/core/scoring/llm";
import type { BrowserProvider } from "@offerfinch/core/scrape/browser";
import { HostRateLimiter } from "@offerfinch/core/scrape/rate-limit";
import { RobotsCache } from "@offerfinch/core/scrape/robots";
import { ScrapeSource } from "@offerfinch/core/scrape/source";
import { AshbySource } from "@offerfinch/core/sources/ashby";
import { GreenhouseSource } from "@offerfinch/core/sources/greenhouse";
import { LeverSource } from "@offerfinch/core/sources/lever";
import { PersonioSource } from "@offerfinch/core/sources/personio";
import { RecruiteeSource } from "@offerfinch/core/sources/recruitee";
import { SmartRecruitersSource } from "@offerfinch/core/sources/smartrecruiters";
import { TeamtailorSource } from "@offerfinch/core/sources/teamtailor";
import { type FetchLike, USER_AGENT } from "@offerfinch/core/sources/types";
import { WorkableSource } from "@offerfinch/core/sources/workable";
import { fakeClaimsResponder } from "@offerfinch/core/tailor/fake";
import {
	type Database,
	DrizzlePipelineRepository,
	DrizzleSpendStore,
} from "@offerfinch/db";
import {
	type Effort,
	FAKE_PROVIDER,
	type ModelRef,
	type ProviderId,
	parseModelRef,
} from "../shared/providers";

/** The model a step runs on: a model reference and, when the model has levels, its effort. */
export interface RoleModel {
	model: ModelRef;
	effort?: Effort;
}

/** Model choices supplied by desktop settings, never loaded from deployment environment variables. */
export interface ModelConfig {
	/** Finding matches. Unset: refused, or the fake when `allowFake` is set (tests). */
	scoring?: RoleModel;
	/** Drafting. Unset: the scoring model drafts too. */
	tailoring?: RoleModel;
	/** Checking drafts. Unset: no check is configured (`createPipelineDeps` leaves it out). */
	claims?: RoleModel;
	/**
	 * The one account a model on the user's own sign-in answers for (its id). Required with any
	 * real model; calls for every other account are refused.
	 */
	ownerUserId?: string;
	/** Fake claims check only: "1" makes every check throw (e2e of a failing check). */
	FAKE_CLAIMS_FAIL?: string;
	/**
	 * Comma-separated hosts automatic submission may open and click submit on, besides 127.0.0.1
	 * and localhost. The desktop leaves it unset: real boards open per run only when the user opened
	 * them in Settings › Applying (core apply/open-boards.ts, docs/auto-apply-plan.md step 8).
	 */
	SUBMIT_ALLOWED_HOSTS?: string;
	/** JSON object of board base URLs replacing the real hosts (fixture boards), e.g. {"lever":"http://127.0.0.1:4010/lever"}. */
	APPLY_BOARD_BASES?: string;
}

/**
 * @public Submission-host contract retained for callers outside the desktop bundle. The local
 * fixture hosts (127.0.0.1, localhost) join only in a fixture run (`fixtures`): a real run never
 * opens this Mac or a private network.
 */
export function submitAllowedHosts(
	env: ModelConfig,
	fixtures = false,
): string[] {
	return [
		...(fixtures ? LOCAL_HOSTS : []),
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

type LlmRole = "scoring" | "tailoring" | "claims";

/**
 * Builds a provider's model on the user's own sign-in (Claude Code, Codex, ...). The desktop
 * worker supplies it (`worker/subscriptions.ts`); runtimes without it refuse every real model.
 */
export type LocalLlmFactory = (input: {
	role: LlmRole;
	provider: ProviderId;
	/** The provider's model id; "" on Codex is the account's default model. */
	model: string;
	effort?: Effort;
	ownerUserId: string;
}) => LlmProvider;

const STEP_NAME: Record<LlmRole, string> = {
	scoring: "Finding matches",
	tailoring: "Drafting",
	claims: "Checking drafts",
};

function owner(env: ModelConfig, role: LlmRole): string {
	const id = env.ownerUserId?.trim();
	if (!id)
		throw new Error(
			`${STEP_NAME[role]} runs on your own sign-in, but no local owner is configured. Choose its model again in Settings › Models. Your models never answer for other accounts.`,
		);
	if (id.includes("@"))
		throw new Error(
			"The model owner must use its account id, not its email. Choose the model again in Settings › Models.",
		);
	return id;
}

/** The test models for a step; the claims check gets the claims responder. */
function fakeFor(role: LlmRole, env: ModelConfig): LlmProvider {
	if (role !== "claims") return new FakeLlmProvider();
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
}

/**
 * One step's model, from its reference, whatever the provider: any model may do any step, the
 * same model all three included. Unset: the fake when `allowFake` is set (test fixtures), else a
 * loud failure (the fake's placeholder scores would end real matches as low score).
 */
function buildRole(
	role: LlmRole,
	choice: RoleModel | undefined,
	env: ModelConfig,
	options: { allowFake?: boolean; local?: LocalLlmFactory },
): LlmProvider {
	if (!choice) {
		if (options.allowFake) return fakeFor(role, env);
		throw new Error(
			`No model chosen for ${STEP_NAME[role]}: choose one in Settings › Models`,
		);
	}
	const ref = parseModelRef(choice.model);
	if (!ref)
		throw new Error(`Unknown model for ${STEP_NAME[role]}: ${choice.model}`);
	if (ref.provider === FAKE_PROVIDER) return fakeFor(role, env);
	if (!options.local)
		throw new Error(
			`${STEP_NAME[role]} runs ${ref.provider} through its CLI on the user's computer; this runtime cannot start one.`,
		);
	return options.local({
		role,
		provider: ref.provider,
		model: ref.model,
		effort: choice.effort,
		ownerUserId: owner(env, role),
	});
}

/** Finding matches' model (`env.scoring`). */
export function createLlm(
	env: ModelConfig,
	options: { allowFake?: boolean; local?: LocalLlmFactory } = {},
): LlmProvider {
	return buildRole("scoring", env.scoring, env, options);
}

/**
 * Drafting's model (`env.tailoring`). Unset: the scoring model `llm` drafts too. Its effort,
 * unset, is the scoring step's.
 */
export function createTailorLlm(
	env: ModelConfig,
	llm: LlmProvider,
	options: { allowFake?: boolean; local?: LocalLlmFactory } = {},
): LlmProvider {
	const tailoring = env.tailoring;
	if (!tailoring) return llm;
	const effort = tailoring.effort ?? env.scoring?.effort;
	return buildRole(
		"tailoring",
		effort ? { ...tailoring, effort } : tailoring,
		env,
		options,
	);
}

/** Checking drafts' model (`env.claims`), on any provider, the drafting one's included. */
export function createClaimsLlm(
	env: ModelConfig,
	options: { allowFake?: boolean; local?: LocalLlmFactory } = {},
): LlmProvider {
	return buildRole("claims", env.claims, env, options);
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
	/** Allow the fake models for steps without a model, for desktop tests. */
	allowFakeLlm?: boolean;
	/** Builds models on the user's own sign-ins in the desktop worker. Unset: they are refused. */
	localLlm?: LocalLlmFactory;
	/**
	 * Fixture configuration (`ApplyDeps.fixtures`): set only by test code and the desktop's test
	 * mode, never from the packaged app's environment. Lets submissions and form reads open the
	 * local stand-in boards on this Mac.
	 */
	applyFixtures?: boolean;
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
		smartrecruiters: new SmartRecruitersSource(fetchImpl),
		workable: new WorkableSource(fetchImpl),
		recruitee: new RecruiteeSource(fetchImpl),
		teamtailor: new TeamtailorSource(fetchImpl),
		personio: new PersonioSource(fetchImpl),
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
			(options.env.claims || options.allowFakeLlm
				? createClaimsLlm(options.env, {
						allowFake: options.allowFakeLlm,
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
						allowedHosts: submitAllowedHosts(
							options.env,
							options.applyFixtures,
						),
						boardBases: boardBases(options.env),
						fixtures: Boolean(options.applyFixtures),
					}
				: undefined,
		spend,
		log: options.log,
	};
}

import dns from "node:dns/promises";
import type { BlobStore } from "@offerfinch/core/export/export";
import { FEEDS } from "@offerfinch/core/feeds/feeds";
import { FeedProvider } from "@offerfinch/core/feeds/provider";
import {
	type LinkedInScanDeps,
	LinkedInScanProvider,
} from "@offerfinch/core/linkedin/provider";
import type { Notifier } from "@offerfinch/core/notify/ntfy";
import type {
	PipelineDeps,
	WorkflowStarter,
} from "@offerfinch/core/pipeline/ports";
import {
	JobBoardSearchProvider,
	type ScanProvider,
} from "@offerfinch/core/pipeline/providers";
import {
	billingOf,
	type GenerateObjectRequest,
	LlmPausedError,
	type LlmProvider,
} from "@offerfinch/core/scoring/llm";
import { meteredFor } from "@offerfinch/core/scoring/metered";
import type { BrowserProvider } from "@offerfinch/core/scrape/browser";
import { fetchPublic, publicOnly } from "@offerfinch/core/scrape/public-fetch";
import { RobotsCache } from "@offerfinch/core/scrape/robots";
import { refreshSearchPlan } from "@offerfinch/core/search/plan";
import { SiteSearchProvider } from "@offerfinch/core/sites/provider";
import { SITE_IDS, SITES } from "@offerfinch/core/sites/sites";
import type { StopStore } from "@offerfinch/core/sites/stops";
import { DuckDuckGoSearch } from "@offerfinch/core/sources/duckduckgo";
import { USER_AGENT } from "@offerfinch/core/sources/types";
import { coveredByOtherSource } from "@offerfinch/core/web/hosts";
import {
	WEB_SEARCH_ID,
	WebSearchProvider,
} from "@offerfinch/core/web/provider";
import type { Database } from "@offerfinch/db";
import {
	listProviders,
	providerCursor,
	recordProviderRun,
	SqliteFeedStore,
	SqliteSearchPlanStore,
	SqliteSiteStore,
	SqliteWebStore,
} from "@offerfinch/db";
import type { SecretName } from "../shared/bridge";
import type { SiteTabHost } from "./checks";
import {
	createClaimsLlm,
	createLlm,
	createPipelineDeps,
	createTailorLlm,
	type LocalLlmFactory,
	type ModelConfig,
} from "./model-factories";
import type { AiSettings } from "./settings";
import { saveDebugSnapshot } from "./site-debug";
import {
	openDuckDuckGoReader,
	openSiteReader,
	openWebPageReader,
	siteOrigins,
} from "./sites";

/**
 * A role with no model connected. Its calls pause (never fail): scoring leaves the job found
 * and preparation waits, and both resume once a model is connected (the next scan's sweep).
 */
export class NotConnectedProvider implements LlmProvider {
	constructor(
		readonly name: string,
		private readonly reason: string,
	) {}
	async generateObject<T>(_request: GenerateObjectRequest<T>): Promise<T> {
		throw new LlmPausedError(this.reason);
	}
}

/** Test models answer the connection test too (the fakes have no responder for it). */
class FakeWithConnectionTest implements LlmProvider {
	readonly name: string;
	readonly vendor?: string;
	readonly billing?: LlmProvider["billing"];
	constructor(
		private readonly inner: LlmProvider,
		private readonly delayMs = 0,
	) {
		this.name = inner.name;
		this.vendor = inner.vendor;
		this.billing = inner.billing;
	}
	async generateObject<T>(request: GenerateObjectRequest<T>): Promise<T> {
		if (request.task === "connection-test") return { ok: true } as T;
		if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
		return this.inner.generateObject(request);
	}
}
const withTest = <P extends LlmProvider | undefined>(p: P, delayMs = 0): P =>
	(p?.name.startsWith("fake")
		? new FakeWithConnectionTest(p, delayMs)
		: p) as P;

/** The claims check never runs on the vendor that wrote the draft (tailoring is Anthropic). */
export const VENDOR_RULE =
	"A draft is never checked by the AI that wrote it: finding matches and drafting run on Anthropic (an API key or your Claude plan), checking drafts on OpenAI (an API key or your ChatGPT plan through Codex).";

export interface PipelineInputs {
	db: Database;
	ai: AiSettings;
	secrets: Partial<Record<SecretName, string>>;
	workflows: WorkflowStarter;
	browser: BrowserProvider;
	blobs: BlobStore;
	notifier: Notifier;
	fakeModels: boolean;
	fakeDelayMs?: number;
	boardBases?: Record<string, string>;
	/** Builds Claude and Codex subscription providers (unset: subscriptions are not offered). */
	local?: LocalLlmFactory;
	/** The account subscriptions answer for: the local user. */
	ownerUserId: string;
	/** The app's folder. */
	userData: string;
	/** The site tabs in main, for Indeed and Glassdoor. */
	siteHost: SiteTabHost;
	/** Test runs: sites served by a local stand-in, and no pause between their pages. */
	test?: boolean;
	/**
	 * Test runs: the hosts a local stand-in answers (`fetchRewrite`). A remote feed on any other
	 * host is refused in a test run unless `OFFERFINCH_REAL_SITES=1`.
	 */
	standInHosts?: string[];
	/** LinkedIn's tab, store and notices, for scans (`worker/linkedin.ts`). */
	linkedin?: LinkedInScanDeps;
	log: PipelineDeps["log"];
}

/** What each role runs on, in words, for the status and Settings > Models. */
export interface RoleState {
	role: "scoring" | "tailoring" | "claims";
	mode: AiSettings["scoring"]["mode"];
	provider: string;
	billing: "api" | "subscription";
	ready: boolean;
	problem: string | null;
}

type Role = "scoring" | "tailoring" | "claims";

/** Why a role's choice cannot run, or null when it can be built. */
function problemOf(
	role: Role,
	ai: AiSettings,
	secrets: PipelineInputs["secrets"],
	input: Pick<PipelineInputs, "fakeModels" | "local">,
): string | null {
	const mode = ai[role].mode;
	if (mode === "fake")
		return input.fakeModels
			? null
			: "Test models are only available in test runs.";
	if (role === "claims") {
		if (mode === "claude-subscription")
			return `Claude cannot check claims here: ${VENDOR_RULE}`;
		if (mode === "codex-subscription")
			return input.local
				? null
				: "Subscriptions are not available in this build.";
		if (!secrets.openai)
			return "Add an OpenAI API key in Settings > Models for the claims check.";
		if (!ai.claims.model)
			return "Choose the OpenAI model for the claims check in Settings > Models.";
		return null;
	}
	if (mode === "codex-subscription")
		return `Codex runs the claims check only: ${VENDOR_RULE}`;
	if (mode === "claude-subscription")
		return input.local
			? null
			: "Subscriptions are not available in this build.";
	return secrets.anthropic
		? null
		: "Add an Anthropic API key in Settings > Models.";
}

/**
 * Builds the pipeline from the desktop's per-role settings and the keys main decrypted, through
 * the model factories (`createLlm`, `createTailorLlm`, `createClaimsLlm`, which
 * also enforce the vendor rule). A role without a usable model gets a provider that pauses,
 * so the app runs (and scans) before AI is connected.
 */
export function buildPipeline(input: PipelineInputs): {
	deps: PipelineDeps;
	roles: RoleState[];
} {
	const { ai, secrets } = input;
	const problems = {
		scoring: problemOf("scoring", ai, secrets, input),
		tailoring: problemOf("tailoring", ai, secrets, input),
		claims: problemOf("claims", ai, secrets, input),
	};
	const providerName = (role: Role) =>
		ai[role].mode === "fake"
			? "fake"
			: ai[role].mode === "api"
				? role === "claims"
					? "openai"
					: "anthropic"
				: ai[role].mode;
	const env: ModelConfig = {
		SUBMIT_ALLOWED_HOSTS: "",
		ownerUserId: input.ownerUserId,
		anthropicKey: secrets.anthropic,
		openaiKey: secrets.openai,
		APPLY_BOARD_BASES: input.boardBases
			? JSON.stringify(input.boardBases)
			: undefined,
	};
	if (ai.scoring.model) env.scoringModel = ai.scoring.model;
	if (ai.scoring.effort) env.scoringEffort = ai.scoring.effort;
	if (ai.tailoring.model) env.tailoringModel = ai.tailoring.model;
	if (ai.tailoring.effort) env.tailoringEffort = ai.tailoring.effort;
	if (ai.claims.mode === "codex-subscription") {
		if (ai.claims.model) env.codexModel = ai.claims.model;
		if (ai.claims.effort) env.codexEffort = ai.claims.effort;
	} else if (ai.claims.model) env.openaiModel = ai.claims.model;
	const options = { allowFake: input.fakeModels, local: input.local };
	const notConnected = (role: Role) =>
		new NotConnectedProvider(`not-connected:${role}`, problems[role] ?? "");
	const delay = input.fakeDelayMs ?? 0;

	let llm: LlmProvider = notConnected("scoring");
	if (!problems.scoring)
		llm = createLlm(
			{ ...env, scoringProvider: providerName("scoring") },
			options,
		);
	let tailorLlm: LlmProvider = notConnected("tailoring");
	if (!problems.tailoring)
		tailorLlm = createTailorLlm(
			{ ...env, tailoringProvider: providerName("tailoring") },
			llm,
			options,
		);
	let claimsLlm: LlmProvider = notConnected("claims");
	if (!problems.claims)
		claimsLlm = createClaimsLlm(
			{ ...env, claimsProvider: providerName("claims") },
			{
				...options,
				tailoring: tailorLlm.name.startsWith("not-connected")
					? undefined
					: tailorLlm,
			},
		);
	if (input.fakeModels) {
		llm = withTest(llm, delay);
		tailorLlm = withTest(tailorLlm, delay);
		claimsLlm = withTest(claimsLlm, delay);
	}
	const deps = createPipelineDeps({
		env,
		db: input.db as never,
		workflows: input.workflows,
		browser: input.browser,
		blobs: input.blobs,
		llm,
		claimsLlm,
		log: input.log,
	});
	deps.tailorLlm = tailorLlm;
	deps.notifier = input.notifier;
	// A scanned job is filtered and scored while later sources still search.
	deps.startDuringScanMs = 2_000;
	// PLAN A: scans run providers, never the old company watchlist.
	const db = input.db as Database;
	deps.providers = (userId) => scanProviders(input, db, userId);
	// A source not due in this scan (LinkedIn's wait) keeps its last real run in Sources.
	deps.recordProviderRun = async (userId, run) => {
		if (run.status !== "waiting") await recordProviderRun(db, userId, run);
	};
	deps.providerCursor = (userId, provider) =>
		providerCursor(db, userId, provider);
	// One plan for every source: the drafting model writes it once a day, metered like any call.
	deps.searchPlan = async (userId) =>
		refreshSearchPlan({
			llm: meteredFor(tailorLlm, deps.spend, userId, null),
			store: new SqliteSearchPlanStore(db),
			userId,
			profile: await deps.repo.getProfile(userId),
			settings: await deps.repo.getFilterSettings(userId),
		});
	const roles: RoleState[] = (["scoring", "tailoring", "claims"] as const).map(
		(role) => {
			const provider =
				role === "scoring" ? llm : role === "tailoring" ? tailorLlm : claimsLlm;
			return {
				role,
				mode: ai[role].mode,
				provider: provider.name,
				billing: billingOf(provider),
				ready: problems[role] === null,
				problem: problems[role],
			};
		},
	);
	return { deps, roles };
}

/**
 * The sources a scan runs, in order, those the user turned on: job-board search, LinkedIn (in
 * every scan while on; it reads only when due), Indeed, Glassdoor, then web search.
 */
async function scanProviders(
	input: PipelineInputs,
	db: Database,
	userId: string,
): Promise<ScanProvider[]> {
	const states = await listProviders(db, userId);
	const out: ScanProvider[] = [];
	const origins = siteOrigins(Boolean(input.test));
	// DuckDuckGo's results pages in the app's own tab: nothing to set up. One per provider run.
	const duckDuckGo = () =>
		new DuckDuckGoSearch(
			(signal) =>
				openDuckDuckGoReader(input.siteHost, origins.duckduckgo, signal),
			{
				origin: origins.duckduckgo,
				sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
				random: Math.random,
				...(origins.duckduckgo
					? { gapSeconds: [0, 0] as [number, number] }
					: {}),
				debug: async (page, stop) => {
					const file = saveDebugSnapshot(
						input.userData,
						"duckduckgo",
						page,
						stop,
					);
					input.log?.("site page kept for diagnosis", {
						site: "duckduckgo",
						kind: stop.kind,
						file,
					});
				},
			},
		);
	const enabled = (id: string) =>
		Boolean(states.find((p) => p.provider === id)?.enabled);
	if (enabled("job-board-search"))
		out.push(
			new JobBoardSearchProvider(
				duckDuckGo(),
				sharedDuckDuckGoStops(new SqliteSiteStore(db)),
			),
		);
	// In every scan while on; it reads only when due (every 3 hours, 30 pages a day).
	if (enabled("linkedin") && input.linkedin)
		out.push(new LinkedInScanProvider(input.linkedin));
	for (const site of SITE_IDS) {
		if (!states.find((p) => p.provider === site)?.enabled) continue;
		out.push(
			new SiteSearchProvider(
				SITES[site],
				(signal) =>
					openSiteReader(input.siteHost, site, origins[site], true, signal),
				new SqliteSiteStore(db),
				{
					origin: origins[site],
					sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
					random: Math.random,
					// No pause between a local stand-in's pages; a real site always gets them.
					...(origins[site] ? { gapSeconds: [0, 0] as [number, number] } : {}),
					debug: async (page, stop) => {
						const file = saveDebugSnapshot(input.userData, site, page, stop);
						input.log?.("site page kept for diagnosis", {
							site,
							kind: stop.kind,
							file,
						});
					},
				},
			),
		);
	}
	// Public remote-job feeds: plain GETs, each at most every 6 hours whatever the scans do.
	for (const feed of FEEDS)
		if (enabled(feed.id))
			out.push(
				new FeedProvider(feed, new SqliteFeedStore(db), feedFetch(input)),
			);
	// Last, so the more specific sources find a job first.
	if (enabled(WEB_SEARCH_ID))
		out.push(
			new WebSearchProvider(
				duckDuckGo(),
				(signal) => openWebPageReader(input.siteHost, signal),
				sharedDuckDuckGoStops(new SqliteWebStore(db)),
				robotsCheck(origins.web),
				{
					sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
					random: Math.random,
					// Test runs only: fewer result pages (a run against the real sites, kept small).
					...(input.test && Number(process.env.OFFERFINCH_WEB_PAGES) > 0
						? { pages: Number(process.env.OFFERFINCH_WEB_PAGES) }
						: {}),
					...(origins.web
						? {
								gapSeconds: [0, 0] as [number, number],
								// Test runs: the local stand-in's pages are the web.
								allowUrl: (url: string) =>
									url.startsWith(`${origins.web}/`) &&
									!coveredByOtherSource(url),
							}
						: {}),
				},
			),
		);
	return out;
}

/**
 * The feeds' fetch, looked up when called: test runs replace `globalThis.fetch` after the worker
 * starts, to send the boards' and feeds' hosts to a local stand-in. A test run never reaches a
 * real feed by accident: a host without a stand-in is refused unless `OFFERFINCH_REAL_SITES=1`.
 */
function feedFetch(input: PipelineInputs): typeof fetch {
	return (resource, init) => {
		if (input.test && process.env.OFFERFINCH_REAL_SITES !== "1") {
			const url = new URL(
				typeof resource === "string" || resource instanceof URL
					? resource
					: resource.url,
			);
			if (!input.standInHosts?.includes(url.host))
				return Promise.reject(
					new Error(`a test run reads no real feed (${url.host})`),
				);
		}
		return globalThis.fetch(resource, init);
	};
}

/** The sources that search through DuckDuckGo: its stop is one stop for both. */
export const DUCKDUCKGO_PROVIDERS = [
	"job-board-search",
	WEB_SEARCH_ID,
] as const;

/**
 * One DuckDuckGo hold for job-board search and web search: a check either of them meets holds
 * both (in the same scan the second does not meet it again, notify again or wait again), and
 * clearing either clears both.
 */
export function sharedDuckDuckGoStops<T extends StopStore>(store: T): T {
	const shared: StopStore = {
		stopped: async (userId) => {
			for (const id of DUCKDUCKGO_PROVIDERS) {
				const stop = await store.stopped(userId, id);
				if (stop) return stop;
			}
			return null;
		},
		stop: async (userId, _source, record) => {
			for (const id of DUCKDUCKGO_PROVIDERS)
				await store.stop(userId, id, record);
		},
		clearStop: async (userId) => {
			for (const id of DUCKDUCKGO_PROVIDERS) await store.clearStop(userId, id);
		},
	};
	return Object.assign(Object.create(store) as T, shared);
}

/**
 * robots.txt for web search's result pages, read through the public-only fetcher (no private
 * address, every hop checked) as OfferFinch's reader. Test runs: the local stand-in only.
 */
export function robotsCheck(
	standIn: string | undefined,
): (url: string) => Promise<boolean> {
	const policy = standIn
		? { lookup: lookupAll, allowAddress: () => true }
		: publicOnly(lookupAll);
	const robots = new RobotsCache(USER_AGENT, async (url, init) => {
		const res = await fetchPublic(url, policy, {
			headers: init?.headers as Record<string, string> | undefined,
			timeoutMs: 10_000,
			maxBytes: 512 * 1024,
		});
		return new Response(new Uint8Array(res.body), {
			status: res.status,
			headers: res.headers,
		});
	});
	return (url) => robots.isAllowed(url);
}

async function lookupAll(host: string): Promise<string[]> {
	return (await dns.lookup(host, { all: true, verbatim: true })).map(
		(a) => a.address,
	);
}

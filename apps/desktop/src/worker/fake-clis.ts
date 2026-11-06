import fs from "node:fs";
import path from "node:path";
import { FakeLlmProvider } from "@offerfinch/core/scoring/fake";
import type { LlmBilling } from "@offerfinch/core/scoring/llm";
import {
	type GenerateObjectRequest,
	type LlmProvider,
	SubscriptionUnavailableError,
} from "@offerfinch/core/scoring/llm";
import type { LlmLoginState } from "@offerfinch/core/scoring/llm-status";
import type {
	PlanSnapshot,
	PlanUsageSink,
} from "@offerfinch/core/scoring/plan-usage";
import { formatModelRef, type ModelInfo } from "../shared/providers";
import { antigravityState } from "./antigravity";
import type { LocalLlmFactory } from "./model-factories";
import {
	CLAUDE_FIX,
	type CliState,
	CODEX_FIX,
	type ManagedProvider,
	OPENCODE_FIX,
	type Subscriptions,
	withProviders,
} from "./subscriptions";

/**
 * Test runs only: Claude Code, Codex and Gemini (Antigravity) as a test says they are, never the
 * CLIs on this Mac or Google's server. The state comes from `fake-clis.json` in the data folder,
 * read on every check so a test can change it while the app runs:
 * `{"claude": "logged_in", "codex": "missing", "antigravity": "logged_out"}`. Unset: none is
 * installed. Antigravity's Install and Sign in move it on in the file (missing, then logged_out,
 * then logged_in) without a download or a browser.
 */
type FakeCli = "logged_in" | "logged_out" | "not_subscription" | "missing";
const FAKE_FILE = "fake-clis.json";

/**
 * The plan's usage a stand-in reports, per CLI: `{"session": 42, "weekly": 10}` (share used,
 * 0 to 100). Each stand-in call then adds one point to the session window, as a real call
 * would move the plan's own report. Unset: the stand-in reports no usage.
 */
interface FakeUsage {
	session?: number;
	weekly?: number;
}

type FakeName = "claude" | "codex" | "antigravity" | "opencode";

interface FakeState {
	claude: FakeCli;
	codex: FakeCli;
	antigravity: FakeCli;
	opencode: FakeCli;
	usage: Partial<Record<FakeName, FakeUsage>>;
}

function read(dir: string): FakeState {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(dir, FAKE_FILE), "utf8"));
		const pick = (v: unknown): FakeCli =>
			v === "logged_in" || v === "logged_out" || v === "not_subscription"
				? v
				: "missing";
		const usage = (v: unknown): FakeUsage | undefined =>
			v && typeof v === "object" ? (v as FakeUsage) : undefined;
		return {
			claude: pick(raw.claude),
			codex: pick(raw.codex),
			antigravity: pick(raw.antigravity),
			opencode: pick(raw.opencode),
			usage: {
				claude: usage(raw.usage?.claude),
				codex: usage(raw.usage?.codex),
			},
		};
	} catch {
		return {
			claude: "missing",
			codex: "missing",
			antigravity: "missing",
			opencode: "missing",
			usage: {},
		};
	}
}

/** Sets one stand-in's state in the file, keeping the rest. */
function write(dir: string, name: FakeName, value: FakeCli): void {
	const file = path.join(dir, FAKE_FILE);
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {}
	fs.writeFileSync(file, JSON.stringify({ ...raw, [name]: value }));
}

/** Stand-in calls made so far, per CLI: each moves the session window by one point. */
const fakeCalls: Record<FakeName, number> = {
	claude: 0,
	codex: 0,
	antigravity: 0,
	opencode: 0,
};

/** When the stand-in's windows began: one hour before this worker started, so a call is in them. */
const FAKE_WINDOWS_START = Date.now() - 3_600_000;

/** The stand-in's plan usage as a snapshot: a 5-hour and a 7-day window, both running. */
function fakeSnapshot(
	cli: FakeName,
	usage: FakeUsage | undefined,
	now: Date,
): PlanSnapshot | null {
	if (!usage) return null;
	const day = new Date(FAKE_WINDOWS_START);
	const windows: PlanSnapshot["windows"] = [];
	if (typeof usage.session === "number")
		windows.push({
			id: cli === "claude" ? "five_hour" : "primary",
			label: "Session",
			kind: "session",
			usedPercent: Math.min(100, usage.session + fakeCalls[cli]),
			resetsAt: new Date(day.getTime() + 5 * 3_600_000),
			durationMins: 300,
		});
	if (typeof usage.weekly === "number")
		windows.push({
			id: cli === "claude" ? "seven_day" : "secondary",
			label: "Weekly",
			kind: "weekly",
			usedPercent: Math.min(100, usage.weekly + fakeCalls[cli]),
			resetsAt: new Date(day.getTime() + 7 * 86_400_000),
			durationMins: 7 * 24 * 60,
		});
	return {
		at: now,
		complete: true,
		windows,
		account: {
			plan: "test plan",
			extraUsage:
				cli === "claude"
					? { enabled: false, used: null, limit: null, currency: null }
					: null,
			credits: cli === "codex" ? { balance: 0, unlimited: false } : null,
		},
	};
}

const plan = (
	provider: "opencode" | "antigravity",
	model: string,
	name: string,
	extra: Partial<ModelInfo> = {},
): ModelInfo => ({
	ref: formatModelRef(provider, model),
	name,
	provider,
	billing: "subscription",
	efforts: [],
	...extra,
});

/**
 * The stand-in models: OpenCode's plan sources (Go, and the free models of OpenCode Zen) and one
 * pay-per-use source with prices; Gemini's two models with effort levels.
 */
const FAKE_MODELS: Record<"opencode" | "antigravity", ModelInfo[]> = {
	opencode: [
		plan("opencode", "opencode-go/glm-5.1", "GLM-5.1", {
			source: "opencode-go",
		}),
		plan("opencode", "opencode-go/kimi-k2.5", "Kimi K2.5", {
			source: "opencode-go",
		}),
		plan(
			"opencode",
			"opencode/deepseek-v4.1-flash-free",
			"DeepSeek V4.1 Flash",
			{
				source: "opencode",
			},
		),
		plan("opencode", "openrouter/minimax-m2.7", "MiniMax M2.7", {
			source: "openrouter",
			billing: "api",
			price: { input: 0.3, output: 1.2 },
		}),
		plan("opencode", "openrouter/qwen-4-coder", "Qwen 4 Coder", {
			source: "openrouter",
			billing: "api",
			price: { input: 0.45, output: 1.8 },
			efforts: ["low", "medium", "high"],
		}),
	],
	antigravity: [
		plan("antigravity", "gemini-3.8-flash", "Gemini 3.8 Flash", {
			efforts: ["low", "medium", "high"],
		}),
		plan("antigravity", "gemini-4-argon", "Gemini 4 Argon", {
			efforts: ["low", "medium", "high"],
		}),
	],
};

/** The stand-in's OpenCode models (plan sources first, then pay-per-use). */
const FAKE_OPENCODE_MODELS = FAKE_MODELS.opencode;

type Cli = "claude" | "codex" | "opencode";

function stateOf(cli: Cli, fake: FakeCli): CliState {
	const fix =
		cli === "claude" ? CLAUDE_FIX : cli === "codex" ? CODEX_FIX : OPENCODE_FIX;
	const name =
		cli === "claude"
			? "Claude Code"
			: cli === "codex"
				? "The Codex CLI"
				: "OpenCode";
	const login: LlmLoginState =
		fake === "logged_in"
			? { state: "logged_in", detail: "Signed in to a plan (test stand-in)." }
			: fake === "not_subscription"
				? {
						state: "not_subscription",
						detail: "Signed in with an API key, not a plan (test stand-in).",
					}
				: fake === "logged_out"
					? { state: "logged_out", detail: "Not signed in (test stand-in)." }
					: { state: "logged_out", detail: `${name} is not installed.` };
	const installed = fake !== "missing";
	const next = !installed
		? fix.install
		: fake === "logged_in"
			? null
			: fix.login;
	return {
		path: installed ? `/test/bin/${cli}` : null,
		version: installed ? "test" : null,
		tested: "test",
		login,
		command: next?.command ?? null,
		fix: next,
	};
}

/** A signed-in stand-in answers like the test models; a signed-out one pauses, as the CLI does. */
class FakeCliProvider implements LlmProvider {
	readonly billing: LlmBilling;
	readonly name: string;
	readonly vendor: string;
	readonly price?: LlmProvider["price"];
	readonly reportsModelCalls = true;
	readonly ownerUserId: string;
	private readonly fake = new FakeLlmProvider();
	constructor(
		private readonly input: {
			name: string;
			vendor: string;
			ownerUserId: string;
			cli: FakeName;
			state: () => FakeState;
			planUsage: PlanUsageSink | undefined;
			billing?: LlmBilling;
			price?: LlmProvider["price"];
		},
	) {
		this.name = input.name;
		this.vendor = input.vendor;
		this.ownerUserId = input.ownerUserId;
		this.billing = input.billing ?? "subscription";
		this.price = input.price;
	}
	async generateObject<T>(request: GenerateObjectRequest<T>): Promise<T> {
		const { cli, state, planUsage } = this.input;
		if (state()[cli] !== "logged_in")
			throw new SubscriptionUnavailableError(
				"logged_out",
				this.name,
				"the test stand-in CLI is not signed in",
			);
		// As the CLIs do: the plan's usage before the prompt, the prompt, the usage after.
		if (cli === "opencode") {
			request.onModelCall?.();
			request.onUsage?.({
				model: this.name.slice("opencode:".length),
				inputTokens: 100,
				outputTokens: 10,
				cachedInputTokens: 0,
				cacheWriteTokens: 0,
			});
			if (request.task === "connection-test") return { ok: true } as T;
			return await this.fake.generateObject(request);
		}
		const call = planUsage?.call();
		const before = fakeSnapshot(cli, state().usage[cli], new Date());
		if (before) planUsage?.sample(before);
		try {
			call?.sent();
			request.onModelCall?.();
			fakeCalls[cli] += 1;
			const after = fakeSnapshot(cli, state().usage[cli], new Date());
			if (after) call?.sample(after);
			if (request.task === "connection-test") return { ok: true } as T;
			return await this.fake.generateObject(request);
		} finally {
			call?.done();
		}
	}
}

/**
 * `Subscriptions` for a test run: fixture states and stand-in providers; no CLI is found, run
 * or asked. PATH is still read from the login shell as in a real run (`real`), which starts
 * no CLI.
 */
export function fakeSubscriptions(
	dir: string,
	real: Subscriptions,
	planUsage?: (vendor: "anthropic" | "openai") => PlanUsageSink,
): Subscriptions {
	const factory: LocalLlmFactory = ({ provider, model, ownerUserId }) => {
		const cli = provider === "codex" ? "codex" : "claude";
		const vendor = cli === "codex" ? "openai" : "anthropic";
		return new FakeCliProvider({
			// The names the real providers have (`claude-subscription:…`, `codex-subscription:…`).
			name: `${cli}-subscription:${model || "test"}`,
			vendor,
			ownerUserId,
			cli,
			state: () => read(dir),
			planUsage: planUsage?.(vendor),
		});
	};
	const check = async (cli: "claude" | "codex") => {
		const state = read(dir);
		const snapshot = fakeSnapshot(cli, state.usage[cli], new Date());
		if (snapshot && state[cli] === "logged_in")
			planUsage?.(cli === "codex" ? "openai" : "anthropic").sample(snapshot);
		return stateOf(cli, state[cli]);
	};
	return withProviders(
		{
			refresh: () => real.refresh(),
			usePath: (pathEnv) => real.usePath(pathEnv),
			factory,
			claude: () => check("claude"),
			codex: () => check("codex"),
		},
		{ antigravity: fakeAntigravity(dir), opencode: fakeOpenCode(dir) },
	);
}

/** The stand-in's Antigravity models, with Google's three thinking levels. */
const FAKE_GEMINI = FAKE_MODELS.antigravity;

/** Gemini (Antigravity) from `fake-clis.json`: Install and Sign in only move the file on. */
function fakeAntigravity(dir: string): ManagedProvider {
	const state = async (): Promise<CliState> => {
		const fake = read(dir).antigravity;
		const installed = fake !== "missing";
		return antigravityState({
			platform: process.platform,
			installed: installed ? "/test/antigravity/agy_acp_server.par" : null,
			signedIn: fake === "logged_in",
			probe:
				fake === "logged_in"
					? {
							login: "logged_in",
							detail: "Signed in with Google (test stand-in).",
							version: "test",
							families: [],
						}
					: null,
		});
	};
	return {
		state,
		models: async () =>
			read(dir).antigravity === "logged_in" ? FAKE_GEMINI : [],
		factory: ({ model, ownerUserId }) =>
			new FakeCliProvider({
				name: `antigravity:${model}`,
				vendor: "google",
				ownerUserId,
				cli: "antigravity",
				state: () => read(dir),
				planUsage: undefined,
			}),
		async install() {
			if (read(dir).antigravity === "missing")
				write(dir, "antigravity", "logged_out");
			return state();
		},
		async signIn() {
			if (read(dir).antigravity === "missing")
				throw new Error(
					"Install Gemini (Antigravity) first, then sign in with Google.",
				);
			write(dir, "antigravity", "logged_in");
			return state();
		},
	};
}

/** OpenCode from `fake-clis.json`: installed and signed in from Terminal, as the real one is. */
function fakeOpenCode(dir: string): ManagedProvider {
	const fromTerminal = () =>
		Promise.reject(
			new Error(
				"OpenCode is installed and signed in from Terminal, not by OfferFinch.",
			),
		);
	return {
		state: async () => stateOf("opencode", read(dir).opencode),
		models: async () =>
			read(dir).opencode === "missing" ? [] : FAKE_OPENCODE_MODELS,
		factory: ({ model, ownerUserId }) => {
			const source = model.slice(0, model.indexOf("/"));
			const info = FAKE_OPENCODE_MODELS.find(
				(m) => m.ref === `opencode:${model}`,
			);
			return new FakeCliProvider({
				name: `opencode:${model}`,
				vendor: `opencode:${source}`,
				ownerUserId,
				cli: "opencode",
				state: () => read(dir),
				planUsage: undefined,
				billing: info?.billing ?? "subscription",
				price: info?.price
					? { ...info.price, cachedInput: info.price.input, source: "test" }
					: undefined,
			});
		},
		install: fromTerminal,
		signIn: fromTerminal,
	};
}

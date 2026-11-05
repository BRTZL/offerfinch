import fs from "node:fs";
import path from "node:path";
import { FakeLlmProvider } from "@offerfinch/core/scoring/fake";
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
import type { LocalLlmFactory } from "./model-factories";
import {
	CLAUDE_FIX,
	type CliFix,
	type CliState,
	CODEX_FIX,
	type Subscriptions,
	withProviders,
} from "./subscriptions";

/**
 * Test runs only: the providers as a test says they are, never the CLIs on this Mac. The state
 * comes from `fake-clis.json` in the data folder, read on every check so a test can change it
 * while the app runs: `{"claude": "logged_in", "codex": "missing", "opencode": "logged_in"}`.
 * Unset: not installed. OpenCode and Gemini (Antigravity) offer the stand-in models below.
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

interface FakeState {
	claude: FakeCli;
	codex: FakeCli;
	opencode: FakeCli;
	antigravity: FakeCli;
	usage: Partial<Record<"claude" | "codex", FakeUsage>>;
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
		plan("antigravity", "gemini-3.8-pro", "Gemini 3.8 Pro", {
			efforts: ["low", "medium", "high"],
		}),
		plan("antigravity", "gemini-3.8-flash", "Gemini 3.8 Flash", {
			efforts: ["low", "medium", "high"],
		}),
	],
};

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
			opencode: pick(raw.opencode),
			antigravity: pick(raw.antigravity),
			usage: {
				claude: usage(raw.usage?.claude),
				codex: usage(raw.usage?.codex),
			},
		};
	} catch {
		return {
			claude: "missing",
			codex: "missing",
			opencode: "missing",
			antigravity: "missing",
			usage: {},
		};
	}
}

/** Stand-in calls made so far, per CLI: each moves the session window by one point. */
const fakeCalls: Record<"claude" | "codex", number> = { claude: 0, codex: 0 };

/** When the stand-in's windows began: one hour before this worker started, so a call is in them. */
const FAKE_WINDOWS_START = Date.now() - 3_600_000;

/** The stand-in's plan usage as a snapshot: a 5-hour and a 7-day window, both running. */
function fakeSnapshot(
	cli: "claude" | "codex",
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

/** OpenCode's commands, for its stand-in (Gemini signs in from the app: no command). */
const OPENCODE_FIX: Record<CliFix["kind"], CliFix> = {
	install: {
		kind: "install",
		command: "curl -fsSL https://opencode.ai/install | bash",
		after: "Then run opencode auth login and sign in.",
	},
	login: { kind: "login", command: "opencode auth login", after: null },
};

const FIXES: Record<FakeKey, Record<CliFix["kind"], CliFix> | null> = {
	claude: CLAUDE_FIX,
	codex: CODEX_FIX,
	opencode: OPENCODE_FIX,
	antigravity: null,
};

type FakeKey = "claude" | "codex" | "opencode" | "antigravity";

function stateOf(cli: FakeKey, fake: FakeCli): CliState {
	const fix = FIXES[cli];
	const name = cli === "codex" ? "The Codex CLI" : `${FAKE_NAMES[cli]}`;
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
		? (fix?.install ?? null)
		: fake === "logged_in"
			? null
			: (fix?.login ?? null);
	return {
		path: installed ? `/test/bin/${cli}` : null,
		version: installed ? "test" : null,
		tested: "test",
		login,
		command: next?.command ?? null,
		fix: next,
	};
}

const FAKE_NAMES: Record<FakeKey, string> = {
	claude: "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	antigravity: "Gemini (Antigravity)",
};

/** A signed-in stand-in answers like the test models; a signed-out one pauses, as the CLI does. */
class FakeCliProvider implements LlmProvider {
	readonly billing = "subscription" as const;
	readonly name: string;
	readonly vendor: string;
	readonly ownerUserId: string;
	private readonly fake = new FakeLlmProvider();
	constructor(
		private readonly input: {
			name: string;
			vendor: string;
			ownerUserId: string;
			cli: FakeKey;
			state: () => FakeState;
			planUsage: PlanUsageSink | undefined;
		},
	) {
		this.name = input.name;
		this.vendor = input.vendor;
		this.ownerUserId = input.ownerUserId;
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
		const metered = cli === "claude" || cli === "codex" ? cli : null;
		const call = planUsage?.call();
		const before = metered
			? fakeSnapshot(metered, state().usage[metered], new Date())
			: null;
		if (before) planUsage?.sample(before);
		try {
			call?.sent();
			request.onModelCall?.();
			if (metered) {
				fakeCalls[metered] += 1;
				const after = fakeSnapshot(metered, state().usage[metered], new Date());
				if (after) call?.sample(after);
			}
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
		const cli: FakeKey = provider;
		const vendor =
			cli === "codex"
				? "openai"
				: cli === "claude"
					? "anthropic"
					: cli === "antigravity"
						? "google"
						: `opencode:${model.split("/")[0]}`;
		return new FakeCliProvider({
			// The names the real providers have (`claude-subscription:…`, `codex-subscription:…`).
			name:
				cli === "claude" || cli === "codex"
					? `${cli}-subscription:${model || "test"}`
					: `${cli}:${model}`,
			vendor,
			ownerUserId,
			cli,
			state: () => read(dir),
			planUsage:
				vendor === "anthropic" || vendor === "openai"
					? planUsage?.(vendor)
					: undefined,
		});
	};
	const check = async (cli: "claude" | "codex") => {
		const state = read(dir);
		const snapshot = fakeSnapshot(cli, state.usage[cli], new Date());
		if (snapshot && state[cli] === "logged_in")
			planUsage?.(cli === "codex" ? "openai" : "anthropic").sample(snapshot);
		return stateOf(cli, state[cli]);
	};
	const subs = withProviders({
		refresh: () => real.refresh(),
		usePath: (pathEnv) => real.usePath(pathEnv),
		factory,
		claude: () => check("claude"),
		codex: () => check("codex"),
	});
	return {
		...subs,
		state: (provider, options) =>
			provider === "opencode" || provider === "antigravity"
				? Promise.resolve(stateOf(provider, read(dir)[provider]))
				: subs.state(provider, options),
		models: async (provider) =>
			provider === "opencode" || provider === "antigravity"
				? read(dir)[provider] === "missing"
					? []
					: FAKE_MODELS[provider]
				: subs.models(provider),
	};
}

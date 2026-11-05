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
import type { LocalLlmFactory } from "./model-factories";
import {
	CLAUDE_FIX,
	type CliState,
	CODEX_FIX,
	type Subscriptions,
	withProviders,
} from "./subscriptions";

/**
 * Test runs only: Claude Code and Codex as a test says they are, never the CLIs on this Mac.
 * The state comes from `fake-clis.json` in the data folder, read on every check so a test can
 * change it while the app runs:
 * `{"claude": "logged_in", "codex": "missing"}`. Unset: neither is installed.
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
	usage: Partial<Record<"claude" | "codex", FakeUsage>>;
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
			usage: {
				claude: usage(raw.usage?.claude),
				codex: usage(raw.usage?.codex),
			},
		};
	} catch {
		return { claude: "missing", codex: "missing", usage: {} };
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

function stateOf(cli: "claude" | "codex", fake: FakeCli): CliState {
	const fix = cli === "claude" ? CLAUDE_FIX : CODEX_FIX;
	const name = cli === "claude" ? "Claude Code" : "The Codex CLI";
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
	readonly billing = "subscription" as const;
	readonly name: string;
	readonly vendor: "anthropic" | "openai";
	readonly ownerUserId: string;
	private readonly fake = new FakeLlmProvider();
	constructor(
		private readonly input: {
			name: string;
			vendor: "anthropic" | "openai";
			ownerUserId: string;
			cli: "claude" | "codex";
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
	return withProviders({
		refresh: () => real.refresh(),
		usePath: (pathEnv) => real.usePath(pathEnv),
		factory,
		claude: () => check("claude"),
		codex: () => check("codex"),
	});
}

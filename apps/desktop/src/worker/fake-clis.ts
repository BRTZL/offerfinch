import fs from "node:fs";
import path from "node:path";
import { FakeLlmProvider } from "@offerfinch/core/scoring/fake";
import {
	type GenerateObjectRequest,
	type LlmProvider,
	SubscriptionUnavailableError,
} from "@offerfinch/core/scoring/llm";
import type { LlmLoginState } from "@offerfinch/core/scoring/llm-status";
import type { LocalLlmFactory } from "./model-factories";
import {
	CLAUDE_FIX,
	type CliState,
	CODEX_FIX,
	type Subscriptions,
} from "./subscriptions";

/**
 * Test runs only: Claude Code and Codex as a test says they are, never the CLIs on this Mac.
 * The state comes from `fake-clis.json` in the data folder, read on every check so a test can
 * change it while the app runs:
 * `{"claude": "logged_in", "codex": "missing"}`. Unset: neither is installed.
 */
type FakeCli = "logged_in" | "logged_out" | "not_subscription" | "missing";
const FAKE_FILE = "fake-clis.json";

function read(dir: string): Record<"claude" | "codex", FakeCli> {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(dir, FAKE_FILE), "utf8"));
		const pick = (v: unknown): FakeCli =>
			v === "logged_in" || v === "logged_out" || v === "not_subscription"
				? v
				: "missing";
		return { claude: pick(raw.claude), codex: pick(raw.codex) };
	} catch {
		return { claude: "missing", codex: "missing" };
	}
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
	private readonly fake = new FakeLlmProvider();
	constructor(
		readonly name: string,
		readonly vendor: "anthropic" | "openai",
		readonly ownerUserId: string,
		private readonly signedIn: () => boolean,
	) {}
	async generateObject<T>(request: GenerateObjectRequest<T>): Promise<T> {
		if (!this.signedIn())
			throw new SubscriptionUnavailableError(
				"logged_out",
				this.name,
				"the test stand-in CLI is not signed in",
			);
		request.onModelCall?.();
		if (request.task === "connection-test") return { ok: true } as T;
		return this.fake.generateObject(request);
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
): Subscriptions {
	const factory: LocalLlmFactory = ({ provider, model, ownerUserId }) => {
		const cli = provider === "codex-subscription" ? "codex" : "claude";
		return new FakeCliProvider(
			`${provider}:${model || "test"}`,
			cli === "codex" ? "openai" : "anthropic",
			ownerUserId,
			() => read(dir)[cli] === "logged_in",
		);
	};
	return {
		refresh: () => real.refresh(),
		usePath: (pathEnv) => real.usePath(pathEnv),
		factory,
		claude: async () => stateOf("claude", read(dir).claude),
		codex: async () => stateOf("codex", read(dir).codex),
	};
}

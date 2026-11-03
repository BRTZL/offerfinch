import fs from "node:fs";
import path from "node:path";
import {
	type GenerateObjectRequest,
	type LlmProvider,
	SubscriptionUnavailableError,
} from "@offerfinch/core/scoring/llm";

/**
 * Test runs only (OFFERFINCH_FAKE_CODEX=1): a Codex subscription stand-in. Each call is "sent"
 * (onModelCall) and appended to `fake-codex-calls` in the data folder; until the file
 * `fake-codex-ok` exists there, the call ends with its payment unknown, as a real call does when
 * the credit balance cannot be read again.
 */
export class FakeCodexSubscription implements LlmProvider {
	readonly name = "codex-subscription:gpt-6.1-terra";
	readonly billing = "subscription" as const;
	readonly vendor = "openai";

	constructor(
		readonly ownerUserId: string,
		private readonly dir: string,
	) {}

	async generateObject<T>(request: GenerateObjectRequest<T>): Promise<T> {
		request.onModelCall?.();
		fs.appendFileSync(
			path.join(this.dir, "fake-codex-calls"),
			`${request.task}\n`,
		);
		if (fs.existsSync(path.join(this.dir, "fake-codex-ok")))
			return { ok: true } as T;
		throw new SubscriptionUnavailableError(
			"extra_usage",
			this.name,
			"the ChatGPT credit balance could not be read again, so whether credits paid for it is unknown (test stand-in)",
			undefined,
			"unknown",
		);
	}
}

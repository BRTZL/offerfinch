import {
	fakeApplicationChatResponder,
	fakeProfileChatResponder,
} from "../chat/fake";
import { fakeStructureResponder } from "../profile/structure";
import type { ProfileSnapshot } from "../profile/types";
import { fakeSearchPlanResponder } from "../search/plan";
import { fakeClaimsResponder, fakeTailorResponder } from "../tailor/fake";
import type { FitAssessment, FitContext } from "./fit";
import {
	fullPrompt,
	type GenerateObjectRequest,
	type LlmProvider,
	type SubscriptionPauseKind,
	SubscriptionUnavailableError,
} from "./llm";

type Responder = (request: GenerateObjectRequest<unknown>) => unknown;

/**
 * Deterministic LLM stand-in for tests and local runs without an API key.
 * Each task gets a responder; unknown tasks throw so tests notice.
 */
export class FakeLlmProvider implements LlmProvider {
	readonly name = "fake";
	readonly calls: { task: string; prompt: string; system: string }[] = [];

	constructor(
		private readonly responders: Record<string, Responder> = {
			"fit-score": heuristicFitResponder,
			tailor: fakeTailorResponder,
			"claims-check": fakeClaimsResponder,
			// Without a real model the extraction fallback finds nothing rather than guessing.
			"extract-jobs": () => ({ jobs: [] }),
			"structure-profile": fakeStructureResponder,
			"extract-posting": fakePostingResponder,
			"chat-application": fakeApplicationChatResponder,
			"chat-profile": fakeProfileChatResponder,
			"search-plan": fakeSearchPlanResponder,
		},
	) {}

	async generateObject<T>(request: GenerateObjectRequest<T>): Promise<T> {
		this.calls.push({
			task: request.task,
			prompt: fullPrompt(request),
			system: request.system,
		});
		const responder = this.responders[request.task];
		if (!responder)
			throw new Error(
				`FakeLlmProvider has no responder for task "${request.task}"`,
			);
		const output = request.schema.parse(
			responder(request as GenerateObjectRequest<unknown>),
		);
		// Rough token counts, so cost tracking has something to show; the fake costs nothing.
		request.onUsage?.({
			model: "fake",
			inputTokens: Math.ceil(
				(request.system.length + fullPrompt(request).length) / 4,
			),
			outputTokens: Math.ceil(JSON.stringify(output).length / 4),
			cachedInputTokens: 0,
			cacheWriteTokens: 0,
		});
		return output;
	}
}

/**
 * The fake, billed as a subscription: for tests and e2e runs of the subscription path (the $0
 * rows, the 'Subscription' label, a usage-limit or logged-out pause and its resume) without a
 * real CLI. `FAKE_SUBSCRIPTION_FAIL=usage_limit|logged_out` is read at call time, so a running
 * e2e server can switch it on and off.
 */
export class FakeSubscriptionProvider implements LlmProvider {
	readonly name = "fake-subscription:fake";
	readonly billing = "subscription" as const;
	readonly vendor = "fake-subscription";
	readonly calls: string[] = [];

	constructor(
		readonly ownerUserId: string | undefined,
		private readonly fake: LlmProvider = new FakeLlmProvider(),
		private readonly failure: () => string | undefined = () =>
			typeof process === "undefined"
				? undefined
				: process.env.FAKE_SUBSCRIPTION_FAIL,
	) {}

	async generateObject<T>(request: GenerateObjectRequest<T>): Promise<T> {
		this.calls.push(request.task);
		const failure = this.failure();
		if (failure === "usage_limit" || failure === "logged_out")
			throw new SubscriptionUnavailableError(
				failure as SubscriptionPauseKind,
				this.name,
				failure === "usage_limit"
					? "the fake plan's usage limit is reached (FAKE_SUBSCRIPTION_FAIL). It resumes after a later scan once the limit resets, with status in Settings › Models."
					: "the fake CLI is logged out (FAKE_SUBSCRIPTION_FAIL). Log in, then check Settings › Models. Preparation retries after the next scan.",
			);
		// Paid extra usage, as the CLI reports it after the request was billed.
		if (failure === "extra_usage" || failure === "extra_usage_no_usage") {
			request.onModelCall?.();
			if (failure === "extra_usage")
				await this.fake.generateObject(request).catch(() => {});
			throw new SubscriptionUnavailableError(
				"extra_usage",
				this.name,
				"the fake plan drew on paid extra usage (FAKE_SUBSCRIPTION_FAIL). Turn extra usage off at claude.ai > Settings > Usage, then confirm it in Settings > Models.",
				undefined,
				true,
			);
		}
		request.onModelCall?.();
		return this.fake.generateObject(request);
	}
}

/** Skill terms the keyword matcher and the ATS keyword check look for. */
export const SKILL_TERMS = [
	"TypeScript",
	"JavaScript",
	"React Native",
	"React",
	"Next.js",
	"Node.js",
	"NestJS",
	"Hono",
	"Express",
	"GraphQL",
	"PostgreSQL",
	"Postgres",
	"MySQL",
	"MongoDB",
	"Redis",
	"Go",
	"Golang",
	"Python",
	"Django",
	"Java",
	"Spring Boot",
	"Kotlin",
	"Swift",
	"Ruby on Rails",
	"Rails",
	"Ruby",
	"PHP",
	"C#",
	"Unity",
	"Docker",
	"Kubernetes",
	"AWS",
	"GCP",
	"Cloudflare",
	"Terraform",
	"Tailwind",
	"Jest",
	"Cypress",
	"Playwright",
	"Kafka",
	"RabbitMQ",
	"SQL",
	"CI/CD",
	"MCP",
	"LLM",
	"Claude Code",
	"Codex",
	"Cursor",
	"Storybook",
	"design system",
	"Figma",
	"accessibility",
	"Rust",
	"Scala",
	"Elixir",
	"C++",
];

function termPattern(term: string): RegExp {
	const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		`(?:^|[^A-Za-z0-9])${escaped}(?:$|[^A-Za-z0-9#+])`,
		term.length <= 3 ? "" : "i",
	);
}

function requirementLines(description: string): string[] {
	const lines = description.split("\n").map((l) => l.trim());
	const picked: string[] = [];
	let inSection = false;
	for (const line of lines) {
		if (!line) continue;
		const isBullet = /^[-•*·]\s+/.test(line);
		if (!isBullet && line.length < 80) {
			inSection =
				/requir|qualif|you have|you bring|looking for|skills|experience|must|about you|what we need|nice to have|bonus/i.test(
					line,
				);
			continue;
		}
		if (isBullet && inSection) picked.push(line.replace(/^[-•*·]\s+/, ""));
	}
	if (picked.length === 0) {
		for (const line of lines)
			if (/^[-•*·]\s+/.test(line)) picked.push(line.replace(/^[-•*·]\s+/, ""));
	}
	return picked.slice(0, 15);
}

function findQuote(
	profile: ProfileSnapshot,
	term: string,
): { file: string; quote: string } | undefined {
	const pattern = termPattern(term);
	for (const file of profile.files) {
		for (const line of file.content.split("\n")) {
			if (pattern.test(line)) {
				const trimmed = line.trim().replace(/^[-*]\s+/, "");
				return {
					file: file.path,
					quote: trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed,
				};
			}
		}
	}
	return undefined;
}

/** Keyword match between posting bullets and profile lines. Quotes are always copied from the profile. */
export function heuristicFitResponder(
	request: GenerateObjectRequest<unknown>,
): FitAssessment {
	const { job, profile } = request.context as FitContext;
	const requirements = requirementLines(job.descriptionText).map((line) => {
		const terms = SKILL_TERMS.filter((term) => termPattern(term).test(line));
		const evidence = terms
			.map((term) => findQuote(profile, term))
			.filter((quote): quote is { file: string; quote: string } =>
				Boolean(quote),
			);
		const found = new Set(evidence.map((e) => e.quote)).size;
		const status: FitAssessment["requirements"][number]["status"] =
			terms.length === 0
				? "unknown"
				: found === 0
					? "not_met"
					: evidence.length >= terms.length
						? "met"
						: "partial";
		return {
			requirement: line,
			importance: /\b(plus|nice to have|bonus|preferred|desirable)\b/i.test(
				line,
			)
				? ("nice" as const)
				: ("must" as const),
			status,
			evidence,
			note:
				terms.length === 0
					? "No known skill terms to match."
					: `Matched ${evidence.length} of ${terms.length} terms (${terms.join(", ")}).`,
		};
	});
	return {
		requirements,
		summary: `Heuristic match on ${requirements.length} requirement lines.`,
	};
}

/**
 * The fake model's reading of one posting page: the first line that is a heading as the title,
 * the posting from that line to the end, the company from the page's site name or "at Company"
 * in the text. Pages too short to be a posting are not.
 */
function fakePostingResponder(request: GenerateObjectRequest<unknown>) {
	const context = request.context as {
		text?: string;
		html?: string;
		lines?: string[];
	};
	const text = String(context?.text ?? "");
	const html = String(context?.html ?? "");
	const lines = context?.lines ?? text.split("\n");
	const heading = lines.findIndex((l) => /^#{1,3} /.test(l));
	const start = heading >= 0 ? heading : lines.findIndex((l) => l.trim());
	const company =
		html.match(/property="og:site_name"\s+content="([^"]+)"/i)?.[1] ??
		text.match(/\bat ([A-Z][\w&. -]{1,40}?)(?:[,.\n]| is\b)/)?.[1] ??
		"";
	const location = text.match(/\b(Remote(?: [-–] [A-Za-z ]+)?)\b/)?.[1] ?? "";
	return {
		isPosting:
			text.length > 200 &&
			/\b(requirements|responsibilities|you will|about the role)\b/i.test(text),
		title: (lines[start] ?? "").replace(/^#+ /, ""),
		company: company.trim(),
		location,
		firstLine: start + 2,
		lastLine: lines.length,
	};
}

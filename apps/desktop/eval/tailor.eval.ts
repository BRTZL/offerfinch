import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
	type GenerateObjectRequest,
	LlmPausedError,
	type LlmProvider,
} from "@offerfinch/core/scoring/llm";
import {
	type ClaimsCheckOutput,
	type ClaimsInput,
	type ClaimsReport,
	checkClaims,
	checkRulesOnly,
	segmentDocuments,
	verifyClaims,
} from "@offerfinch/core/tailor/claims";
import { buildFlags, type ReviewFlag } from "@offerfinch/core/tailor/flags";
import {
	notesWithDropped,
	selectQuestions,
} from "@offerfinch/core/tailor/questions";
import {
	formAnswersText,
	type TailoredDocuments,
	tailorApplication,
} from "@offerfinch/core/tailor/tailor";
import {
	CLAUDE_SUBSCRIPTION,
	ClaudeSubscriptionProvider,
	CODEX_SUBSCRIPTION,
	CodexSubscriptionProvider,
	claudeLogin,
} from "@offerfinch/local-llm";
import { it } from "vitest";
import {
	createClaimsLlm,
	createLlm,
	createTailorLlm,
	type LocalLlmFactory,
	type ModelConfig,
} from "../src/worker/model-factories";
import { EVAL_POSTINGS, EVAL_PROFILE, type EvalPosting } from "./fixtures";
import { type DocScore, scoreDocuments } from "./score";

/**
 * Tailoring eval: the app's own tailoring and claims check on a fabricated profile and four
 * fabricated postings, with real subscription models (Claude for tailoring, Codex for the check,
 * built by the app's model factories). Not part of `pnpm test`. Run from apps/desktop:
 *
 *   EVAL_RUN=baseline pnpm eval:tailor            # draft + check every posting
 *   EVAL_RUN=baseline EVAL_ONLY=tallyway-platform pnpm eval:tailor
 *   EVAL_RUN=baseline EVAL_REDRAFT=1 …            # also the app's one automatic redraft
 *   EVAL_RUN=baseline EVAL_CLAIMS=rules …         # drafts and fixed rules only, no claims model
 *   EVAL_RUN=baseline EVAL_MODE=replay …          # re-verify saved checker output, no model call
 *   EVAL_RUN=baseline EVAL_MODE=score …           # scorecard only, from saved output
 *
 * Output: /tmp/offerfinch-eval/<run>/<posting>/ (Markdown documents, flags, raw model output) and
 * scorecard.md. Judge each flag in <run>/verdicts.json ({"<posting>#<flag id>": {"verdict":
 * "TP" | "FP", "why": "…"}}); the scorecard counts them. Every model call is logged in
 * /tmp/offerfinch-eval/calls.log and the eval refuses to start a call past EVAL_MAX_CALLS (55).
 */

const ROOT = "/tmp/offerfinch-eval";
const RUN = process.env.EVAL_RUN || new Date().toISOString().slice(0, 16);
const DIR = path.join(ROOT, RUN.replace(/[^\w.-]/g, "-"));
const MODE = process.env.EVAL_MODE || "run";
const ONLY = process.env.EVAL_ONLY?.split(",").filter(Boolean);
const REDRAFT = process.env.EVAL_REDRAFT === "1";
/** "rules": skip the claims model and run only the deterministic rules (a paused Codex plan). */
const CLAIMS = process.env.EVAL_CLAIMS || "model";
const RULES_ONLY = "rules only (claims model not run)";
const MAX_CALLS = Number(process.env.EVAL_MAX_CALLS || 55);
const LEDGER = path.join(ROOT, "calls.log");
const OWNER = "eval-owner";
const TODAY = "2026-11-03";

const postings = EVAL_POSTINGS.filter((p) => !ONLY || ONLY.includes(p.slug));

function write(file: string, content: string) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function callsSoFar(): number {
	if (!fs.existsSync(LEDGER)) return 0;
	return fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).length;
}

/** Every model call: counted against the budget, its prompt and raw output saved. */
class Recorder implements LlmProvider {
	readonly name: string;
	readonly billing;
	readonly vendor;
	readonly ownerUserId;
	constructor(
		private readonly inner: LlmProvider,
		private readonly dir: string,
		private readonly label: string,
	) {
		this.name = inner.name;
		this.billing = inner.billing;
		this.vendor = inner.vendor;
		this.ownerUserId = inner.ownerUserId;
	}
	async generateObject<T>(request: GenerateObjectRequest<T>): Promise<T> {
		const used = callsSoFar();
		if (used >= MAX_CALLS)
			throw new Error(
				`Model call budget reached (${used}/${MAX_CALLS}); see ${LEDGER}`,
			);
		fs.mkdirSync(ROOT, { recursive: true });
		fs.appendFileSync(
			LEDGER,
			`${new Date().toISOString()} ${RUN} ${this.label} ${request.task} ${this.name}\n`,
		);
		write(
			path.join(this.dir, "raw", `${this.label}.prompt.md`),
			`# System\n\n${request.system}\n\n# Prompt prefix\n\n${request.promptPrefix ?? ""}\n\n# Prompt\n\n${request.prompt}\n`,
		);
		const started = Date.now();
		const output = await this.inner.generateObject(request);
		write(
			path.join(this.dir, "raw", `${this.label}.output.json`),
			JSON.stringify(
				{ seconds: (Date.now() - started) / 1000, output },
				null,
				2,
			),
		);
		return output;
	}
}

/** The desktop's subscription factory (`worker/subscriptions.ts`) without Electron. */
const local: LocalLlmFactory = ({ provider, model, effort, ownerUserId }) => {
	if (provider === CLAUDE_SUBSCRIPTION)
		return new ClaudeSubscriptionProvider({
			model,
			effort,
			ownerUserId,
			parentEnv: process.env,
		});
	if (provider === CODEX_SUBSCRIPTION) {
		const binary = fs.realpathSync(
			execFileSync("/usr/bin/which", ["codex"], { encoding: "utf8" }).trim(),
		);
		return new CodexSubscriptionProvider({
			model,
			effort,
			ownerUserId,
			parentEnv: process.env,
			binary,
		});
	}
	throw new Error(`Unknown subscription provider: ${provider}`);
};

/** Settings › Models with Claude for scoring and tailoring and Codex for the check, defaults otherwise. */
function models() {
	const env: ModelConfig = {
		scoringProvider: "claude-subscription",
		tailoringProvider: "claude-subscription",
		claimsProvider: "codex-subscription",
		ownerUserId: OWNER,
	};
	const llm = createLlm(env, { local });
	const tailor = createTailorLlm(env, llm, { local });
	const claims = createClaimsLlm(env, { tailoring: tailor, local });
	return { tailor, claims };
}

/** The claims input exactly as `reviewStep` builds it. */
function claimsInput(
	posting: EvalPosting,
	docs: TailoredDocuments,
): ClaimsInput {
	return {
		documents: {
			cv: docs.cv,
			cover_letter: docs.coverLetter,
			form_answers: formAnswersText(docs.formAnswers),
		},
		formAnswers: docs.formAnswers,
		profile: EVAL_PROFILE,
		context: {
			companyName: posting.job.companyName,
			jobTitle: posting.job.title,
		},
		postingText: posting.job.descriptionText,
	};
}

function flagsOf(input: ClaimsInput, report: ClaimsReport): ReviewFlag[] {
	const segments = segmentDocuments(input).map((s) => ({
		document: s.document,
		text: s.text,
		context: s.context,
		occurrence: s.occurrence,
	}));
	return buildFlags(report.issues, [], segments);
}

interface Attempt {
	docs: TailoredDocuments;
	asked: { question: string; why: string }[];
	report: ClaimsReport;
	flags: ReviewFlag[];
}

function saveAttempt(dir: string, n: number, posting: EvalPosting, a: Attempt) {
	const suffix = n === 1 ? "" : `-redraft${n - 1}`;
	write(path.join(dir, `cv${suffix}.md`), `${a.docs.cv}\n`);
	write(path.join(dir, `cover-letter${suffix}.md`), `${a.docs.coverLetter}\n`);
	write(
		path.join(dir, `answers${suffix}.md`),
		a.docs.formAnswers
			.map((f) => `## ${f.question}\n\n${f.answer}\n`)
			.join("\n"),
	);
	write(
		path.join(dir, `notes${suffix}.md`),
		`${a.docs.notes}\n\n## Questions the app would ask\n\n${a.asked.map((q) => `- ${q.question} (${q.why})`).join("\n") || "none"}\n`,
	);
	write(
		path.join(dir, `claims${suffix}.md`),
		`# Claims check: ${posting.job.companyName}, ${posting.job.title}\n\nProvider: ${a.report.provider}. Passed: ${a.report.passed}. Flags: ${a.flags.length}.\n\n## Flags\n\n${
			a.flags
				.map(
					(f) =>
						`### ${f.id} (${f.document})\n\n> ${f.text ?? "(whole document)"}\n\n${f.reasons.map((r) => `- **${r.rule}:** ${r.message}`).join("\n")}\n`,
				)
				.join("\n") || "none\n"
		}\n## Claims\n\n${a.report.claims
			.map(
				(c) =>
					`- [${c.supported ? "ok" : "UNSUPPORTED"}] (${c.document}) ${c.text}${c.evidence.map((e) => `\n  - ${e.file}: "${e.quote}"`).join("")}${c.rejected.map((r) => `\n  - rejected ${r.file}: "${r.quote}" (${r.reason})`).join("")}`,
			)
			.join("\n")}\n`,
	);
	write(
		path.join(dir, `result${suffix}.json`),
		JSON.stringify(
			{ docs: a.docs, asked: a.asked, report: a.report, flags: a.flags },
			null,
			2,
		),
	);
}

/**
 * The claims check, or the fixed rules alone when it is turned off or its plan is paused (a
 * usage window near its limit): the drafts are still scored, and the report says the model
 * check did not run.
 */
async function claimsReport(
	llm: LlmProvider,
	input: ClaimsInput,
): Promise<ClaimsReport> {
	const rulesOnly = (): ClaimsReport => {
		const issues = checkRulesOnly(input);
		return {
			passed: issues.length === 0,
			provider: RULES_ONLY,
			claims: [],
			issues,
		};
	};
	if (CLAIMS === "rules") return rulesOnly();
	try {
		return await checkClaims(llm, input);
	} catch (error) {
		if (!(error instanceof LlmPausedError)) throw error;
		console.error(`claims check paused, rules only: ${String(error)}`);
		return rulesOnly();
	}
}

async function runPosting(posting: EvalPosting): Promise<void> {
	const dir = path.join(DIR, posting.slug);
	const { tailor, claims } = models();
	let previous: ClaimsReport | null = null;
	for (let n = 1; n <= (REDRAFT ? 2 : 1); n++) {
		const docs = await tailorApplication(
			new Recorder(tailor, dir, `tailor-${n}`),
			{
				job: posting.job,
				profile: EVAL_PROFILE,
				fit: null,
				today: TODAY,
				previousIssues:
					previous && !previous.passed ? previous.issues : undefined,
				askedQuestions: [],
				questionsAllowed: n === 1 ? 3 : 0,
			},
		);
		const selection = selectQuestions(docs.missingFacts, {
			profile: EVAL_PROFILE,
			asked: [],
			budget: { rounds: n - 1, maxRounds: 1, maxQuestions: 3 },
		});
		docs.notes = notesWithDropped(docs.notes, selection.dropped);
		const input = claimsInput(posting, docs);
		const report = await claimsReport(
			new Recorder(claims, dir, `claims-${n}`),
			input,
		);
		const attempt = {
			docs,
			asked: selection.ask,
			report,
			flags: flagsOf(input, report),
		};
		saveAttempt(dir, n, posting, attempt);
		if (report.passed) break;
		previous = report;
	}
}

/** Re-verifies the saved checker output with the current code: no model call. */
function replayPosting(posting: EvalPosting): void {
	const dir = path.join(DIR, posting.slug);
	for (let n = 1; n <= 2; n++) {
		const suffix = n === 1 ? "" : `-redraft${n - 1}`;
		const resultFile = path.join(dir, `result${suffix}.json`);
		const rawFile = path.join(dir, "raw", `claims-${n}.output.json`);
		if (!fs.existsSync(resultFile) || !fs.existsSync(rawFile)) continue;
		const saved = JSON.parse(fs.readFileSync(resultFile, "utf8")) as Attempt;
		const raw = JSON.parse(fs.readFileSync(rawFile, "utf8")) as {
			output: ClaimsCheckOutput;
		};
		const input = claimsInput(posting, saved.docs);
		const report = verifyClaims(raw.output, input, saved.report.provider);
		saveAttempt(dir, n, posting, {
			...saved,
			report,
			flags: flagsOf(input, report),
		});
	}
}

type Verdicts = Record<string, { verdict: "TP" | "FP"; why?: string }>;

function scorecard(): string {
	const verdictsFile = path.join(DIR, "verdicts.json");
	const verdicts: Verdicts = fs.existsSync(verdictsFile)
		? JSON.parse(fs.readFileSync(verdictsFile, "utf8"))
		: {};
	const rows: string[] = [];
	let tp = 0;
	let fp = 0;
	let unjudged = 0;
	for (const posting of EVAL_POSTINGS) {
		const file = path.join(DIR, posting.slug, "result.json");
		if (!fs.existsSync(file)) continue;
		const a = JSON.parse(fs.readFileSync(file, "utf8")) as Attempt;
		const s: DocScore = scoreDocuments(posting, a.docs);
		const byDoc: Record<string, string[]> = {};
		for (const f of a.flags) {
			const v = verdicts[`${posting.slug}#${f.id}`]?.verdict;
			if (v === "TP") tp++;
			else if (v === "FP") fp++;
			else unjudged++;
			const rule = f.reasons.map((r) => r.rule).join("+");
			byDoc[f.document] = [
				...(byDoc[f.document] ?? []),
				`${rule}${v ? ` ${v}` : " ?"}`,
			];
		}
		const redraft = fs.existsSync(
			path.join(DIR, posting.slug, "result-redraft1.json"),
		);
		rows.push(
			`## ${posting.slug} (${posting.kind})`,
			"",
			`- Claims check (${a.report.provider}): ${a.report.passed ? "passed" : "flagged"}, ${a.flags.length} flags${redraft ? " (a redraft followed)" : ""}`,
			...Object.entries(byDoc).map(
				([doc, list]) => `  - ${doc}: ${list.join(", ")}`,
			),
			`- Questions the app would ask: ${a.asked.map((q) => q.question).join(" | ") || "none"}`,
			`- Letter: ${s.letterWords} words (220–400), ${s.letterParagraphs} body paragraphs, longest ${s.longestParagraphWords} words; ${s.letterStartsI}/${s.letterSentences} sentences open with "I"; top opener "${s.letterTopOpener}"; em dashes ${s.letterEmDashes}`,
			`- Letter clichés: ${s.letterCliches.join("; ") || "none"}`,
			`- Names company: ${s.namesCompany}; names role exactly: ${s.namesRole}`,
			`- Answers (${s.answers.length}; same opener ×${s.answersSameOpener}; missing form questions: ${s.missingFormQuestions.join(", ") || "none"}):`,
			...s.answers.map(
				(x) =>
					`  - "${x.question}": ${x.words} words${x.expected ? `, answers ${x.expected} in first sentence: ${x.answersIt}` : ""}${x.startsWithI ? ", opens with I" : ""}${x.emDashes ? `, em dashes ${x.emDashes}` : ""}${x.cliches.length ? `, clichés: ${x.cliches.join("; ")}` : ""}`,
			),
			`- Placeholders: ${s.placeholders.join(", ") || "none"}; CV ${s.cvWords} words`,
			"",
		);
	}
	const head = `# Scorecard: ${RUN}\n\nFlags judged: ${tp} true positive, ${fp} false positive, ${unjudged} not judged yet.\nModel calls logged so far (all runs): ${callsSoFar()}.\n\n`;
	return head + rows.join("\n");
}

it(`tailoring eval (${MODE}, ${RUN})`, async () => {
	fs.mkdirSync(DIR, { recursive: true });
	if (MODE === "run") {
		const login = await claudeLogin(process.env);
		if (login.state !== "logged_in")
			throw new Error(
				`Claude subscription not ready: ${JSON.stringify(login)}`,
			);
		const failures: string[] = [];
		// Two at a time: a subscription limit or logout trips the vendor's breaker for all.
		const queue = [...postings];
		const worker = async () => {
			for (let p = queue.shift(); p; p = queue.shift()) {
				try {
					await runPosting(p);
				} catch (error) {
					const paused = error instanceof LlmPausedError;
					failures.push(
						`${p.slug}: ${paused ? "PAUSED " : ""}${String(error)}`,
					);
					write(path.join(DIR, p.slug, "error.txt"), String(error));
					if (paused) queue.length = 0;
				}
			}
		};
		await Promise.all([worker(), worker()]);
		if (failures.length) console.error(failures.join("\n"));
	} else if (MODE === "replay") for (const p of postings) replayPosting(p);
	const card = scorecard();
	write(path.join(DIR, "scorecard.md"), card);
	console.log(card);
}, 3_600_000);

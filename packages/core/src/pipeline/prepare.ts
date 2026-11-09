import { compareApproval, hashDocuments } from "../domain/approval";
import { type ExportInput, exportDocuments } from "../export/export";
import { LlmPausedError } from "../scoring/llm";
import {
	capReached,
	meteredFor,
	SpendingCapReachedError,
	subscriptionBudgetReached,
} from "../scoring/metered";
import {
	type CheckedClaim,
	type ClaimsInput,
	checkClaims,
	checkRulesOnly,
	focusedInput,
	segmentDocuments,
	segmentKey,
} from "../tailor/claims";
import {
	buildFlags,
	type CheckedSegment,
	flagKey,
	MODEL_RULES,
	modelIssues,
	openFlags,
	type ReviewFlag,
	type ReviewStatus,
} from "../tailor/flags";
import type { RuleIssue } from "../tailor/profile-rules";
import {
	type AskedQuestion,
	notesWithDropped,
	type QuestionBudget,
	questionsAllowed,
	selectQuestions,
} from "../tailor/questions";
import { citedUnits, staleCitations } from "../tailor/stale";
import {
	formAnswersText,
	parseFormAnswers,
	tailorApplication,
} from "../tailor/tailor";
import { formQuestionsForDraft } from "./form-step";
import {
	ApplicationNotFoundError,
	type PipelineDeps,
	type StoredReview,
} from "./ports";

/**
 * Checked drafts made automatically: the first and one redraft after a failed claims check, so
 * at most two tailoring calls and two claims checks per application (a draft that only asked
 * questions, and the one after the answers, are the answer round). Flags left after that go to
 * the user (`claims_flagged`), never to `failed`.
 */
const MAX_DRAFTS = 2;

function today(deps: PipelineDeps): string {
	return (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
}

/** The posting the documents answer, bound into the review's and approval's hashes. */
const postingOf = (app: {
	companyName?: string | null;
	job: { title: string; descriptionText: string };
}) => ({
	title: app.job.title,
	company: app.companyName ?? "",
	description: app.job.descriptionText,
});

async function load(deps: PipelineDeps, userId: string, jobId: string) {
	const app = await deps.repo.getApplicationByJob(userId, jobId);
	if (!app) throw new ApplicationNotFoundError(userId, jobId);
	return app;
}

/**
 * scored -> preparing (after the user pressed Prepare), unless the score ended the application or
 * the spending cap is
 * reached ("capped": it waits in scored until the cap changes).
 */
export async function startPreparingStep(
	deps: PipelineDeps,
	userId: string,
	jobId: string,
): Promise<boolean | "capped"> {
	const app = await load(deps, userId, jobId);
	if (app.state !== "scored" || app.endedReason) return false;
	// The cap stops API-key work only: drafting and checking all on plans never wait for it.
	const tailoring = deps.tailorLlm ?? deps.llm;
	const capped =
		(await capReached(deps.spend, userId, [tailoring, deps.claimsLlm])) ??
		(await subscriptionBudgetReached(deps.spend, userId, [tailoring]));
	if (capped) {
		// The application says why it waits (the cap shows on Settings > Spending).
		if (!(capped instanceof SpendingCapReachedError))
			await deps.spend?.recordRefusal({
				userId,
				applicationId: app.applicationId,
				task: "tailor",
				provider: tailoring.name,
				error: capped.message,
			});
		deps.log?.("preparation paused", {
			applicationId: app.applicationId,
			reason: capped.message,
		});
		return "capped";
	}
	return deps.repo.transition(userId, app.applicationId, {
		from: ["scored"],
		to: "preparing",
		reason: `Fit score ${app.score} passed; preparing documents`,
		actor: "workflow",
		// Unless the run was started on demand: then only on a Prepare request that still stands.
		requirePrepareRequest: deps.repo.prepareRequested !== undefined,
	});
}

export type DraftOutcome =
	| { outcome: "drafted" }
	| { outcome: "capped"; reason: string }
	| { outcome: "questions"; open: number }
	| { outcome: "skipped"; state: string };

/**
 * Tailors a new draft from the current profile (answers included). Facts the profile lacks
 * become questions and move the application to `needs_answers`, within the question budget
 * (`questionRounds` per application, `maxQuestionsPerRound` each, must-haves and form questions
 * only, never a topic already asked or settled); the rest are named as gaps in the notes.
 */
export async function draftStep(
	deps: PipelineDeps,
	userId: string,
	jobId: string,
): Promise<DraftOutcome> {
	const app = await load(deps, userId, jobId);
	if (app.state !== "preparing")
		return { outcome: "skipped", state: app.state };
	const profile = await deps.repo.getProfile(userId);
	if (!profile) throw new Error(`No profile for ${userId}`);
	const budget = await questionBudget(deps, userId, app.applicationId);
	const previous =
		app.prepareAttempts > 0
			? await deps.repo.latestReview(userId, app.applicationId)
			: null;
	// The form read before drafting: its questions nothing on file answers go to the model.
	const formQuestions = await formQuestionsForDraft(
		deps,
		userId,
		app.applicationId,
	);
	let draft: Awaited<ReturnType<typeof tailorApplication>>;
	try {
		draft = await tailorApplication(
			meteredFor(
				deps.tailorLlm ?? deps.llm,
				deps.spend,
				userId,
				app.applicationId,
			),
			{
				job: { ...app.job, companyName: app.companyName },
				profile,
				fit: app.fit,
				today: today(deps),
				previousIssues:
					previous && !previous.passed ? previous.issues : undefined,
				askedQuestions: budget.asked,
				questionsAllowed: questionsAllowed(budget),
				...(formQuestions.length > 0 ? { formQuestions } : {}),
				writingStyle: await deps.writingStyle?.(userId),
			},
		);
	} catch (error) {
		if (error instanceof LlmPausedError)
			return { outcome: "capped", reason: error.message };
		throw error;
	}
	const selection = selectQuestions(draft.missingFacts, {
		profile,
		asked: budget.asked,
		budget,
	});
	await deps.repo.saveDraft(
		userId,
		app.applicationId,
		{ ...draft, notes: notesWithDropped(draft.notes, selection.dropped) },
		"workflow",
	);
	deps.log?.("application drafted", {
		applicationId: app.applicationId,
		provider: draft.provider,
		missingFacts: draft.missingFacts.length,
		asked: selection.ask.length,
		notAsked: selection.dropped.length,
	});
	if (selection.ask.length === 0) return { outcome: "drafted" };
	const { open } = await deps.repo.askQuestions(
		userId,
		app.applicationId,
		selection.ask,
		"{open} question(s) for the user before tailoring can finish",
	);
	return { outcome: "questions", open };
}

async function questionBudget(
	deps: PipelineDeps,
	userId: string,
	applicationId: string,
): Promise<QuestionBudget & { asked: AskedQuestion[] }> {
	const settings = await deps.repo.getFilterSettings(userId);
	const history = await deps.repo.questionHistory(userId, applicationId);
	return {
		rounds: history.rounds,
		maxRounds: settings.questionRounds,
		maxQuestions: settings.maxQuestionsPerRound,
		asked: history.asked,
	};
}

export type ReviewOutcome =
	| { outcome: "reviewed"; passed: boolean; reviewId: string }
	| { outcome: "capped"; reason: string }
	| { outcome: "unchanged"; passed: boolean; reviewId: string }
	| { outcome: "no_documents" };

/**
 * Reviews the current documents: the independent claims check and the deterministic rules, then,
 * if those pass, PDF and DOCX export and the ATS check. A version already reviewed is not checked
 * again, so a duplicate event costs nothing.
 */
export async function reviewStep(
	deps: PipelineDeps,
	userId: string,
	jobId: string,
): Promise<ReviewOutcome> {
	const app = await load(deps, userId, jobId);
	const docs = await deps.repo.latestDocuments(userId, app.applicationId);
	const byKind = Object.fromEntries(docs.map((d) => [d.kind, d]));
	if (!byKind.cv || !byKind.cover_letter) return { outcome: "no_documents" };
	const hashes = await hashDocuments(docs, postingOf(app));
	const latest = await deps.repo.latestReview(userId, app.applicationId);
	const profile = await deps.repo.getProfile(userId);
	// A passed review whose quotes the profile no longer holds (a record edited or removed since)
	// is checked again in full, on the current profile.
	const stale =
		latest?.passed === true &&
		staleCitations(
			latest.claims ?? [],
			profile,
			latest.flags ?? [],
			latest.cited ?? [],
		).length > 0;
	const sameVersion =
		latest !== null &&
		compareApproval(latest.documentHashes, hashes).ok &&
		!stale;
	// A finished review of this version (or a failed claims check) is final.
	if (latest && sameVersion && (latest.atsChecked || !latest.passed))
		return { outcome: "unchanged", passed: latest.passed, reviewId: latest.id };

	if (!profile) throw new Error(`No profile for ${userId}`);
	let reviewId: string;
	let claimsPassed: boolean;
	let provider: string;
	let flags: ReviewFlag[] = latest?.flags ?? [];
	if (latest && sameVersion) {
		// The claims check passed but export or ATS did not finish (a retried step), or the user
		// cleared the last flag: resume from the export instead of paying for the check again.
		reviewId = latest.id;
		claimsPassed = true;
		provider = latest.provider;
	} else {
		if (!deps.claimsLlm)
			throw new Error("No claims-check model configured (claimsLlm)");
		const formAnswers = parseFormAnswers(byKind.form_answers?.content ?? "[]");
		const input: ClaimsInput = {
			documents: {
				cv: byKind.cv.content,
				cover_letter: byKind.cover_letter.content,
				form_answers: formAnswersText(formAnswers),
			},
			formAnswers,
			profile,
			context: { companyName: app.companyName, jobTitle: app.job.title },
			postingText: app.job.descriptionText,
		};
		// An edit in review re-checks only the lines that changed since the last check.
		const base =
			app.state === "ready_for_review" && latest?.segments?.length && !stale
				? latest
				: null;
		let checked: Checked;
		try {
			checked = base
				? await recheckChanged(deps, userId, app.applicationId, input, base)
				: await checkAll(deps, userId, app.applicationId, input);
		} catch (error) {
			if (error instanceof LlmPausedError)
				return { outcome: "capped", reason: error.message };
			throw error;
		}
		flags = checked.flags;
		const passed = openFlags(flags).length === 0;
		const status: ReviewStatus = passed
			? "passed"
			: app.state === "ready_for_review"
				? "claims_flagged"
				: "failed";
		reviewId = await deps.repo.recordReview(userId, app.applicationId, {
			documentHashes: hashes,
			provider: checked.provider,
			passed,
			issues: checked.issues,
			claims: checked.claims,
			status,
			flags,
			segments: checked.segments,
			cited: citedUnits(checked.claims, profile),
		});
		claimsPassed = passed;
		provider = checked.provider;
	}
	let atsIssues: RuleIssue[] = [];
	if (claimsPassed) {
		const { browser, blobs } = deps;
		const exporter =
			deps.exporter ??
			((exportInput: ExportInput) => {
				if (!browser || !blobs)
					throw new Error("Export needs a browser provider and a blob store");
				return exportDocuments({ browser, blobs }, exportInput);
			});
		const exported = await exporter({
			userId,
			applicationId: app.applicationId,
			jobTitle: app.job.title,
			companyName: app.companyName,
			postingText: app.job.descriptionText,
			profile,
			documents: [
				{
					kind: "cv",
					version: byKind.cv.version,
					content: byKind.cv.content,
				},
				{
					kind: "cover_letter",
					version: byKind.cover_letter.version,
					content: byKind.cover_letter.content,
				},
			],
			look: await deps.documentLook?.(),
		});
		for (const record of exported.records)
			await deps.repo.saveExport(userId, app.applicationId, record);
		atsIssues = exported.atsIssues;
	}
	const passed = claimsPassed
		? await deps.repo.completeReview(userId, reviewId, atsIssues, {
				flags: [...flags, ...buildFlags(atsIssues)],
				failedStatus:
					app.state === "ready_for_review" ? "claims_flagged" : "failed",
			})
		: false;
	// A finished review settles any earlier check error.
	await deps.repo.setCheckError(userId, app.applicationId, null);
	deps.log?.("application reviewed", {
		applicationId: app.applicationId,
		provider,
		passed,
		atsIssues: atsIssues.length,
	});
	return { outcome: "reviewed", passed, reviewId };
}

interface Checked {
	provider: string;
	issues: RuleIssue[];
	claims: CheckedClaim[];
	flags: ReviewFlag[];
	segments: CheckedSegment[];
}

const segmentsOf = (input: ClaimsInput): CheckedSegment[] =>
	segmentDocuments(input).map((s) => ({
		document: s.document,
		text: s.text,
		context: s.context,
		occurrence: s.occurrence,
	}));

/** The whole documents: the independent claims check and every fixed rule. */
async function checkAll(
	deps: PipelineDeps,
	userId: string,
	applicationId: string,
	input: ClaimsInput,
): Promise<Checked> {
	const llm = deps.claimsLlm;
	if (!llm) throw new Error("No claims-check model configured (claimsLlm)");
	const report = await checkClaims(
		meteredFor(llm, deps.spend, userId, applicationId),
		input,
	);
	return {
		provider: report.provider,
		issues: report.issues,
		claims: report.claims,
		flags: buildFlags(report.issues, [], segmentsOf(input)),
		segments: segmentsOf(input),
	};
}

/**
 * An edited version in review: fixed rules on the whole documents, and the claims check only on
 * segments that are new since `base` (none for a deletion). A segment is its text in its place:
 * a line moved under another employer or paragraph, or under an edited heading, counts as new
 * and is checked again, with the whole documents as context. Unchanged segments keep their
 * result: a flag stays (confirmed if it was), a line that passed stays passed. No re-tailoring.
 */
async function recheckChanged(
	deps: PipelineDeps,
	userId: string,
	applicationId: string,
	input: ClaimsInput,
	base: StoredReview,
): Promise<Checked> {
	const segments = segmentsOf(input);
	const before = new Set((base.segments ?? []).map(segmentKey));
	const now = new Set(segments.map(segmentKey));
	const changed = segmentDocuments(input).filter(
		(s) => !before.has(segmentKey(s)),
	);
	let provider = base.provider;
	let fresh: RuleIssue[] = [];
	let claims: CheckedClaim[] = [];
	if (changed.length > 0) {
		const llm = deps.claimsLlm;
		if (!llm) throw new Error("No claims-check model configured (claimsLlm)");
		const report = await checkClaims(
			meteredFor(llm, deps.spend, userId, applicationId),
			focusedInput(input, changed),
		);
		provider = report.provider;
		fresh = report.issues.filter((i) => MODEL_RULES.includes(i.rule));
		claims = report.claims;
	}
	// A flag on a segment that is gone (deleted, moved, its heading edited) was cleared by the
	// edit; a flag not tied to a checked segment stays.
	const carried = (base.flags ?? [])
		.filter(
			(f) => f.text === null || now.has(flagKey(f)) || !before.has(flagKey(f)),
		)
		.flatMap(modelIssues);
	const kept = (base.claims as CheckedClaim[]).filter((c) =>
		c.segmentKeys?.every((key) => now.has(key)),
	);
	const issues = [...carried, ...fresh, ...checkRulesOnly(input)];
	return {
		provider,
		issues,
		claims: [...kept, ...claims],
		flags: buildFlags(issues, base.flags, segments),
		segments,
	};
}

/**
 * The check of an edited version in review kept failing after its retries, or could not run
 * under the spending cap: the error is kept with the version's hashes, so the dashboard shows it
 * instead of "Checking…" and offers a retry. Approval stays blocked: no review passed.
 */
export async function checkErrorStep(
	deps: PipelineDeps,
	userId: string,
	jobId: string,
	message: string,
): Promise<void> {
	const app = await load(deps, userId, jobId);
	const docs = await deps.repo.latestDocuments(userId, app.applicationId);
	await deps.repo.setCheckError(userId, app.applicationId, {
		hashes: await hashDocuments(docs, postingOf(app)),
		message: message.slice(0, 500),
		at: (deps.now?.() ?? new Date()).toISOString(),
	});
}

/** preparing -> ready_for_review once the current draft passed review. */
export async function markReadyStep(
	deps: PipelineDeps,
	userId: string,
	jobId: string,
): Promise<boolean> {
	const app = await load(deps, userId, jobId);
	await deps.repo.setPrepareAttempts(userId, app.applicationId, 0);
	return deps.repo.transition(userId, app.applicationId, {
		from: ["preparing"],
		to: "ready_for_review",
		reason: "Documents drafted and passed the claims, rules and ATS checks",
		actor: "workflow",
	});
}

export type BlockedOutcome =
	| { outcome: "redraft"; attempts: number }
	| { outcome: "flagged"; open: number }
	| { outcome: "failed"; reason: string };

/**
 * A draft failed review. The first failure redrafts once with the problems as feedback. After the
 * second, the draft goes to review with its flags (`claims_flagged`): the user edits, deletes or
 * confirms each flagged line, and approval waits until none is open. `failed` is left for real
 * errors (no documents to review, a provider or export that keeps failing).
 */
export async function blockedStep(
	deps: PipelineDeps,
	userId: string,
	jobId: string,
): Promise<BlockedOutcome> {
	const app = await load(deps, userId, jobId);
	const attempts = app.prepareAttempts + 1;
	await deps.repo.setPrepareAttempts(userId, app.applicationId, attempts);
	if (attempts < MAX_DRAFTS) return { outcome: "redraft", attempts };
	const review = await deps.repo.latestReview(userId, app.applicationId);
	if (!review) {
		const reason = "The draft has no CV or cover letter to review";
		await deps.repo.transition(userId, app.applicationId, {
			from: ["preparing"],
			to: "failed",
			reason,
			actor: "workflow",
		});
		return { outcome: "failed", reason };
	}
	const flags = review.flags?.length ? review.flags : buildFlags(review.issues);
	await deps.repo.flagReview(userId, review.id, flags);
	const open = openFlags(flags).length;
	await deps.repo.transition(userId, app.applicationId, {
		from: ["preparing"],
		to: "ready_for_review",
		reason: `The claims check still flags ${open} line(s) after ${attempts} drafts; review each before approving`,
		actor: "workflow",
	});
	return { outcome: "flagged", open };
}

/** A preparation step that kept failing after its retries: a real error, so the application fails. */
export async function failPreparationStep(
	deps: PipelineDeps,
	userId: string,
	jobId: string,
	message: string,
): Promise<boolean> {
	const app = await load(deps, userId, jobId);
	return deps.repo.transition(userId, app.applicationId, {
		from: ["preparing"],
		to: "failed",
		reason: `Preparation stopped on an error after retries: ${message.slice(0, 300)}`,
		actor: "workflow",
	});
}

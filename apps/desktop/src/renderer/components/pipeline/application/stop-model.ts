/**
 * The stop sheet's content (docs/auto-apply-plan.md, step 7): why an automatic submission
 * stopped, in plain words, and the actions that fit that stop. No imports from the app:
 * unit-tested in node. The reasons are read from the attempt's `proof.stop` kind where the run
 * recorded one, else from the reason it stored (the sentences in core apply/submit.ts and
 * apply/applier.ts).
 */

type StopCase =
	| "unknown_outcome"
	| "challenge"
	| "account_wall"
	| "verification_code"
	| "form_changed"
	| "question"
	| "location_choice"
	| "other_host"
	| "host_not_allowed"
	| "paused"
	| "validation"
	| "interrupted"
	| "not_automatic"
	| "other";

/**
 * `finish`: Finish it yourself. `answer`: Answer and retry (Questions). `reread`: Read the form
 * again. `mark`: I submitted this. `retry`: Retry, nothing was clicked. `retry_confirmed`: Retry,
 * only after the user confirms an unknown outcome did not go through.
 */
export type StopAction =
	| "finish"
	| "answer"
	| "reread"
	| "mark"
	| "retry"
	| "retry_confirmed";

export interface StopAttempt {
	id: string;
	attempt: number;
	status: string;
	mode: string;
	board: string | null;
	url: string | null;
	error: string | null;
	proof: Record<string, unknown> | null;
	startedAt: Date | string;
}

interface StopQuestion {
	id: string;
	status: string;
	formField?: { label: string; board: string; options?: string[] } | null;
}

export interface StopApp<A extends StopAttempt = StopAttempt> {
	state: string;
	attempts: A[];
	unresolvedAttempt: { attempt: number } | null;
	questions: StopQuestion[];
	submissionsPaused?: boolean;
}

export interface StopView<A extends StopAttempt = StopAttempt> {
	case: StopCase;
	title: string;
	/** What happened and what it means, in plain words. */
	body: string;
	/** The run's own words, shown under the explanation. */
	reason: string | null;
	/** The attempt the stop is about. */
	attempt: A | null;
	/** The first open question of the form, for Answer and retry. */
	question: StopQuestion | null;
	/** In order: the first is the main action. */
	actions: StopAction[];
	/** Under the actions: what an action does that its label cannot say. */
	note: string | null;
}

/** Kinds `submit.ts` and the runs record in `proof.stop`, mapped to the sheet's cases. */
const KIND_CASE: Record<string, StopCase> = {
	challenge: "challenge",
	account_wall: "account_wall",
	verification_code: "verification_code",
	form_changed: "form_changed",
	unknown_questions: "question",
	other_site: "other_host",
	host_not_allowed: "host_not_allowed",
	paused: "paused",
	validation: "validation",
};

/** The stored reason's sentences, for stops whose proof names no kind. */
const REASON_CASE: [RegExp, StopCase][] = [
	[/is not turned on \(SUBMIT_ALLOWED_HOSTS\)/, "host_not_allowed"],
	[/Submissions were paused before/, "paused"],
	[/which is not an allowed host/, "other_host"],
	[/ended before it was cleared to submit/, "interrupted"],
	[
		/no automatic form filling|apply by hand|apply on the employer's site yourself|hand-off/i,
		"not_automatic",
	],
	[
		/required question\(s\) have no approved answer|need your answer/,
		"question",
	],
	[/which review did not list|not read before review/, "form_changed"],
	[/CAPTCHA|challenge|security check|blocked/i, "challenge"],
	[/sign in|password|account/i, "account_wall"],
	[/code sent|verification code|one-time code/i, "verification_code"],
	[/shows errors before submitting/, "validation"],
];

function caseOf(attempt: StopAttempt | null): StopCase {
	const kind = attempt?.proof?.stop;
	const known = typeof kind === "string" ? KIND_CASE[kind] : undefined;
	if (known) return known;
	const reason = attempt?.error ?? "";
	return REASON_CASE.find(([re]) => re.test(reason))?.[1] ?? "other";
}

/** Lever offers its own place names; the run stops when none is exactly the reviewed text. */
function isLocationChoice(q: StopQuestion | null): boolean {
	const field = q?.formField;
	return Boolean(
		field &&
			field.board === "lever" &&
			/location/i.test(field.label) &&
			(field.options?.length ?? 0) > 0,
	);
}

const COPY: Record<
	StopCase,
	{ title: string; body: string; actions: StopAction[]; note?: string }
> = {
	unknown_outcome: {
		title: "Outcome unknown",
		body: "The submit button was clicked once, but no confirmation came back, so it may or may not have gone through. It is never clicked again on its own. Check your email or the employer's portal.",
		actions: ["mark", "finish", "retry_confirmed"],
		note: "Retry opens only after you confirm it did not go through.",
	},
	challenge: {
		title: "The site asked for a human check",
		body: "The form showed a CAPTCHA or security check. OfferFinch never solves or hides from those, so it stopped before anything was sent.",
		actions: ["finish", "mark", "retry"],
		note: "Retry opens the form again; it stops again if the check is still there.",
	},
	account_wall: {
		title: "The form wants you to sign in",
		body: "The page asked for a password or an account before its form. No passwords are stored, so it stopped before anything was sent.",
		actions: ["finish", "mark"],
	},
	verification_code: {
		title: "The form asked for an emailed code",
		body: "The page asked for a code sent to your email or phone. Only you can read it, so it stopped before anything was sent.",
		actions: ["finish", "mark"],
	},
	form_changed: {
		title: "The form changed since review",
		body: "The live form asks something that was not in the list you approved. Nothing on it is answered on the fly, so it stopped before anything was sent. Read the form again to get a new list to review.",
		actions: ["reread", "finish", "mark"],
		note: "Read the form again opens it read-only, lists every field again and sends the application back to review. Nothing is sent.",
	},
	question: {
		title: "The form asks something new",
		body: "A required question on the form has no approved answer, so it stopped before anything was sent. Answer it in Questions.",
		actions: ["answer", "finish", "mark"],
		note: "Your answer goes back through review; approve it again to send.",
	},
	location_choice: {
		title: "Pick Lever's name for your location",
		body: "Lever only accepts a place from its own list, and none of its suggestions matched your location exactly, so it stopped before anything was sent. Choose one of its suggestions in Questions.",
		actions: ["answer", "finish", "mark"],
		note: "Your choice goes back through review; approve it again to send.",
	},
	other_host: {
		title: "The form tried to send data to another site",
		body: "The page tried to upload or send your details to a site outside the form's own. That is refused, so it stopped before anything was sent.",
		actions: ["finish", "mark"],
	},
	host_not_allowed: {
		title: "Automatic submission is not turned on for this site yet",
		body: "Real job sites are not on the submission list yet, so no browser was opened and nothing was sent. Send it yourself with your answers below.",
		actions: ["finish", "mark"],
	},
	paused: {
		title: "Submissions were paused",
		body: "Submissions were paused before the click, so nothing was sent. Retry once they are on again, or send it yourself.",
		actions: ["finish", "mark", "retry"],
	},
	validation: {
		title: "The form showed an error",
		body: "The form showed errors before submitting, so the button was never clicked and nothing was sent.",
		actions: ["finish", "mark", "retry"],
	},
	interrupted: {
		title: "The run stopped before the click",
		body: "The submission run ended before it was cleared to submit, so nothing was sent.",
		actions: ["retry", "finish", "mark"],
	},
	not_automatic: {
		title: "This form is filled by you",
		body: "This site is not filled automatically, so nothing was sent. Send it yourself with your answers below.",
		actions: ["finish", "mark"],
	},
	other: {
		title: "The submission stopped",
		body: "Something on the page did not match what was reviewed, so it stopped before the click and nothing was sent.",
		actions: ["finish", "mark", "retry"],
	},
};

/** What the sheet shows for an application that needs the user after a stop; null otherwise. */
export function stopView<A extends StopAttempt>(
	app: StopApp<A>,
): StopView<A> | null {
	if (app.state !== "needs_human") return null;
	const open =
		app.questions.find((q) => q.status === "open" && q.formField) ?? null;
	// A clicked attempt whose outcome is unknown decides, whatever stopped after it.
	const unknown = app.unresolvedAttempt
		? (app.attempts.find((a) => a.attempt === app.unresolvedAttempt?.attempt) ??
			null)
		: null;
	const stop =
		unknown ??
		app.attempts.find((a) => a.status === "not_sent" && a.mode === "auto") ??
		null;
	let kind: StopCase = unknown ? "unknown_outcome" : caseOf(stop);
	if (!unknown && (open || kind === "question"))
		kind = isLocationChoice(open) ? "location_choice" : "question";
	const copy = COPY[kind];
	// Answering needs a question to go to; retrying while paused stops again.
	const actions = copy.actions.filter(
		(a) =>
			(a !== "answer" || open !== null) &&
			(kind !== "paused" || a !== "retry" || app.submissionsPaused === false),
	);
	return {
		case: kind,
		title: copy.title,
		body: copy.body,
		reason: stop?.error ?? null,
		attempt: stop,
		question: open,
		actions,
		note: copy.note ?? null,
	};
}

/**
 * How a finished attempt reads in the proof. Never says the employer received it: a board's
 * confirmation page is not proof of receipt (docs/auto-apply-plan.md, "Known risk").
 */
export function outcomeLabel(attempt: {
	status: string;
	board: string | null;
}): string {
	if (attempt.status === "submitted")
		return attempt.board === "web"
			? "Submitted (the employer's page confirmed)"
			: "Submitted (board confirmed)";
	if (attempt.status === "needs_human" || attempt.status === "started")
		return "Outcome unknown: check your email or the employer's portal";
	if (attempt.status === "not_sent") return "Not sent";
	if (attempt.status === "dry_run") return "Dry run, not sent";
	return attempt.status;
}

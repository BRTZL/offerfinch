/**
 * The stop sheet's content (docs/auto-apply-plan.md, step 7): why an automatic submission
 * stopped, in plain words, and the actions that fit that stop. No imports from the app:
 * unit-tested in node. The reasons are read from the attempt's `proof.stop` kind where the run
 * recorded one, else from the reason it stored (the sentences in core apply/submit.ts and
 * apply/applier.ts).
 */

type StopCase =
	| "web_sent"
	| "confirmed_not_sent"
	| "unknown_outcome"
	| "unknown_error_answer"
	| "unknown_refused"
	| "unknown_redirected"
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
	| "sends_elsewhere"
	| "link_moves"
	| "unlabelled"
	| "no_submit"
	| "other";

/**
 * `finish`: Finish it yourself. `answer`: Answer and retry (Questions). `reread`: Read the form
 * again. `mark`: I submitted this. `retry`: Retry, nothing was clicked. `retry_confirmed`: Retry,
 * only after the user confirms an unknown outcome did not go through. `got_email`: Got the email
 * (an employer's form that was sent; the I submitted this path). `finish_confirmed`: Finish it
 * yourself, only after the user confirms it did not go through.
 */
export type StopAction =
	| "got_email"
	| "finish"
	| "finish_confirmed"
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
	/** How the user resolved it ("The user confirmed it did not go through"), if they did. */
	resolution?: string | null;
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
	[/(?:isn't|aren't) opened in Settings › Applying/, "host_not_allowed"],
	// Attempts stored before real sites could be opened (plan step 8) carry the old sentence.
	[/is not turned on( \(SUBMIT_ALLOWED_HOSTS\))?\./, "host_not_allowed"],
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

/**
 * An employer's form that is the user's to finish (core apply/web-form.ts, 2026-11-09 re-review):
 * read before the kind, which is only `other_site` or `form_changed` for these, and where Read the
 * form again or Retry would end the same way.
 */
const HANDOFF_CASE: [RegExp, StopCase][] = [
	[/this form sends to \S+; finish it yourself/i, "sends_elsewhere"],
	[/The job link moves to \S+; finish it yourself/, "link_moves"],
	[/unlabelled fields|share one name or label/, "unlabelled"],
	[
		/no submit button of its own|Could not tell which control sends the application/,
		"no_submit",
	],
];

/** The resolution db `confirmNotSent` and a confirmed Retry store on the attempt. */
const CONFIRMED_NOT_SENT = "The user confirmed it did not go through";

/** An unknown outcome whose application request the employer's site answered with an error. */
const ERROR_ANSWER = /answered HTTP \d+ to the application/;

/**
 * An unknown outcome whose page or answer after the click reads as a refusal or an error (core
 * apply/web-form.ts `refusalAfter`, the outcome reader's error verdicts).
 */
const REFUSED =
	/so the application may not have gone through|employer's answer to the application says|The form showed errors after the click|The page after the click shows an error/;

/**
 * An unknown outcome whose application the employer's site redirected to another site, which the
 * run refused (core apply/applier.ts `redirectedElsewhere`).
 */
const REDIRECTED = /redirected the application to another site/;

/**
 * An unknown outcome: redirected to another site, an error answer to the application, refusal
 * wording, or no confirmation.
 */
function unknownCase(attempt: StopAttempt): StopCase {
	const reason = attempt.error ?? "";
	if (REDIRECTED.test(reason)) return "unknown_redirected";
	if (ERROR_ANSWER.test(reason)) return "unknown_error_answer";
	if (REFUSED.test(reason)) return "unknown_refused";
	return "unknown_outcome";
}

function caseOf(attempt: StopAttempt | null): StopCase {
	const handoff = HANDOFF_CASE.find(([re]) => re.test(attempt?.error ?? ""));
	if (handoff) return handoff[1];
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
	confirmed_not_sent: {
		title: "It didn't go through",
		body: "You said the application this attempt sent did not arrive. Finish it yourself with your answers below, or retry: the form is filled from what you approved and sent once more.",
		actions: ["finish", "mark", "retry"],
	},
	web_sent: {
		title: "Sent — check your email",
		body: "The employer's form was filled from what you approved and sent once. Its page cannot say for sure that it arrived, so the employer's email decides: when it comes, press Got the email. Nothing is sent again on its own.",
		actions: ["got_email", "finish_confirmed", "retry_confirmed"],
		note: "No email after a day or two? Tick It didn't go through, then Retry or Finish it yourself.",
	},
	unknown_outcome: {
		title: "Outcome unknown",
		body: 'A click that may have sent the application was made once (the submit button, or the first "Next" of a form in steps, which can already save answers), but no confirmation came back, so it may or may not have gone through. Nothing is clicked again on its own. Check your email or the employer\'s portal.',
		actions: ["mark", "finish_confirmed", "retry_confirmed"],
		note: "Retry or Finish it yourself opens only after you confirm it did not go through.",
	},
	unknown_error_answer: {
		title: "The employer's site answered with an error",
		body: "The application was sent once, and the employer's site answered it with an error, so it most likely did not go through, but that is not certain. Nothing is clicked again on its own. Check your email or the employer's portal.",
		actions: ["mark", "finish_confirmed", "retry_confirmed"],
		note: "Retry or Finish it yourself opens only after you confirm it did not go through.",
	},
	unknown_refused: {
		title: "The employer's site may have refused it",
		body: "The application was sent once, but the page or the employer's answer after the click shows an error or refusal wording, so it may not have gone through. Nothing is clicked again on its own. Check your email or the employer's portal.",
		actions: ["mark", "finish_confirmed", "retry_confirmed"],
		note: "Retry or Finish it yourself opens only after you confirm it did not go through.",
	},
	unknown_redirected: {
		title: "The employer's site sent it to another site",
		body: "The application was sent once to the employer's site, which answered by passing it on to another site. OfferFinch stopped there and sent nothing to that site, so it may not have gone through. Nothing is clicked again on its own. Check your email or the employer's portal.",
		actions: ["mark", "finish_confirmed", "retry_confirmed"],
		note: "Retry or Finish it yourself opens only after you confirm it did not go through.",
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
		title: "This job site isn't opened yet",
		body: "Real job sites stay closed until you open each one in Settings › Applying, so no browser was opened and nothing was sent. Open the site there, then Read the form again, or send it yourself with your answers below.",
		actions: ["reread", "finish", "mark", "retry"],
		note: "Read the form again lists the opened site's fields and sends the application back to review; nothing is sent. Retry sends it as approved, only if its form was read before review. While the site is closed, both stop here again.",
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
	link_moves: {
		title: "The job link leads to another site",
		body: "The job's link redirects to a page on another site than its own. The application only goes to the site the link names, so it is yours to finish, and nothing was sent. Finish it yourself with your answers below.",
		actions: ["finish", "mark"],
	},
	sends_elsewhere: {
		title: "This form sends to another site",
		body: "The form sends your answers somewhere other than the page it is on. Data only goes to the form's own page, so it is yours to finish, and nothing was sent. Finish it yourself with your answers below.",
		actions: ["finish", "mark"],
	},
	unlabelled: {
		title: "This form has unlabelled fields",
		body: "Some fields on the form have no name or label of their own, or share one, so they cannot be told apart. A value is never typed into a box by its place, so it is yours to finish, and nothing was sent. Finish it yourself with your answers below.",
		actions: ["finish", "mark"],
	},
	no_submit: {
		title: "This form has no submit button of its own",
		body: "Nothing on the form is known to send it (no submit button that belongs to the form), so nothing was clicked to send it and nothing was sent. Finish it yourself with your answers below.",
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
	let kind: StopCase = unknown ? unknownCase(unknown) : caseOf(stop);
	// A click the user said did not go through ("It didn't go through", before Finish it yourself).
	if (!unknown && stop?.resolution === CONFIRMED_NOT_SENT)
		kind = "confirmed_not_sent";
	if (unknown && isWebSent(unknown)) kind = "web_sent";
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

/** An employer's form that was sent and waits for the user's email (decision 2026-11-09). */
export function isWebSent(attempt: { proof: Record<string, unknown> | null }) {
	return attempt.proof?.outcome === "web_sent";
}

/** One line of what a run saw after sending an employer's form; `warn` is shown as a warning. */
export interface EvidenceLine {
	text: string;
	warn: boolean;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/**
 * What the run saw after sending an employer's form (`proof.evidence`), as lines for the proof.
 * Information only: it never decides whether the application arrived.
 */
export function evidenceLines(
	proof: Record<string, unknown> | null,
): EvidenceLine[] {
	const e = proof?.outcome === "web_sent" ? proof.evidence : null;
	if (!e || typeof e !== "object") return [];
	const evidence = e as Record<string, unknown>;
	const lines: EvidenceLine[] = [];
	const warning = str(evidence.warning);
	if (warning) lines.push({ text: warning, warn: true });
	const said = str(evidence.confirmation);
	if (said)
		lines.push({ text: `The employer's page showed: “${said}”`, warn: false });
	lines.push({
		text: evidence.requestSeen
			? "The application request was seen leaving for the employer's site."
			: "No application request was seen.",
		warn: false,
	});
	const note = str(evidence.note);
	if (note) lines.push({ text: note, warn: false });
	return lines;
}

/**
 * How a finished attempt reads in the proof. Never says the employer received it: a board's
 * confirmation page is not proof of receipt (docs/auto-apply-plan.md, "Known risk").
 */
export function outcomeLabel(attempt: {
	status: string;
	board: string | null;
	proof?: Record<string, unknown> | null;
	mode?: string;
}): string {
	if (attempt.mode === "manual")
		return attempt.status === "submitted" ? "Submitted by you" : attempt.status;
	if (attempt.proof?.outcome === "web_sent") {
		if (attempt.status === "submitted") return "Sent, and you got the email";
		if (attempt.status === "not_sent") return "Sent, but it didn't go through";
		return "Sent — check your email";
	}
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

import type { FormRead } from "./form-schema";
import { BOARDS, type Board, type FormBoard } from "./forms";

/**
 * How an approved application reaches the employer, per board (docs/decisions.md, 2026-11-09;
 * docs/auto-apply-plan.md).
 *
 * - "auto": the applier fills the hosted form from the approved documents and submits once,
 *   after the claim. Every stop (a visible challenge, an unknown field, an error) hands it to the
 *   user; nothing is retried after the click.
 * - "handoff": nothing is filled or submitted automatically. After approval the dashboard shows
 *   the posting's apply link, every answer ready to copy and the approved PDFs; the user submits
 *   and records it with "I submitted this".
 *
 * This table is the only switch: no setting, environment variable or dashboard action changes a
 * board's mode. `why` is the known risk on that board, shown beside its mode.
 */
export type SubmissionMode = "handoff" | "auto";

export const BOARD_SUBMISSION_MODES: Readonly<
	Record<Board, { mode: SubmissionMode; why: string }>
> = Object.freeze({
	ashby: {
		mode: "auto",
		why: "Ashby scores the browser invisibly at submit (reCAPTCHA Enterprise): a thank-you page is not proof the employer received it.",
	},
	greenhouse: {
		mode: "auto",
		why: "Greenhouse scores the browser invisibly at submit (reCAPTCHA Enterprise): a thank-you page is not proof the employer received it.",
	},
	lever: {
		mode: "auto",
		why: "Lever scores the browser invisibly at submit (hCaptcha and Cloudflare's bot script): a thank-you page is not proof the employer received it.",
	},
	workable: {
		mode: "auto",
		why: "Workable loads Cloudflare Turnstile on its form and decides at submit: a thank-you page is not proof the employer received it.",
	},
	recruitee: {
		mode: "auto",
		why: "Recruitee scores the browser invisibly at submit (its own hCaptcha): a thank-you page is not proof the employer received it.",
	},
	teamtailor: {
		mode: "auto",
		why: "Teamtailor showed no scoring widget, but its form carries verification tokens checked at submit: a thank-you page is not proof the employer received it.",
	},
	personio: {
		mode: "auto",
		why: "Personio scores the browser invisibly at submit (Cloudflare Turnstile): a thank-you page is not proof the employer received it.",
	},
});

export interface ModeDecision {
	mode: SubmissionMode;
	reason: string;
}

/**
 * An employer's own form, read by the generic scan (docs/auto-apply-plan.md, step 6). Its known
 * risk, shown beside its mode like a board's.
 */
export const WEB_SUBMISSION_MODE: Readonly<{
	mode: SubmissionMode;
	why: string;
}> = Object.freeze({
	mode: "auto",
	why: "An employer's own form is read by a generic scan, and its page after the click is read by the model: a thank-you page is not proof the employer received it.",
});

/**
 * Job sources that are hand-off unless the job's apply link names a form this app fills
 * (`form-target.ts`). A job added by hand (`manual`) and try-it samples never fill anything;
 * SmartRecruiters' application form answers an automated browser with a visible CAPTCHA
 * (docs/form-inspection.md, 2026-11-09). LinkedIn, Indeed and Glassdoor's own apply is never used
 * (docs/decisions.md, phase 4); their jobs that link out to an employer's form, and web and feed
 * jobs, are filled on that form. No option changes this.
 */
const NO_FORM =
	"no form this app can fill was found at its link. Nothing is filled or sent automatically.";

export const HANDOFF_SOURCES: Readonly<Record<string, string>> = Object.freeze({
	manual:
		"Added by hand: open the posting and submit it yourself. Nothing is filled or sent automatically.",
	linkedin:
		"Found on LinkedIn without an employer form this app can fill: open the employer's apply link (or the posting) and submit it yourself. Nothing is filled or sent automatically, and Easy Apply is never used.",
	indeed:
		"Found on Indeed without an employer form this app can fill: open the posting and apply yourself. Nothing is filled or sent automatically, and Indeed's own apply is never used.",
	glassdoor:
		"Found on Glassdoor without an employer form this app can fill: open the posting and apply yourself. Nothing is filled or sent automatically, and Glassdoor's own apply is never used.",
	smartrecruiters:
		"Found on SmartRecruiters: open the posting and apply on SmartRecruiters yourself. Nothing is filled or sent automatically: its application form shows an automated browser a CAPTCHA (DataDome) instead of the form.",
	web: `Found on the web: apply on the employer's site yourself; ${NO_FORM}`,
	remotive: `Found on Remotive: open the posting on Remotive and apply yourself; ${NO_FORM}`,
	remoteok: `Found on Remote OK: open the posting on Remote OK and apply yourself; ${NO_FORM}`,
	weworkremotely: `Found on We Work Remotely: open the posting on We Work Remotely and apply yourself; ${NO_FORM}`,
	hackernews: `Found in Hacker News' Who is hiring thread: apply the way the post asks, yourself; ${NO_FORM}`,
	sample:
		"A sample job from try-it mode: there is no real posting to apply to. Mark it applied to see the Applied list. Nothing is filled or sent.",
});

/** Hand-off sources whose jobs are filled where their apply link points, when it names a form. */
const LINKED_FORM_SOURCES = new Set([
	"linkedin",
	"indeed",
	"glassdoor",
	"web",
	"remotive",
	"remoteok",
	"weworkremotely",
	"hackernews",
]);

/**
 * The mode for an application from `source`: a hand-off source decides before its board does,
 * unless the board was read from the job's apply link (`from` "url", `form-target.ts`) and the
 * source is one that links out. `note` says why a followed link named no form.
 */
export function submissionModeForSource(
	source: string,
	board: FormBoard | null,
	from?: "source" | "url" | null,
	note = "",
): ModeDecision {
	const fixed = HANDOFF_SOURCES[source];
	const linked =
		from === "url" && board !== null && LINKED_FORM_SOURCES.has(source);
	if (fixed && !linked)
		return { mode: "handoff", reason: note ? `${note} ${fixed}` : fixed };
	const decision = submissionModeFor(board);
	return note && decision.mode === "handoff"
		? { ...decision, reason: `${note} ${decision.reason}` }
		: decision;
}

/** The mode for one application's board, from the table above. */
export function submissionModeFor(board: FormBoard | null): ModeDecision {
	if (board === "web") return { mode: WEB_SUBMISSION_MODE.mode, reason: "" };
	if (!board || !(BOARDS as readonly string[]).includes(board))
		return {
			mode: "handoff",
			reason:
				"This job board has no automatic form filling yet; submit it yourself.",
		};
	const fixed = BOARD_SUBMISSION_MODES[board];
	if (fixed.mode === "auto") return { mode: "auto", reason: "" };
	return {
		mode: "handoff",
		reason: `Submit this one yourself: ${fixed.why} Nothing is filled or sent automatically on this board.`,
	};
}

/**
 * An employer's own form is filled only from the field list read before review: without a read
 * one, it is a hand-off, with the read's note. Boards are unchanged (they fill without one).
 */
export function submissionModeAfterRead(
	mode: ModeDecision,
	board: FormBoard | null,
	read: FormRead | null,
): ModeDecision {
	if (board !== "web" || mode.mode !== "auto" || read?.status === "read")
		return mode;
	const note =
		read?.status === "failed" || read?.status === "skipped"
			? read.note
			: "The employer's form has not been read.";
	return {
		mode: "handoff",
		reason: `${note} Apply on the employer's site yourself; nothing is filled or sent automatically.`,
	};
}

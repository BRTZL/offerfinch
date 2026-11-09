import { BOARDS, type Board } from "./forms";

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
 * Job sources that are hand-off whatever the board or host; a hand-off source decides before its
 * board does. A job added by hand (`manual`) names no board to submit on. LinkedIn jobs are read by
 * the local runner only: Easy Apply and LinkedIn's apply controls are never used (docs/decisions.md,
 * phase 4). Indeed and Glassdoor's own apply sit behind challenges and logins and stay hand-off.
 * SmartRecruiters' application form answers an automated browser with a visible CAPTCHA
 * (docs/form-inspection.md, 2026-11-09). The web and the feeds have no form filler yet
 * (docs/auto-apply-plan.md, step 6): until theirs lands they are hand-off too. No option changes
 * this.
 */
const NOT_YET =
	"Nothing is filled or sent automatically: automatic filling is not available here yet.";

export const HANDOFF_SOURCES: Readonly<Record<string, string>> = Object.freeze({
	manual:
		"Added by hand: open the posting and submit it yourself. Nothing is filled or sent automatically.",
	linkedin:
		"Found on LinkedIn: open the employer's apply link (or the posting) and submit it yourself. Nothing is filled or sent automatically, and Easy Apply is never used.",
	indeed:
		"Found on Indeed: open the posting and apply yourself. Nothing is filled or sent automatically, and Indeed's own apply is never used.",
	glassdoor:
		"Found on Glassdoor: open the posting and apply yourself. Nothing is filled or sent automatically, and Glassdoor's own apply is never used.",
	smartrecruiters:
		"Found on SmartRecruiters: open the posting and apply on SmartRecruiters yourself. Nothing is filled or sent automatically: its application form shows an automated browser a CAPTCHA (DataDome) instead of the form.",
	web: `Found on the web: open the posting and apply on the employer's site yourself. ${NOT_YET}`,
	remotive: `Found on Remotive: open the posting on Remotive and apply yourself. ${NOT_YET}`,
	remoteok: `Found on Remote OK: open the posting on Remote OK and apply yourself. ${NOT_YET}`,
	weworkremotely: `Found on We Work Remotely: open the posting on We Work Remotely and apply yourself. ${NOT_YET}`,
	hackernews: `Found in Hacker News' Who is hiring thread: open the post and apply the way it asks, yourself. ${NOT_YET}`,
	sample:
		"A sample job from try-it mode: there is no real posting to apply to. Mark it applied to see the Applied list. Nothing is filled or sent.",
});

/** The mode for an application from `source`: a hand-off source decides before its board does. */
export function submissionModeForSource(
	source: string,
	board: Board | null,
): ModeDecision {
	const fixed = HANDOFF_SOURCES[source];
	if (fixed) return { mode: "handoff", reason: fixed };
	return submissionModeFor(board);
}

/** The mode for one application's board, from the table above. */
export function submissionModeFor(board: Board | null): ModeDecision {
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

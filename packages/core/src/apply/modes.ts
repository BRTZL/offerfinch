import { BOARDS, type Board } from "./forms";

/**
 * How an approved application reaches the employer, per board (docs/decisions.md, 2026-10-31).
 *
 * - "handoff": nothing is filled or submitted automatically. After approval the dashboard shows
 *   the posting's apply link, every answer ready to copy and the approved PDFs; the user submits
 *   and records it with "I submitted this".
 * - "auto": the applier fills the hosted form and submits once, after the claim.
 *
 * Ashby, Greenhouse and Lever score browsers invisibly at submit time, and the user chose never
 * to auto-fill or auto-submit there. Their mode is fixed here on purpose: no setting, environment
 * variable or dashboard action can change it; turning one to "auto" is a code change to this table.
 */
export type SubmissionMode = "handoff" | "auto";

export const BOARD_SUBMISSION_MODES: Readonly<
	Record<Board, { mode: SubmissionMode; why: string }>
> = Object.freeze({
	ashby: {
		mode: "handoff",
		why: "Ashby scores the browser invisibly at submit (reCAPTCHA Enterprise).",
	},
	greenhouse: {
		mode: "handoff",
		why: "Greenhouse scores the browser invisibly at submit (reCAPTCHA Enterprise).",
	},
	lever: {
		mode: "handoff",
		why: "Lever scores the browser invisibly at submit (hCaptcha and Cloudflare's bot script).",
	},
});

/** Hosts of the local fixture boards. Only these can run the applier for a hand-off board. */
const FIXTURE_HOSTS = ["127.0.0.1", "localhost"];

export interface ModeOptions {
	/**
	 * Lets the applier run against the local fixture boards (127.0.0.1/localhost stand-ins for the
	 * three boards) so its tests keep covering it. Set only in test code; never read from the
	 * environment, and ignored for any other host.
	 */
	autoSubmitFixtures?: boolean;
}

export interface ModeDecision {
	mode: SubmissionMode;
	reason: string;
}

/**
 * Job sources that are hand-off whatever the board or host. A job added by hand (`manual`) names
 * no board to submit on. LinkedIn jobs are read by the local
 * runner only. Easy Apply and LinkedIn's apply controls are never used, and nothing is filled on
 * the employer's site either (docs/decisions.md, phase 4). No option changes this.
 */
export const HANDOFF_SOURCES: Readonly<Record<string, string>> = Object.freeze({
	manual:
		"Added by hand: open the posting and submit it yourself. Nothing is filled or sent automatically.",
	linkedin:
		"Found on LinkedIn: open the employer's apply link (or the posting) and submit it yourself. Nothing is filled or sent automatically, and Easy Apply is never used.",
	indeed:
		"Found on Indeed: open the posting and apply yourself. Nothing is filled or sent automatically, and Indeed's own apply is never used.",
	glassdoor:
		"Found on Glassdoor: open the posting and apply yourself. Nothing is filled or sent automatically, and Glassdoor's own apply is never used.",
	web: "Found on the web: open the posting and apply on the employer's site yourself. Nothing is filled or sent automatically.",
	remotive:
		"Found on Remotive: open the posting on Remotive and apply yourself. Nothing is filled or sent automatically.",
	remoteok:
		"Found on Remote OK: open the posting on Remote OK and apply yourself. Nothing is filled or sent automatically.",
	weworkremotely:
		"Found on We Work Remotely: open the posting on We Work Remotely and apply yourself. Nothing is filled or sent automatically.",
	hackernews:
		"Found in Hacker News' Who is hiring thread: open the post and apply the way it asks, yourself. Nothing is filled or sent automatically.",
});

/** The mode for an application from `source`: a hand-off source decides before its board does. */
export function submissionModeForSource(
	source: string,
	board: Board | null,
	formUrl: string | null,
	options: ModeOptions = {},
): ModeDecision {
	const fixed = HANDOFF_SOURCES[source];
	if (fixed) return { mode: "handoff", reason: fixed };
	return submissionModeFor(board, formUrl, options);
}

/** The mode for one application: its board and the form URL the applier would open. */
export function submissionModeFor(
	board: Board | null,
	formUrl: string | null,
	options: ModeOptions = {},
): ModeDecision {
	if (!board || !(BOARDS as readonly string[]).includes(board))
		return {
			mode: "handoff",
			reason:
				"This job board has no automatic form filling; submit it yourself.",
		};
	const fixed = BOARD_SUBMISSION_MODES[board];
	if (fixed.mode === "auto") return { mode: "auto", reason: "" };
	let host = "";
	try {
		host = formUrl ? new URL(formUrl).hostname : "";
	} catch {
		host = "";
	}
	if (options.autoSubmitFixtures === true && FIXTURE_HOSTS.includes(host))
		return { mode: "auto", reason: "" };
	return {
		mode: "handoff",
		reason: `Submit this one yourself: ${fixed.why} Nothing is filled or sent automatically on this board.`,
	};
}

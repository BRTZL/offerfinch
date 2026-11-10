import {
	BOARDS,
	boardFormHost,
	boardShownHosts,
	type FormBoard,
} from "./forms";
import { webFormHost } from "./web-hosts";

/**
 * Real job sites, opened one by one in Settings › Applying (docs/auto-apply-plan.md, step 8;
 * `submission_boards`, none opened by default). A run may open a real form only on a board the
 * user opened, and only on that board's exact form host for this job: a fixed host, the
 * company's own subdomain (Recruitee, Teamtailor, Personio), or an employer's form's own host.
 * The local fixture hosts (127.0.0.1, localhost) stay allowed whatever is opened.
 */

/** Every board Settings lists, employers' own forms last. */
export const OPENABLE_BOARDS: readonly FormBoard[] = [...BOARDS, "web"];

export const BOARD_NAMES: Readonly<Record<FormBoard, string>> = {
	ashby: "Ashby",
	greenhouse: "Greenhouse",
	lever: "Lever",
	workable: "Workable",
	recruitee: "Recruitee",
	teamtailor: "Teamtailor",
	personio: "Personio",
	web: "Employers' own forms",
};

/**
 * What opening a board risks, from the live inspections (docs/form-inspection.md, 2026-11-09),
 * shown before it opens.
 */
export const BOARD_RISKS: Readonly<Record<FormBoard, readonly string[]>> = {
	ashby: [
		"Ashby scores the browser invisibly at submit (reCAPTCHA Enterprise): a confirmation page is not proof the employer received it.",
		"Where Ashby uploads your CV is not known yet: the first run will likely stop at the upload, with nothing submitted.",
		"Ashby saves each answer as it is typed, so the employer may receive your answers before the click.",
	],
	greenhouse: [
		"Greenhouse scores the browser invisibly at submit (reCAPTCHA Enterprise): a confirmation page is not proof the employer received it.",
	],
	lever: [
		"Lever scores the browser invisibly at submit (hCaptcha and Cloudflare's bot script): a confirmation page is not proof the employer received it.",
	],
	workable: [
		"Workable checks the browser with Cloudflare Turnstile, and its site key is not recorded yet: the first run will likely stop or end with an outcome you check yourself.",
	],
	recruitee: [
		"Recruitee scores the browser invisibly at submit (its own hCaptcha, key not recorded yet): the first run may end with an outcome you check yourself.",
	],
	teamtailor: [
		"Teamtailor's confirmation page is not known yet: a submission ends as an outcome you check yourself, never as applied.",
	],
	personio: [
		"Personio checks the browser with Cloudflare Turnstile, and its site key is not recorded yet: the first run will likely stop.",
		"Personio's confirmation page is not known yet: a submission ends as an outcome you check yourself, never as applied.",
	],
	web: [
		"An employer's form is read by a generic scan, and only the form's own site receives your answers.",
		"It ends as Sent — check your email, never as applied: you move it to Applied when the employer's email arrives.",
	],
};

/** The hosts Settings shows a board opens. */
export function shownHosts(board: FormBoard): string[] {
	return board === "web"
		? ["the form's own site only"]
		: boardShownHosts(board);
}

/**
 * The form hosts this run may open: the always-allowed `base` (the local fixture hosts), plus,
 * when the user opened this run's board, that board's exact form host for this job, or for an
 * employer's form the exact host of `url` (its page). Only this run's board: never the union of
 * every opened board.
 */
export function runFormHosts(
	base: readonly string[],
	context: {
		board: FormBoard | null;
		boardOpened?: boolean;
		companyKey: string;
	},
	url: string,
): string[] {
	const { board } = context;
	if (!board || !context.boardOpened) return [...base];
	const host =
		board === "web"
			? webFormHost(url)
			: boardFormHost(board, context.companyKey);
	return host ? [...new Set([...base, host])] : [...base];
}

/** Why a run on a board the user has not opened stops, before any browser opens. */
export function boardClosedReason(board: FormBoard): string {
	return board === "web"
		? "Employers' own forms aren't opened in Settings › Applying."
		: `${BOARD_NAMES[board]} isn't opened in Settings › Applying.`;
}

import { JOB_SOURCES, type JobSourceKind } from "./types";

/** Hosts a board's postings live on; a job labelled with that board must be on one of them. */
const BOARD_HOSTS: Readonly<Record<string, { label: string; host: RegExp }>> =
	Object.freeze({
		ashby: { label: "Ashby", host: /(?:^|\.)ashbyhq\.com$/i },
		greenhouse: { label: "Greenhouse", host: /(?:^|\.)greenhouse\.io$/i },
		lever: { label: "Lever", host: /(?:^|\.)lever\.co$/i },
		linkedin: { label: "LinkedIn", host: /(?:^|\.)linkedin\.com$/i },
	});

/**
 * A source given on the command line. None given: `manual`, the neutral label for a posting added
 * by hand, which makes no claim about the board it came from.
 */
export function parseJobSource(value: string | undefined): JobSourceKind {
	if (value === undefined || value === "") return "manual";
	const found = JOB_SOURCES.find((s) => s === value);
	if (!found)
		throw new Error(
			`Unknown source "${value}": use one of ${JOB_SOURCES.join(", ")}`,
		);
	return found;
}

/**
 * Null when the label fits the posting's URL; otherwise what is wrong, in words. Only board
 * labels say where a posting lives: `scrape` (a careers page) and `manual` fit any URL.
 */
export function sourceMismatch(source: string, url: string): string | null {
	const board = BOARD_HOSTS[source];
	if (!board) return null;
	let host = "";
	try {
		host = new URL(url).hostname;
	} catch {
		return `Labelled ${board.label}, but the posting URL cannot be read.`;
	}
	return board.host.test(host)
		? null
		: `Labelled ${board.label}, but the posting URL (${host}) is not on ${board.label}.`;
}

import type { ProviderId } from "@offerfinch/db";

/**
 * Each source's name as Settings › Sources and the scan history show it: one list, so a source
 * added to Sources is named in the history too (an off feed once showed its raw id there).
 */
export const PROVIDER_LABEL: Record<ProviderId, string> = {
	"job-board-search": "Job-board search",
	linkedin: "LinkedIn",
	indeed: "Indeed",
	glassdoor: "Glassdoor",
	remotive: "Remotive",
	remoteok: "Remote OK",
	weworkremotely: "We Work Remotely",
	"hn-hiring": "HN Who is hiring",
	"web-search": "Web search",
};

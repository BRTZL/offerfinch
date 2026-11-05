import { z } from "zod";
import { canonicalCountries, canonicalCountry } from "./home";

/** Country names, stored as the gazetteer's names: "Turkey" and "turkiye" both become "Türkiye". */
const countryList = z
	.array(z.string())
	.default([])
	.transform(canonicalCountries);

/** A list of short words the user typed ("Fintech", "Startup"), trimmed, blanks dropped. */
const wordList = z
	.array(z.string())
	.default([])
	.transform((v) => v.map((w) => w.trim()).filter(Boolean));

/**
 * Editable per-user Job search settings. No rule rejects a job any more (docs/decisions.md,
 * 2026-11-05): the search plan reads where to look, and the fit score reads the rest as the
 * user's facts and preferences (`scoring/fit.ts`). The defaults name no country: the user says
 * where they can work in onboarding, so no one person's places are built in.
 */
export const filterSettingsSchema = z.object({
	/** The country the user lives in. Empty until the profile's location or the user sets it. */
	livesIn: z
		.string()
		.default("")
		.transform((v) => (v.trim() ? canonicalCountry(v) : "")),
	/** The user's citizenships. Empty: the country they live in. */
	citizenship: countryList,
	/** Countries where the user has the right to work. Anywhere else needs sponsorship. */
	rightToWork: countryList,
	/** Keep remote roles that hire from a right-to-work country. */
	keepRemoteFromHome: z.boolean().default(true),
	/** Keep remote roles open worldwide. */
	keepGlobalRemote: z.boolean().default(true),
	/** Keep hybrid and on-site roles in these countries, besides the right-to-work ones. */
	keepOnsiteIn: countryList,
	/**
	 * When true, on-site and hybrid roles abroad are kept, but only when the posting offers
	 * relocation or visa support.
	 */
	relocation: z.boolean().default(false),
	/** Countries the user would move to for a job. Empty: any. */
	relocationCountries: countryList,
	/**
	 * Set once the location fields were filled from the profile, so clearing them later does
	 * not fill them again.
	 */
	locationPrefilled: z.boolean().default(false),
	/** Languages the user can work in. The fit score caps a job that requires another one. */
	languages: z.array(z.string()).default(["English"]),
	/** Words for the roles the user targets; the fit score reads them. Empty: no preference. */
	roleKeywords: z
		.array(z.string())
		.default([
			"engineer",
			"developer",
			"software",
			"full stack",
			"full-stack",
			"fullstack",
			"frontend",
			"front-end",
			"front end",
			"backend",
			"back-end",
			"mobile",
			"react",
			"node",
			"typescript",
			"unity",
			"programmer",
			"sde",
		]),
	/**
	 * Job titles to search the internet for ("Senior Frontend Engineer"). Empty: the titles of
	 * the roles in the profile.
	 */
	searchTitles: z.array(z.string()).default([]),
	/**
	 * Title words for roles the user does not want ("intern"): the search plan avoids them and the
	 * fit score marks a job with one as a role mismatch.
	 */
	excludeTitleKeywords: z
		.array(z.string())
		.default(["intern", "internship", "working student", "apprentice"]),
	/** Target levels ("Senior", "Staff"); the fit score reads them. Empty: no preference. */
	seniority: wordList,
	/** Kinds of role wanted ("Individual contributor", "Full-time"). Empty: no preference. */
	wantedRoleTypes: wordList,
	/** Kinds of role not wanted ("People management", "Contract"). */
	unwantedRoleTypes: wordList,
	/** Lowest yearly salary the user takes; a job paying less (as stated) is capped. Null: none. */
	minSalary: z.number().int().min(0).nullable().default(null),
	/** Currency of `minSalary` ("EUR"). Empty: the posting's own. */
	salaryCurrency: z
		.string()
		.default("")
		.transform((v) => v.trim().toUpperCase()),
	/** Company sizes or stages the user prefers ("Startup", "Scale-up", "Enterprise"). */
	companySizes: wordList,
	/** Industries the user prefers ("Fintech", "Developer tools"). */
	preferredIndustries: wordList,
	/** Industries the user avoids ("Gambling", "Defense"). */
	avoidIndustries: wordList,
	/** Fit score (0-100) below which the application ends after scoring, with the reason saved. */
	minScore: z.number().min(0).max(100).default(50),
	/** No longer read: tailoring runs when the user presses Prepare. Kept so stored settings parse. */
	prepareMinScore: z.number().min(0).max(100).default(65),
	/** Fit score (0-100) at or above which the match notifier is called. */
	alertMinScore: z.number().min(0).max(100).default(75),
	/**
	 * Times tailoring may stop to ask the user questions, per application. After that, drafts leave
	 * unknown facts out and name them as gaps.
	 */
	questionRounds: z.number().int().min(0).max(3).default(1),
	/** Questions asked in one round at most; only must-have requirements and form questions. */
	maxQuestionsPerRound: z.number().int().min(1).max(5).default(3),
});

export type FilterSettings = z.infer<typeof filterSettingsSchema>;

export function parseFilterSettings(value: unknown): FilterSettings {
	return filterSettingsSchema.parse(value ?? {});
}

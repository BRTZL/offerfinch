import { z } from "zod";
import { canonicalCountries, canonicalCountry } from "./home";

/** Country names, stored as the gazetteer's names: "Türkiye" and "turkey" both become "Turkey". */
const countryList = z
	.array(z.string())
	.default([])
	.transform(canonicalCountries);

/**
 * Editable per-user filter settings. The defaults name no country: the user says where they can
 * work in onboarding (Job rules), so no one person's places are built in.
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
	/** Languages the user can work in. Roles requiring any other language are rejected. */
	languages: z.array(z.string()).default(["English"]),
	/** Title keywords for target roles (case-insensitive). Empty list disables the role rule. */
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
	/** Title keywords that always reject (case-insensitive). */
	excludeTitleKeywords: z
		.array(z.string())
		.default(["intern", "internship", "working student", "apprentice"]),
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

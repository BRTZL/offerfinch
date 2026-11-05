import type { ProfileSnapshot } from "../profile/types";
import { COUNTRIES, EU_MEMBERS } from "./countries";
import { countriesIn } from "./places";
import type { FilterSettings } from "./settings";

const BY_LOWER = new Map(COUNTRIES.map((c) => [c.toLowerCase(), c as string]));

/**
 * The filter's name for a country: "turkey", "Ankara" and "türkiye" all become "Türkiye". A name
 * the gazetteer does not know is kept as typed, so nothing the user wrote is lost.
 */
export function canonicalCountry(name: string): string {
	const trimmed = name.trim();
	const exact = BY_LOWER.get(trimmed.toLowerCase());
	if (exact) return exact;
	// Short codes only count in capitals in prose; a setting may be typed "usa" or "uk".
	const found = countriesIn(
		trimmed.length <= 5 ? trimmed.toUpperCase() : trimmed,
	);
	return found.length === 1 && found[0] ? found[0] : trimmed;
}

export function canonicalCountries(names: readonly string[]): string[] {
	return unique(names.map(canonicalCountry).filter(Boolean));
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

/** The profile's location line ("Izmir, Turkey (GMT+3)"), from the About record. */
export function profileLocation(
	profile: ProfileSnapshot | null,
): string | null {
	const personal = profile?.files.find((f) => f.path === "personal.md");
	const line = personal?.content.match(/^-\s+\*\*Location:\*\*\s+(.+)$/im)?.[1];
	return line?.trim() || null;
}

/** The country of the profile's location, or null when it names none the gazetteer knows. */
export function countryFromLocation(location: string | null): string | null {
	if (!location) return null;
	// "(GMT+3)" and other notes in brackets are not places.
	const found = countriesIn(location.replace(/\([^)]*\)/g, " "));
	return found.length > 0 ? (found[found.length - 1] ?? null) : null;
}

/**
 * Fills "I live in", citizenship and right to work from the profile's country, once. Fields the
 * user already set are kept; after the first fill (`locationPrefilled`) nothing is filled again.
 */
export function withLocationDefaults(
	settings: FilterSettings,
	country: string | null,
): FilterSettings {
	if (settings.locationPrefilled || !country) return settings;
	const livesIn = settings.livesIn || country;
	return {
		...settings,
		livesIn,
		citizenship:
			settings.citizenship.length > 0 ? settings.citizenship : [livesIn],
		rightToWork:
			settings.rightToWork.length > 0 ? settings.rightToWork : [livesIn],
		locationPrefilled: true,
	};
}

/** Where the user lives, holds citizenship and may work: the fit prompt's <work_rights>. */
export interface WorkContext {
	livesIn: string;
	citizenship: string[];
	/** Right to work: the settings' list, the home country and every citizenship's country. */
	rightToWork: string[];
}

export function workContext(settings: FilterSettings): WorkContext {
	const livesIn = settings.livesIn || settings.rightToWork[0] || "";
	const citizenship =
		settings.citizenship.length > 0
			? settings.citizenship
			: livesIn
				? [livesIn]
				: [];
	// An EU citizen may work in every member state.
	const eu = citizenship.some((c) => EU_MEMBERS.includes(c)) ? EU_MEMBERS : [];
	const rightToWork = unique(
		[livesIn, ...settings.rightToWork, ...citizenship, ...eu].filter(Boolean),
	);
	return { livesIn, citizenship, rightToWork };
}

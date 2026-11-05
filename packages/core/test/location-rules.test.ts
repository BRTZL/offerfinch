import { describe, expect, it } from "vitest";
import { COUNTRIES } from "../src/filter/countries";
import {
	canonicalCountries,
	countryFromLocation,
	profileLocation,
	withLocationDefaults,
	workContext,
} from "../src/filter/home";
import { countriesIn, countriesInLocation } from "../src/filter/places";
import { parseFilterSettings } from "../src/filter/settings";

/**
 * Countries and Job search settings. No rule rejects a job any more (docs/decisions.md,
 * 2026-11-05); the search plan and the fit prompt read these.
 */

describe("defaults", () => {
	it("name no country and only English, and no preference: the user says what they want", () => {
		const defaults = parseFilterSettings({});
		expect(defaults.rightToWork).toEqual([]);
		expect(defaults.keepOnsiteIn).toEqual([]);
		expect(defaults.languages).toEqual(["English"]);
		expect(defaults).toMatchObject({
			seniority: [],
			wantedRoleTypes: [],
			unwantedRoleTypes: [],
			minSalary: null,
			salaryCurrency: "",
			companySizes: [],
			preferredIndustries: [],
			avoidIndustries: [],
		});
	});

	it("parses settings stored before the preferences existed, and trims what the user typed", () => {
		const stored = parseFilterSettings({
			livesIn: "Türkiye",
			minScore: 60,
			prepareMinScore: 65,
		});
		expect(stored.minSalary).toBeNull();
		expect(stored.minScore).toBe(60);
		const typed = parseFilterSettings({
			seniority: [" Senior ", ""],
			salaryCurrency: " eur ",
			minSalary: 60000,
		});
		expect(typed.seniority).toEqual(["Senior"]);
		expect(typed.salaryCurrency).toBe("EUR");
		expect(typed.minSalary).toBe(60000);
	});
});

describe("settings: countries and the profile's location", () => {
	it("stores country names as the gazetteer's, keeping everything else", () => {
		const settings = parseFilterSettings({
			rightToWork: ["Türkiye", "istanbul", "turkey", "Atlantis"], // public-ok: a city in a location test
			keepOnsiteIn: ["Izmir"],
			minScore: 61,
			languages: ["English", "Turkish"],
		});
		expect(settings.rightToWork).toEqual(["Türkiye", "Atlantis"]);
		expect(settings.keepOnsiteIn).toEqual(["Türkiye"]);
		expect(settings.minScore).toBe(61);
		expect(settings.languages).toEqual(["English", "Turkish"]);
		expect(settings.livesIn).toBe("");
		expect(settings.relocationCountries).toEqual([]);
		expect(canonicalCountries(["usa", "U.S.", "United States"])).toEqual([
			"United States",
		]);
	});

	it("reads the country from the profile's About location", () => {
		const profile = {
			files: [
				{
					path: "personal.md",
					content:
						"# Personal\n\n- **Name:** Test Person\n- **Location:** Izmir, Turkey (GMT+3)\n",
				},
			],
		};
		expect(profileLocation(profile)).toBe("Izmir, Turkey (GMT+3)");
		expect(countryFromLocation(profileLocation(profile))).toBe("Türkiye");
		expect(countryFromLocation("İzmir")).toBe("Türkiye");
		expect(countryFromLocation("Berlin, Germany")).toBe("Germany");
		expect(countryFromLocation("Earth")).toBeNull();
		expect(profileLocation({ files: [] })).toBeNull();
	});

	it("fills I live in, citizenship and right to work once, keeping what the user set", () => {
		const filled = withLocationDefaults(parseFilterSettings({}), "Türkiye");
		expect(filled).toMatchObject({
			livesIn: "Türkiye",
			citizenship: ["Türkiye"],
			rightToWork: ["Türkiye"],
			locationPrefilled: true,
		});
		// An older right-to-work list stays.
		const kept = withLocationDefaults(
			parseFilterSettings({ rightToWork: ["Türkiye", "Germany"] }),
			"Türkiye",
		);
		expect(kept.rightToWork).toEqual(["Türkiye", "Germany"]);
		// Cleared after the first fill: not filled again.
		const cleared = parseFilterSettings({ ...filled, livesIn: "" });
		expect(withLocationDefaults(cleared, "Türkiye").livesIn).toBe("");
	});

	it("derives right to work from citizenship, the EU included", () => {
		const ctx = workContext(
			parseFilterSettings({ livesIn: "Türkiye", citizenship: ["Germany"] }),
		);
		expect(ctx.rightToWork).toContain("Türkiye");
		expect(ctx.rightToWork).toContain("France");
	});

	it("knows every country the pickers offer", () => {
		for (const country of COUNTRIES)
			expect(countriesIn(country), country).toContain(country);
	});

	it("reads US state codes in locations, not other countries' codes", () => {
		expect(countriesInLocation("Owego, NY")).toEqual(["United States"]);
		expect(countriesInLocation("Berlin, DE")).toEqual(["Germany"]);
		expect(countriesInLocation("Pune, IN")).toEqual(["India"]);
		expect(countriesInLocation("Toronto, ON, CA")).toEqual(["Canada"]);
		expect(countriesInLocation("Baku, AZ")).toEqual(["Azerbaijan"]);
		expect(countriesIn("Latin America")).toEqual([]);
		expect(countriesIn("Atlanta, Georgia")).toEqual(["United States"]);
		expect(countriesIn("Tbilisi, Georgia")).toEqual(["Georgia"]);
	});
});

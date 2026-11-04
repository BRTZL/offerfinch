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
import {
	evaluateHardRequirements,
	type FilterInput,
	relocationOffer,
} from "../src/filter/rules";
import { parseFilterSettings } from "../src/filter/settings";

const BODY =
	"We are looking for a software engineer to build our product with TypeScript and React. You will work with our team to ship features and improve the platform for our customers. We value ownership and clear writing.";

/** A user who lives in Turkey, set from the profile's location; everything else default. */
const IN_TURKEY = parseFilterSettings({
	livesIn: "Turkey",
	locationPrefilled: true,
	languages: ["English", "Turkish"],
});
const RELOCATING = parseFilterSettings({ ...IN_TURKEY, relocation: true });

function job(overrides: Partial<FilterInput>): FilterInput {
	return {
		title: "Software Engineer",
		locations: [],
		workplaceType: "unknown",
		descriptionText: BODY,
		...overrides,
	};
}
const evaluate = (input: Partial<FilterInput>, settings = IN_TURKEY) =>
	evaluateHardRequirements(job(input), settings);
const rule = (result: ReturnType<typeof evaluate>, name: string) =>
	result.reasons.find((r) => r.rule === name);

const LOCKHEED =
	"Must be a US Citizen; this position will require a DoD government security clearance.";

describe("the US-only matches the user reported", () => {
	it("rejects Lockheed Martin in Owego, NY on citizenship, clearance and location", () => {
		const result = evaluate({
			locations: ["Owego, NY"],
			descriptionText: `${BODY}\n${LOCKHEED}`,
		});
		expect(result.decision).toBe("reject");
		expect(rule(result, "citizenship")).toMatchObject({
			outcome: "reject",
			message: expect.stringMatching(
				/Requires United States citizenship and a US security clearance; your citizenship is Turkey/,
			),
			evidence: expect.stringMatching(/Must be a US Citizen/),
		});
		expect(rule(result, "location")).toMatchObject({
			outcome: "reject",
			message: expect.stringMatching(
				/Located in Owego, NY; .*relocation is off/,
			),
		});
		expect(result.locationVerdict).toBe("rejected");
	});

	it("rejects Lockheed Martin in Fort Worth, TX even without the citizenship line", () => {
		const result = evaluate({ locations: ["Fort Worth, TX"] });
		expect(result.decision).toBe("reject");
		expect(rule(result, "location")?.outcome).toBe("reject");
	});

	it("rejects Amazon in Seattle, WA and Arlington, VA (no workplace given)", () => {
		for (const location of [
			"Seattle, WA",
			"Arlington, VA",
			"Arlington, VA 22202",
		]) {
			const result = evaluate({ locations: [location] });
			expect(result.decision, location).toBe("reject");
			expect(result.summary, location).toMatch(/relocation is off/);
		}
	});

	it("rejects them with relocation on when the posting offers no relocation or visa support", () => {
		const result = evaluate({ locations: ["Seattle, WA"] }, RELOCATING);
		expect(result.decision).toBe("reject");
		expect(result.summary).toMatch(
			/does not mention relocation or visa support/,
		);
	});

	it("keeps an Amazon Seattle role that offers a relocation package, when relocation is on", () => {
		const result = evaluate(
			{
				locations: ["Seattle, WA"],
				descriptionText: `${BODY}\nWe offer a relocation package and visa sponsorship is available.`,
			},
			RELOCATING,
		);
		expect(result.decision).toBe("keep");
		expect(result.locationVerdict).toBe("relocation");
	});
});

describe("remote roles", () => {
	it("rejects remote roles limited to the US, by location or by the posting's words", () => {
		for (const input of [
			{ locations: ["Remote - United States"] },
			{ locations: ["Remote, US"] },
			{ locations: ["United States (Remote)"] },
			{
				locations: ["Remote"],
				descriptionText: `${BODY}\nThis role is remote within the United States.`,
			},
			{
				locations: ["Remote"],
				descriptionText: `${BODY}\nThis is a US-based remote position.`,
			},
		]) {
			const result = evaluate({ workplaceType: "remote", ...input });
			expect(result.decision, JSON.stringify(input)).toBe("reject");
			expect(rule(result, "location")?.message, JSON.stringify(input)).toMatch(
				/Remote only within/,
			);
		}
	});

	it("reads 'work from anywhere' limited to a place, and location lists naming only another country", () => {
		for (const input of [
			{
				locations: ["United States", "Remote"],
				workplaceType: "remote" as const,
			},
			{
				locations: ["Eden Prairie, MN"],
				descriptionText: `${BODY}\nYou'll enjoy the flexibility to work remotely * from anywhere within the U.S. as you take on some tough challenges.`,
			},
			{
				locations: ["Belfast, Northern Ireland, Remote, United Kingdom"],
				workplaceType: "remote" as const,
				descriptionText: `${BODY}\nThis role is fully remote, offering you flexibility to work from anywhere within NI.`,
			},
			{
				locations: ["Remote - Multiple Locations, United States", "Canada"],
				workplaceType: "remote" as const,
				descriptionText: `${BODY}\nThis position can be performed remotely from anywhere in Canada or the United States.`,
			},
			{
				locations: ["United States, USA"],
				workplaceType: "remote" as const,
				descriptionText: `${BODY}\nWork from anywhere.`,
			},
			{
				locations: [
					"San Francisco, CA, New York, NY, Portland, OR, or Remote within Canada or United States",
					"Any Office or Remote",
				],
				workplaceType: "remote" as const,
			},
		]) {
			const result = evaluate(input);
			expect(result.decision, JSON.stringify(input)).toBe("reject");
			expect(rule(result, "location")?.message, JSON.stringify(input)).toMatch(
				/[Rr]emote only within/,
			);
		}
	});

	it("keeps 'anywhere in the world', a Global location entry, and anywhere in Turkey", () => {
		for (const input of [
			{
				locations: ["United States, USA"],
				descriptionText: `${BODY}\nYou can work from anywhere in the world.`,
			},
			{ locations: ["Remote", "Global"] },
			{
				locations: ["Remote"],
				descriptionText: `${BODY}\nWork from anywhere in Turkey.`,
			},
		]) {
			const result = evaluate({ workplaceType: "remote", ...input });
			expect(result.decision, JSON.stringify(input)).toBe("keep");
		}
	});

	it("keeps remote roles in Turkey", () => {
		for (const location of [
			"Remote – Turkey",
			"Türkiye (Remote)",
			"Remote, İzmir",
		]) {
			const result = evaluate({
				locations: [location],
				workplaceType: "remote",
			});
			expect(result.decision, location).toBe("keep");
			expect(result.locationVerdict, location).toBe("remote_home");
		}
	});

	it("keeps worldwide remote, and rejects it when worldwide remote is off", () => {
		const result = evaluate({
			locations: ["Remote - Worldwide"],
			workplaceType: "remote",
		});
		expect(result.decision).toBe("keep");
		expect(result.locationVerdict).toBe("remote_global");
		const off = evaluate(
			{ locations: ["Remote - Worldwide"], workplaceType: "remote" },
			parseFilterSettings({ ...IN_TURKEY, keepGlobalRemote: false }),
		);
		expect(off.decision).toBe("reject");
		expect(off.summary).toMatch(/worldwide remote jobs are off/);
	});

	it("rejects Remote (EMEA) and Remote (Europe) for someone in Turkey: they may not hire there", () => {
		for (const location of ["Remote (EMEA)", "Remote - Europe"]) {
			const result = evaluate({
				locations: [location],
				workplaceType: "remote",
			});
			expect(result.decision, location).toBe("reject");
			expect(result.summary, location).toMatch(/may not include Turkey/);
		}
	});

	it("keeps Remote (Europe) for someone who lives in Germany", () => {
		const result = evaluate(
			{ locations: ["Remote - Europe"], workplaceType: "remote" },
			parseFilterSettings({ livesIn: "Germany" }),
		);
		expect(result.decision).toBe("keep");
		expect(result.locationVerdict).toBe("remote_home");
	});

	it("keeps a remote role that does not say from where, flagged and ranked lower", () => {
		for (const locations of [["Remote"], ["100% Remote"], []]) {
			const result = evaluate({ locations, workplaceType: "remote" });
			expect(result.decision, locations.join()).toBe("keep");
			expect(result.locationVerdict, locations.join()).toBe("unclear");
			expect(result.flags, locations.join()).toEqual(["location unclear"]);
		}
	});

	it("rejects a place it cannot place: only jobs that clearly hire from home are kept", () => {
		for (const location of [
			"Remote (IN) | Remote (NG) | Remote (PH)",
			"Curitiba",
			"Kolkata",
		]) {
			const result = evaluate({
				locations: [location],
				workplaceType: "remote",
			});
			expect(result.decision, location).toBe("reject");
		}
	});

	it("never rejects on a time zone: only the user decides whether the hours suit them", () => {
		for (const location of [
			"Remote (GMT+3)",
			"Remote - UTC+3",
			"Remote (EET)",
			"Remote (CET)",
			"Remote - CEST",
			"Remote (PST)",
			"Remote, US time zones",
			"Remote (Pacific Time Zone)",
			"Remote, UTC-8 to UTC-5",
		]) {
			const result = evaluate({
				locations: [location],
				workplaceType: "remote",
			});
			expect(result.decision, location).toBe("keep");
		}
		for (const text of [
			"You must be based in CET.",
			"You must be based in the EST time zone.",
		])
			expect(
				evaluate({
					locations: ["Remote"],
					workplaceType: "remote",
					descriptionText: `${BODY}\n${text}`,
				}).decision,
				text,
			).toBe("keep");
		// A place next to the time zone still counts.
		expect(
			evaluate({
				locations: ["Remote - United States (PST)"],
				workplaceType: "remote",
			}).decision,
		).toBe("reject");
	});

	it("keeps regions that hold Turkey; 'International' is worldwide", () => {
		for (const location of [
			"Remote - Middle East",
			"Remote (MENA)",
			"Remote - International",
		])
			expect(
				evaluate({ locations: [location], workplaceType: "remote" }).decision,
				location,
			).toBe("keep");
		expect(
			evaluate({
				locations: ["Remote"],
				workplaceType: "remote",
				descriptionText: `${BODY}\nYou must be based in the Middle East.`,
			}).decision,
		).toBe("keep");
	});

	it("keeps Turkish districts and 'Worldwide' without a workplace field", () => {
		for (const location of ["34906 Pendik", "Çankaya", "Kadıköy, İstanbul"]) // public-ok: districts in a location test
			expect(evaluate({ locations: [location] }).decision, location).toBe(
				"keep",
			);
		const world = evaluate({ locations: ["Worldwide"] });
		expect(world.decision).toBe("keep");
		expect(world.locationVerdict).toBe("remote_global");
	});
});

describe("on-site and hybrid in the user's country", () => {
	it("keeps Turkish cities, with Turkish letters or without", () => {
		for (const [location, workplaceType] of [
			["İzmir", "onsite"],
			["Izmir, Türkiye", "hybrid"],
			["Istanbul, Turkey", "unknown"], // public-ok: a city in a location test
			["İstanbul", "hybrid"], // public-ok: a city in a location test
		] as const) {
			const result = evaluate({ locations: [location], workplaceType });
			expect(result.decision, location).toBe("keep");
			expect(result.locationVerdict, location).toBe("home");
		}
	});

	it("keeps an office job in a country chosen for on-site work", () => {
		const result = evaluate(
			{ locations: ["Berlin, Germany"], workplaceType: "hybrid" },
			parseFilterSettings({ ...IN_TURKEY, keepOnsiteIn: ["Germany"] }),
		);
		expect(result.decision).toBe("keep");
	});

	it("rejects a foreign city with remote wording but no workplace", () => {
		const result = evaluate({
			locations: ["Berlin, Germany"],
			descriptionText: `${BODY}\nWe are a remote-first company.`,
		});
		expect(result.decision).toBe("reject");
		expect(rule(result, "location")?.message).toMatch(/mentions remote work/);
	});
});

describe("relocation", () => {
	it("keeps a role abroad only in a country on the move-to list, when the list is set", () => {
		const settings = parseFilterSettings({
			...RELOCATING,
			relocationCountries: ["Germany", "Netherlands"],
		});
		const text = `${BODY}\nWe offer relocation support for international hires.`;
		expect(
			evaluate(
				{
					locations: ["Berlin, Germany"],
					workplaceType: "onsite",
					descriptionText: text,
				},
				settings,
			).decision,
		).toBe("keep");
		const seattle = evaluate(
			{
				locations: ["Seattle, WA"],
				workplaceType: "onsite",
				descriptionText: text,
			},
			settings,
		);
		expect(seattle.decision).toBe("reject");
		expect(seattle.summary).toMatch(
			/not among the countries you would move to/,
		);
	});

	it("reads relocation and visa offers", () => {
		for (const text of [
			"We offer a generous relocation package.",
			"Relocation support is provided.",
			"We provide relocation assistance to Amsterdam.",
			"We sponsor visas for international candidates.",
			"Visa sponsorship available.",
			"We will sponsor your work visa.",
			"The company will sponsor qualified candidates.",
			"We help you with your relocation to Berlin.",
		])
			expect(relocationOffer(text), text).toMatchObject({
				offered: true,
				refused: false,
			});
	});

	it("respects negations of relocation and sponsorship", () => {
		for (const text of [
			"We are unable to sponsor visas for this role.",
			"No sponsorship available.",
			"Visa sponsorship is not available for this position.",
			"We do not offer relocation.",
			"Relocation is not provided.",
			"Candidates must not require sponsorship now or in the future.",
			"We cannot sponsor.",
			"We offer a relocation package. Unfortunately we are unable to sponsor visas.",
		])
			expect(relocationOffer(text), text).toMatchObject({
				offered: false,
				refused: true,
			});
		expect(relocationOffer(BODY)).toEqual({ offered: false, refused: false });
	});

	it("rejects with the posting's refusal as the reason", () => {
		const result = evaluate(
			{
				locations: ["London, UK"],
				workplaceType: "hybrid",
				descriptionText: `${BODY}\nWe are unable to sponsor visas.`,
			},
			RELOCATING,
		);
		expect(result.decision).toBe("reject");
		expect(result.summary).toMatch(/offers no sponsorship or relocation/);
	});
});

describe("citizenship and clearance", () => {
	const citizenship = (text: string, settings = IN_TURKEY) =>
		rule(
			evaluate(
				{
					locations: ["Remote - Worldwide"],
					workplaceType: "remote",
					descriptionText: `${BODY}\n${text}`,
				},
				settings,
			),
			"citizenship",
		);

	it("rejects postings that need a citizenship or clearance the user lacks", () => {
		for (const text of [
			LOCKHEED,
			"US citizenship required.",
			"U.S. Citizenship is required for this role.",
			"This position requires U.S. citizenship.",
			"Due to ITAR requirements, applicants must be U.S. persons.",
			"This role requires access to export-controlled information; candidates must be U.S. persons.",
			"Must be a U.S. citizen or green card holder.",
			"Active Secret clearance required.",
			"TS/SCI with full-scope polygraph.",
			"Candidates must have an active Top Secret clearance.",
			"Ability to obtain and maintain a security clearance.",
			"EU citizens only.",
			"Applicants must hold British citizenship.",
			"You must hold SC clearance or be willing to undergo SC clearance.",
			"DV cleared candidates only.",
		]) {
			const reason = citizenship(text);
			expect(reason?.outcome, text).toBe("reject");
			expect(reason?.message, text).toMatch(/your citizenship is Turkey/);
		}
	});

	it("respects waivers and optional wording", () => {
		for (const text of [
			"Security clearance is not required.",
			"No security clearance required.",
			"US citizenship is not required.",
			"This role does not require a security clearance.",
			"An active security clearance is a plus.",
			"Secret clearance preferred.",
			"We hire regardless of citizenship.",
			"We need someone who keeps secrets well.",
		])
			expect(citizenship(text)?.outcome, text).toBe("pass");
	});

	it("passes when the user holds the citizenship", () => {
		const american = parseFilterSettings({ livesIn: "United States" });
		expect(citizenship(LOCKHEED, american)?.outcome).toBe("pass");
		const german = parseFilterSettings({
			livesIn: "Turkey",
			citizenship: ["Turkey", "Germany"],
		});
		expect(citizenship("EU citizens only.", german)?.outcome).toBe("pass");
		// A green card holder qualifies where green cards are accepted.
		const resident = parseFilterSettings({
			livesIn: "Turkey",
			rightToWork: ["Turkey", "United States"],
		});
		expect(
			citizenship("Must be a U.S. citizen or green card holder.", resident)
				?.outcome,
		).toBe("pass");
		expect(citizenship("US citizenship required.", resident)?.outcome).toBe(
			"reject",
		);
	});

	it("passes while no citizenship is set, asking for it", () => {
		const reason = citizenship(LOCKHEED, parseFilterSettings({}));
		expect(reason?.outcome).toBe("pass");
		expect(reason?.message).toMatch(/set your citizenship/);
	});
});

describe("review findings (2026-11-03)", () => {
	it("reads relocation offers that name the destination; refusals still win", () => {
		for (const text of [
			"Relocation to Berlin provided.",
			"Relocation to Amsterdam is offered for this role.",
			"We relocate you to Berlin.",
			"We offer relocation assistance to Munich.",
			"We will help you relocate.",
		])
			expect(relocationOffer(text), text).toMatchObject({
				offered: true,
				refused: false,
			});
		for (const text of [
			"Relocation to Berlin is not provided.",
			"Relocation assistance to Berlin is offered, but we are unable to sponsor visas.",
		])
			expect(relocationOffer(text), text).toMatchObject({ offered: false });
		const result = evaluate(
			{
				locations: ["Berlin"],
				workplaceType: "onsite",
				descriptionText: `${BODY}\nRelocation to Berlin provided.`,
			},
			RELOCATING,
		);
		expect(result.decision).toBe("keep");
		expect(result.locationVerdict).toBe("relocation");
	});

	it("bounds a preference to its own clause: a required citizenship stays required", () => {
		for (const text of [
			"Must be a US citizen. React experience preferred.",
			"Must be a US citizen; React experience preferred.",
			"Must be a U.S. citizen. Experience with Go is a plus.",
			"US citizenship not required; active Secret clearance required.",
		]) {
			const result = evaluate({
				locations: ["Remote - Worldwide"],
				workplaceType: "remote",
				descriptionText: `${BODY}\n${text}`,
			});
			expect(result.decision, text).toBe("reject");
			expect(rule(result, "citizenship")?.outcome, text).toBe("reject");
		}
		const preferred = evaluate({
			locations: ["Remote - Worldwide"],
			workplaceType: "remote",
			descriptionText: `${BODY}\nU.S. citizenship preferred.`,
		});
		expect(preferred.decision).toBe("keep");
		expect(preferred.preferred?.[0]?.what).toBe("United States citizenship");
	});

	it("never takes a negated mention of the user's country as hiring there", () => {
		for (const locations of [["Remote"], ["Remote - Turkey"]]) {
			const result = evaluate({
				locations,
				workplaceType: "remote",
				descriptionText: `${BODY}\nWe are not hiring candidates in Turkey. Remote in the US only.`,
			});
			expect(result.decision, locations[0]).toBe("reject");
		}
		expect(
			evaluate({
				locations: ["Remote"],
				workplaceType: "remote",
				descriptionText: `${BODY}\nOpen to all of EMEA except Turkey.`,
			}).decision,
		).toBe("reject");
	});

	it("puts an explicit restriction before a mention of home", () => {
		const result = evaluate({
			locations: ["Remote"],
			workplaceType: "remote",
			descriptionText: `${BODY}\nOur founders are based in Turkey. This role is remote in the US only.`,
		});
		expect(result.decision).toBe("reject");
		expect(result.summary).toMatch(/Remote only within/);
	});

	it("rejects a remote role limited to a legal area the user is outside, and geographic Europe too", () => {
		for (const location of [
			"Remote (EU only)",
			"Remote - EEA",
			"Remote, Schengen area",
			"Remote - Europe (EU)",
			"Remote (UK only)",
		]) {
			const result = evaluate({
				locations: [location],
				workplaceType: "remote",
			});
			expect(result.decision, location).toBe("reject");
		}
		for (const location of ["Remote (Europe)", "Remote — EMEA"])
			expect(
				evaluate({ locations: [location], workplaceType: "remote" }).decision,
				location,
			).toBe("reject");
		// An EU citizen may work there.
		expect(
			evaluate(
				{ locations: ["Remote (EU only)"], workplaceType: "remote" },
				parseFilterSettings({ livesIn: "Turkey", citizenship: ["Germany"] }),
			).decision,
		).toBe("keep");
	});
});

describe("re-check findings (2026-11-03)", () => {
	const worldwide = (descriptionText: string, settings = IN_TURKEY) =>
		evaluate(
			{
				locations: ["Remote - Worldwide"],
				workplaceType: "remote",
				descriptionText: `${BODY}\n${descriptionText}`,
			},
			settings,
		);

	it("binds a modifier to the requirement it follows, not to one before a comma", () => {
		for (const text of [
			"U.S. citizenship is required, clearance preferred.",
			"U.S. citizenship is required; clearance preferred.",
			"US citizenship: required. Clearance: preferred.",
		]) {
			const result = worldwide(text);
			expect(result.decision, text).toBe("reject");
			expect(rule(result, "citizenship")?.message, text).toMatch(
				/Requires United States citizenship/,
			);
		}
		// A preference still waives nothing else: the clearance alone is only preferred.
		expect(
			worldwide("Security clearance preferred, not required.").decision,
		).toBe("keep");
	});

	it("reads exclusions in location fields before what they name", () => {
		for (const location of [
			"EMEA (excluding Turkey)",
			"Europe, except Turkey",
			"Remote - EMEA (not Turkey)",
		]) {
			const result = evaluate({
				locations: [location],
				workplaceType: "remote",
			});
			expect(result.decision, location).toBe("reject");
			expect(result.summary, location).toMatch(/leaves out Turkey/);
		}
		// Leaving out a city or another country leaves the rest as it was.
		expect(
			evaluate({
				locations: ["Turkey (excluding Istanbul office)"], // public-ok: a city in a location test
				workplaceType: "remote",
			}).decision,
		).toBe("keep");
		expect(
			evaluate({ locations: ["EMEA (excluding UK)"], workplaceType: "remote" })
				.summary,
		).toMatch(/may not include Turkey/);
	});

	it("ends a negation at a contrast word: each country keeps its own polarity", () => {
		const result = evaluate({
			locations: ["Remote"],
			workplaceType: "remote",
			descriptionText: `${BODY}\nWe are not hiring in Germany, but remote candidates in Turkey are welcome.`,
		});
		expect(result.decision).toBe("keep");
		expect(result.locationVerdict).toBe("remote_home");
		expect(
			evaluate({
				locations: ["Remote"],
				workplaceType: "remote",
				descriptionText: `${BODY}\nRemote candidates in Germany are welcome, but we are not hiring in Turkey.`,
			}).decision,
		).toBe("reject");
	});

	it("reads 'we relocate engineers to Berlin' as an offer; a refusal to sponsor still wins", () => {
		for (const text of [
			"We relocate engineers to Berlin.",
			"We will relocate new hires to Amsterdam.",
			"We can relocate you to Munich.",
		])
			expect(relocationOffer(text), text).toMatchObject({ offered: true });
		expect(
			evaluate(
				{
					locations: ["Berlin"],
					workplaceType: "onsite",
					descriptionText: `${BODY}\nWe relocate engineers to Berlin.`,
				},
				RELOCATING,
			).decision,
		).toBe("keep");
		expect(
			evaluate(
				{
					locations: ["Berlin"],
					workplaceType: "onsite",
					descriptionText: `${BODY}\nWe relocate engineers to Berlin, but cannot sponsor visas.`,
				},
				RELOCATING,
			).decision,
		).toBe("reject");
		// "If you relocate to Berlin" is the candidate's move, not an offer.
		expect(
			relocationOffer("If you relocate to Berlin, you can join the office.")
				.offered,
		).toBe(false);
	});

	it("records label-colon preferences: 'Clearance: preferred' with citizenship waived", () => {
		const result = worldwide(
			"Citizenship: not required. Clearance: preferred.",
		);
		expect(result.decision).toBe("keep");
		expect(result.preferred).toHaveLength(1);
		expect(result.preferred?.[0]?.what).toBe("a US security clearance");
		expect(worldwide("Clearance: required.").decision).toBe("reject");
		expect(worldwide("Clearance: not required.").preferred).toBeUndefined();
	});

	it("reads Turkish remote and hybrid wording when the workplace is not given", () => {
		const noRemote = parseFilterSettings({
			...IN_TURKEY,
			keepRemoteFromHome: false,
		});
		const remote = evaluate(
			{ locations: ["Türkiye (Uzaktan çalışma)"], workplaceType: "unknown" },
			noRemote,
		);
		expect(remote.decision).toBe("reject");
		expect(remote.summary).toMatch(/remote jobs are off/);
		expect(
			evaluate({
				locations: ["Türkiye (Tam uzaktan)"],
				workplaceType: "unknown",
			}).locationVerdict,
		).toBe("remote_home");
		expect(
			rule(
				evaluate({ locations: ["İzmir (Hibrit)"], workplaceType: "unknown" }),
				"location",
			)?.message,
		).toMatch(/^Hybrid in/);
	});
});

describe("before any country is set", () => {
	it("never rejects on place: on-site abroad, residence and remote-in-a-country are kept", () => {
		const none = parseFilterSettings({});
		for (const input of [
			{ locations: ["Seattle, WA"], workplaceType: "onsite" as const },
			{ locations: ["Ankara, Turkey"], workplaceType: "hybrid" as const },
			{
				locations: ["Remote - United States"],
				workplaceType: "remote" as const,
			},
			{
				locations: ["Remote"],
				workplaceType: "remote" as const,
				descriptionText: `${BODY}\nYou must be based in Germany.`,
			},
		]) {
			const result = evaluate(input, none);
			expect(result.decision, JSON.stringify(input)).toBe("keep");
			expect(result.summary, JSON.stringify(input)).toMatch(
				/set where you live in Settings/,
			);
		}
		expect(
			evaluate(
				{ locations: ["Remote - Worldwide"], workplaceType: "remote" },
				none,
			).decision,
		).toBe("keep");
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
		expect(settings.rightToWork).toEqual(["Turkey", "Atlantis"]);
		expect(settings.keepOnsiteIn).toEqual(["Turkey"]);
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
		expect(countryFromLocation(profileLocation(profile))).toBe("Turkey");
		expect(countryFromLocation("İzmir")).toBe("Turkey");
		expect(countryFromLocation("Berlin, Germany")).toBe("Germany");
		expect(countryFromLocation("Earth")).toBeNull();
		expect(profileLocation({ files: [] })).toBeNull();
	});

	it("fills I live in, citizenship and right to work once, keeping what the user set", () => {
		const filled = withLocationDefaults(parseFilterSettings({}), "Turkey");
		expect(filled).toMatchObject({
			livesIn: "Turkey",
			citizenship: ["Turkey"],
			rightToWork: ["Turkey"],
			locationPrefilled: true,
		});
		// An older right-to-work list stays.
		const kept = withLocationDefaults(
			parseFilterSettings({ rightToWork: ["Turkey", "Germany"] }),
			"Turkey",
		);
		expect(kept.rightToWork).toEqual(["Turkey", "Germany"]);
		// Cleared after the first fill: not filled again.
		const cleared = parseFilterSettings({ ...filled, livesIn: "" });
		expect(withLocationDefaults(cleared, "Turkey").livesIn).toBe("");
	});

	it("derives right to work from citizenship, the EU included", () => {
		const ctx = workContext(
			parseFilterSettings({ livesIn: "Turkey", citizenship: ["Germany"] }),
		);
		expect(ctx.rightToWork).toContain("Turkey");
		expect(ctx.rightToWork).toContain("France");
		expect(ctx.label).toBe("Turkey and Germany");
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

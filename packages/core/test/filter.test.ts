import { describe, expect, it } from "vitest";
import {
	evaluateHardRequirements,
	type FilterInput,
	keywordPattern,
	languageRequirements,
} from "../src/filter/rules";
import { parseFilterSettings } from "../src/filter/settings";
import { fixture, PERSONA_FILTER_SETTINGS } from "./helpers";

const ENGLISH_BODY =
	"We are looking for a senior engineer to build our product with TypeScript and React. You will work with our team to ship features and improve the platform for our customers. We value ownership and clear writing.";

function job(overrides: Partial<FilterInput>): FilterInput {
	return {
		title: "Senior Software Engineer",
		locations: [],
		workplaceType: "unknown",
		descriptionText: ENGLISH_BODY,
		...overrides,
	};
}

const evaluate = (
	input: Partial<FilterInput>,
	settings = PERSONA_FILTER_SETTINGS,
) => evaluateHardRequirements(job(input), settings);

describe("Northbeam-style posting (Spanish, Europe residency)", () => {
	const result = evaluateHardRequirements(
		{
			title: "Senior Full Stack Engineer",
			locations: ["Fully remote (Europe)"],
			workplaceType: "remote",
			descriptionText: fixture("northbeam-posting.txt"),
		},
		PERSONA_FILTER_SETTINGS,
	);

	it("is rejected", () => {
		expect(result.decision).toBe("reject");
	});

	it("rejects on Spanish and on 'reside in Europe', with the posting's words as evidence", () => {
		const language = result.reasons.find((r) => r.rule === "language");
		const permit = result.reasons.find((r) => r.rule === "work_permit");
		expect(language?.outcome).toBe("reject");
		expect(language?.message).toMatch(/Requires Spanish/);
		expect(language?.evidence).toMatch(/Fluent in written and spoken Spanish/);
		// Europe is geographic and may not include Turkey: only clear hires from it are kept.
		expect(permit?.outcome).toBe("reject");
		expect(permit?.message).toMatch(/Asks for residence in Europe/);
		expect(permit?.evidence).toMatch(
			/must reside in Europe and hold a valid work permit/,
		);
		expect(result.summary).toMatch(/Spanish/);
	});
});

describe("location rules", () => {
	it("keeps hybrid and on-site roles in Turkey", () => {
		expect(
			evaluate({ locations: ["Ankara, Turkey"], workplaceType: "hybrid" })
				.decision,
		).toBe("keep");
		expect(
			evaluate({ locations: ["Izmir"], workplaceType: "onsite" }).decision,
		).toBe("keep");
	});

	it("keeps remote roles open to Turkey and global remote roles", () => {
		expect(
			evaluate({ locations: ["Türkiye (Remote)"], workplaceType: "remote" })
				.decision,
		).toBe("keep");
		expect(
			evaluate({ locations: ["Remote - Worldwide"], workplaceType: "remote" })
				.decision,
		).toBe("keep");
		expect(
			evaluate({
				locations: ["Remote"],
				workplaceType: "remote",
				descriptionText: `${ENGLISH_BODY} This role is fully remote and you can work from anywhere.`,
			}).decision,
		).toBe("keep");
	});

	it("rejects remote roles limited to other countries, with a reason", () => {
		const result = evaluate({
			locations: ["United States"],
			workplaceType: "remote",
		});
		expect(result.decision).toBe("reject");
		expect(result.summary).toMatch(/Remote only within United States/);
		expect(
			evaluate({ locations: ["NAMER and LatAm"], workplaceType: "remote" })
				.decision,
		).toBe("reject");
	});

	it("rejects on-site roles abroad while relocation is off; with it on, keeps only those offering relocation or visa support", () => {
		const off = evaluate({
			locations: ["San Francisco, United States"],
			workplaceType: "onsite",
		});
		expect(off.decision).toBe("reject");
		expect(off.summary).toMatch(/relocation is off/);
		const relocating = parseFilterSettings({
			...PERSONA_FILTER_SETTINGS,
			relocation: true,
		});
		const silent = evaluate(
			{ locations: ["Stockholm, Sweden"], workplaceType: "onsite" },
			relocating,
		);
		expect(silent.decision).toBe("reject");
		expect(silent.summary).toMatch(
			/does not mention relocation or visa support/,
		);
		const offered = evaluate(
			{
				locations: ["Stockholm, Sweden"],
				workplaceType: "onsite",
				descriptionText: `${ENGLISH_BODY}\nWe offer a relocation package and visa support.`,
			},
			relocating,
		);
		expect(offered.decision).toBe("keep");
		expect(offered.locationVerdict).toBe("relocation");
		expect(offered.reasons.find((r) => r.rule === "location")?.message).toMatch(
			/offers relocation or visa support/,
		);
	});

	it("keeps a posting with no place flagged; rejects a region that may not hire from home", () => {
		for (const input of [
			{ locations: ["Remote"], workplaceType: "remote" as const },
			{ locations: [], workplaceType: "unknown" as const },
		]) {
			const result = evaluate(input);
			expect(result.decision, JSON.stringify(input)).toBe("keep");
			expect(result.flags).toContain("location unclear");
		}
		for (const input of [
			{ locations: ["EMEA"], workplaceType: "remote" as const },
			{ locations: ["Europe"], workplaceType: "remote" as const },
		])
			expect(evaluate(input).decision, JSON.stringify(input)).toBe("reject");
	});

	it("does not read lowercase 'us' in prose as the United States", () => {
		expect(
			evaluate({ locations: ["Join us remotely"], workplaceType: "remote" })
				.summary,
		).not.toMatch(/United States/);
	});
});

describe("work-permit rules", () => {
	it("rejects a US work-authorization requirement on a vague remote role", () => {
		const result = evaluate({
			locations: ["Remote"],
			workplaceType: "remote",
			descriptionText: `${ENGLISH_BODY}\nCandidates must be authorized to work in the United States without sponsorship.`,
		});
		expect(result.decision).toBe("reject");
		expect(
			result.reasons.find((r) => r.rule === "work_permit")?.message,
		).toMatch(/United States/);
	});

	it("rejects a worldwide remote role that asks for residence in Europe: it may not include Turkey", () => {
		const result = evaluate({
			locations: ["Remote - Worldwide"],
			workplaceType: "remote",
			descriptionText: `${ENGLISH_BODY}\nYou must be based in Europe.`,
		});
		expect(result.decision).toBe("reject");
		const permit = result.reasons.find((r) => r.rule === "work_permit");
		expect(permit?.outcome).toBe("reject");
		expect(permit?.message).toMatch(/residence in Europe/);
	});

	it("tells legal work authorization apart from residence", () => {
		const permit = (text: string, settings = PERSONA_FILTER_SETTINGS) =>
			evaluate(
				{
					locations: ["Remote"],
					workplaceType: "remote",
					descriptionText: `${ENGLISH_BODY}\n${text}`,
				},
				settings,
			).reasons.find((r) => r.rule === "work_permit");
		// A legal area Turkey is not part of is decisive.
		expect(permit("You must be authorized to work in the EU.")).toMatchObject({
			outcome: "reject",
			message: expect.stringMatching(/Requires work authorization in EU/),
		});
		// A geographic region that may not include Turkey is a reject too.
		expect(permit("You must be authorized to work in Europe.")?.outcome).toBe(
			"reject",
		);
		expect(permit("Candidates must live in EMEA.")?.outcome).toBe("reject");
		// Residence in a named country is decisive unless relocation is on.
		expect(permit("You must be based in Germany.")).toMatchObject({
			outcome: "reject",
			message: expect.stringMatching(/Requires residence in Germany/),
		});
		// With relocation on, only when the posting offers relocation or visa support.
		const relocating = parseFilterSettings({
			...PERSONA_FILTER_SETTINGS,
			relocation: true,
		});
		expect(permit("You must be based in Germany.", relocating)?.outcome).toBe(
			"reject",
		);
		expect(
			permit(
				"You must be based in Germany. We provide relocation assistance.",
				relocating,
			),
		).toMatchObject({
			outcome: "pass",
			message: expect.stringMatching(/offers relocation or visa support/),
		});
	});

	it("only rejects an affirmative work-authorization requirement", () => {
		const permit = (text: string) =>
			evaluate({
				locations: ["Remote"],
				workplaceType: "remote",
				descriptionText: `${ENGLISH_BODY}\n${text}`,
			}).reasons.find((r) => r.rule === "work_permit");
		for (const waived of [
			"You do not need work authorization in Germany.",
			"Work authorization in the United States is not required.",
			"We hire regardless of work authorization in the UK.",
			"You don't need to be based in Germany.",
		])
			expect(permit(waived)?.outcome, waived).toBe("pass");
		// A bare mention is no requirement.
		expect(permit("Work authorization in Germany.")).toMatchObject({
			outcome: "pass",
			message: expect.stringMatching(/without saying it is required/),
		});
		expect(
			permit("Applicants must have work authorization in Germany.")?.outcome,
		).toBe("reject");
	});

	it("passes a residency requirement that names Turkey", () => {
		const result = evaluate({
			locations: ["Remote"],
			workplaceType: "remote",
			descriptionText: `${ENGLISH_BODY}\nYou must be based in Turkey or the UK.`,
		});
		expect(result.decision).toBe("keep");
	});
});

describe("language rules", () => {
	it("detects required languages and ignores optional ones and market mentions", () => {
		expect(
			languageRequirements("Fluent German is required.").map((r) => r.language),
		).toEqual(["German"]);
		expect(
			languageRequirements("German and English skills are mandatory.").map(
				(r) => r.language,
			),
		).toEqual(["German", "English"]);
		expect(
			languageRequirements("Native-level French (C2)").map((r) => r.language),
		).toEqual(["French"]);
		expect(languageRequirements("Spanish is a plus.")).toEqual([]);
		expect(
			languageRequirements("Experience with the Spanish market is required."),
		).toEqual([]);
		expect(
			languageRequirements("You will work with our German office."),
		).toEqual([]);
	});

	it("scopes optional markers to their own clause", () => {
		const required = (text: string) =>
			languageRequirements(text).map((r) => r.language);
		expect(
			required("Fluent Spanish is required; German is a nice to have."),
		).toEqual(["Spanish"]);
		expect(required("Fluent Spanish is required, German is a plus.")).toEqual([
			"Spanish",
		]);
		expect(required("German is a plus but fluent Spanish is a must.")).toEqual([
			"Spanish",
		]);
		// A shared optional marker still covers a list of languages.
		expect(required("Fluency in Spanish, German or French is a plus.")).toEqual(
			[],
		);
		expect(
			evaluate({
				locations: ["Ankara, Turkey"],
				workplaceType: "hybrid",
				descriptionText: `${ENGLISH_BODY}\nFluent Spanish is required; German is a nice to have.`,
			}).summary,
		).toMatch(/Requires Spanish/);
	});

	it("rejects roles needing a non-English, non-Turkish language", () => {
		const result = evaluate({
			locations: ["Ankara, Turkey"],
			workplaceType: "hybrid",
			descriptionText: `${ENGLISH_BODY}\nFluency in Dutch is essential.`,
		});
		expect(result.decision).toBe("reject");
		expect(result.summary).toMatch(/Requires Dutch/);
	});

	it("keeps roles needing Turkish", () => {
		expect(
			evaluate({
				locations: ["Ankara, Turkey"],
				workplaceType: "onsite",
				descriptionText: `${ENGLISH_BODY}\nFluent Turkish and English required.`,
			}).decision,
		).toBe("keep");
	});

	it("rejects postings written in another language", () => {
		const german =
			"Wir suchen eine erfahrene Entwicklerin oder einen Entwickler für unser Team in Berlin. Du arbeitest mit uns an der Plattform und bist für die Weiterentwicklung der Architektur verantwortlich. Wir bieten dir ein tolles Team, flexible Arbeitszeiten und die Möglichkeit, mit modernen Technologien zu arbeiten. Die Stelle ist unbefristet und wir freuen uns auf deine Bewerbung mit Lebenslauf und Zeugnissen, die du uns über das Formular senden kannst.";
		const result = evaluate({
			locations: ["Remote"],
			workplaceType: "remote",
			descriptionText: german,
		});
		expect(result.decision).toBe("reject");
		expect(result.summary).toMatch(/written in German/);
	});
});

describe("role rules", () => {
	it("rejects titles outside target roles and interns", () => {
		expect(
			evaluate({ title: "Account Executive", locations: ["Ankara"] }).decision,
		).toBe("reject");
		expect(
			evaluate({
				title: "Software Engineering Intern",
				locations: ["Ankara"],
			}).decision,
		).toBe("reject");
	});

	it("can be disabled", () => {
		expect(
			evaluate(
				{ title: "Account Executive", locations: ["Ankara"] },
				parseFilterSettings({ ...PERSONA_FILTER_SETTINGS, roleKeywords: [] }),
			).decision,
		).toBe("keep");
	});
});

describe("defaults", () => {
	it("name no country and only English: the user says where they can work", () => {
		const defaults = parseFilterSettings({});
		expect(defaults.rightToWork).toEqual([]);
		expect(defaults.keepOnsiteIn).toEqual([]);
		expect(defaults.languages).toEqual(["English"]);
	});
});

describe("title keywords with symbols", () => {
	const settings = {
		...PERSONA_FILTER_SETTINGS,
		excludeTitleKeywords: ["C++", "C#", ".NET", "(contract)"],
	};
	const role = (title: string) =>
		evaluate({ title }, settings).reasons.find((r) => r.rule === "role");

	it("match as whole words, not as regular expression syntax", () => {
		expect(role("Senior C++ Engineer")?.message).toBe('Title contains "C++".');
		expect(role("Senior C# Developer")?.message).toBe('Title contains "C#".');
		expect(role("Software Engineer, .NET")?.message).toBe(
			'Title contains ".NET".',
		);
		expect(role("Software Engineer (Contract)")?.message).toBe(
			'Title contains "(contract)".',
		);
	});

	it("do not match inside another word", () => {
		expect(role("Senior Software Engineer")?.outcome).toBe("pass");
		expect(keywordPattern("net").test("internet engineer")).toBe(false);
		expect(keywordPattern("go").test("django developer")).toBe(false);
		expect(keywordPattern("go").test("go developer")).toBe(true);
	});
});

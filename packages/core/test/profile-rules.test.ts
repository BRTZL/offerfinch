import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadProfileFromDir } from "../src/profile/load-node";
import {
	bannedTerms,
	checkDocumentRules,
	checkExperienceRecords,
	checkQuote,
	experienceRecords,
	ruleSet,
	wordingRules,
} from "../src/tailor/profile-rules";
import { FIXTURES } from "./helpers";

const profile = await loadProfileFromDir(join(FIXTURES, "tailor-profile"));
const rules = ruleSet(profile);
const context = { companyName: "Acme Robotics", jobTitle: "Senior Engineer" };
const check = (kind: "cv" | "cover_letter" | "form_answers", text: string) =>
	checkDocumentRules(kind, text, rules, context);

describe("profile loading", () => {
	it("never loads sources/, the outdated raw export", () => {
		expect(profile.files.map((f) => f.path)).not.toContain(
			"sources/linkedin-2026-10-23.md",
		);
		expect(profile.files.some((f) => f.path.startsWith("sources/"))).toBe(
			false,
		);
	});
});

describe("banned terms", () => {
	it("bans degree wording, Python, ClickHouse, the Don't claim list and don't-list lines", () => {
		const terms = bannedTerms(profile).map((t) => t.term);
		expect(terms).toEqual(
			expect.arrayContaining([
				"degree wording",
				"Python",
				"ClickHouse",
				"BigQuery",
				"Shopify",
				"WooCommerce",
				"carrier APIs",
				"logistics APIs",
				"Twilio",
				"Cursor",
				"Copilot",
				"FastAPI",
				"Kafka",
				"RabbitMQ",
			]),
		);
		for (const text of [
			"Bachelor's in Computer Science",
			"B.Sc. Computer Science",
			"graduated in 2025",
			"Strong Python skills",
			"Built analytics on ClickHouse",
			"Event pipelines on Kafka",
		])
			expect(
				check("cv", text).some((i) => i.rule === "banned_term"),
				text,
			).toBe(true);
		// Lowercase "cursor" is an ordinary word, not the editor.
		expect(check("cv", "Moved the cursor logic into a hook.")).toEqual([]);
	});

	it("lets a letter name the target company even when its name is banned as a skill", () => {
		const ctx = { companyName: "ClickHouse", jobTitle: "Senior Engineer" };
		const letter = "I would love to join ClickHouse as a Senior Engineer.";
		expect(
			checkDocumentRules("form_answers", letter, rules, ctx).filter(
				(i) => i.rule === "banned_term",
			),
		).toEqual([]);
		expect(
			checkDocumentRules("cv", "Skills: ClickHouse", rules, ctx).some(
				(i) => i.rule === "banned_term",
			),
		).toBe(true);
	});
});

describe("a CV wording rule the profile states", () => {
	it("requires 'sole developer' with no commit counts", () => {
		expect(
			check("cv", "- Sole committer on Tablewise (514 commits).").map(
				(i) => i.rule,
			),
		).toContain("cv_wording");
		expect(
			check("cv", "- Tablewise: built it alone, 514 commits since May.").map(
				(i) => i.rule,
			),
		).toContain("cv_wording");
		expect(
			check("cv", "- Sole developer of Tablewise, a reservation platform."),
		).toEqual([]);
	});

	it("reads the rule from the profile, for any subject, and none without one", () => {
		expect(wordingRules(profile)).toEqual([
			expect.objectContaining({
				subject: "Tablewise",
				phrase: "sole developer",
				noCommitCounts: true,
			}),
		]);
		const other = {
			files: [
				{
					path: "projects.md",
					content:
						'# Projects\n\n## Harbor Kit (2024)\n\n- **CV wording:** "lead maintainer"\n',
				},
			],
		};
		const rules = ruleSet(other);
		const issues = checkDocumentRules(
			"cv",
			"- Lead author of Harbor Kit.\n- Sole committer on Tablewise (514 commits).",
			rules,
			{ companyName: "Acme", jobTitle: "Engineer" },
		);
		expect(issues.map((i) => i.message)).toEqual([
			'Harbor Kit: write "lead maintainer", not "Lead author" (projects.md).',
		]);
	});
});

describe("experience records", () => {
	it("reads headers as the authoritative record", () => {
		expect(experienceRecords(profile)).toContainEqual({
			file: "experience/2019-fieldline.md",
			company: "Fieldline",
			title: "Embedded System Developer",
			dates: "Sep 2019 – Jan 2020",
			locationParts: ["Izmir, Turkey", "On-site", "Part-time"],
		});
	});

	it("flags an old CV record that contradicts the header", () => {
		const cv = [
			"## Experience",
			"",
			"### Embedded System Developer — Fieldline",
			"*Izmir, Turkey · Remote · Sep 2019 – Jan 2020*",
			"",
			"### Staff Engineer — Brightloom",
			"*United States · Remote · Jan 2023 – Present*",
			"",
			"### Engineer — Invented Corp",
			"*Remote · Jan 2020 – Jan 2021*",
		].join("\n");
		const messages = check("cv", cv).map((i) => i.message);
		expect(messages).toEqual(
			expect.arrayContaining([
				expect.stringMatching(
					/Fieldline: "Remote" is not in the header location/,
				),
				expect.stringMatching(
					/Brightloom title must be "Senior Software Engineer"/,
				),
				expect.stringMatching(/Brightloom dates must be "Jan 2023 – Oct 2025"/),
				expect.stringMatching(
					/No experience file for employer "Invented Corp"/,
				),
			]),
		);
		const ok = [
			"## Experience",
			"### Embedded System Developer — Fieldline",
			"*Izmir, Turkey · Sep 2019 - Jan 2020*",
		].join("\n");
		expect(check("cv", ok)).toEqual([]);
	});
});

describe("text rules", () => {
	it("flags placeholders, letter length and name spelling", () => {
		expect(check("cv", "Dear <Hiring Manager>,").map((i) => i.rule)).toContain(
			"placeholder",
		);
		const short =
			"Dear Hiring Team at Acme Robotics, I want the Senior Engineer role.";
		expect(check("cover_letter", short).map((i) => i.message)).toEqual(
			expect.arrayContaining([expect.stringMatching(/220 to 400/)]),
		);
		expect(
			check("form_answers", "I admire acme robotics.").map((i) => i.message),
		).toEqual([
			'Company name must be spelled exactly "Acme Robotics", not "acme robotics".',
		]);
	});
});

describe("evidence quotes", () => {
	it("accepts verbatim quotes and refuses caution lines, Don't claim items, old records and sources/", () => {
		expect(
			checkQuote(
				profile,
				"experience/2023-brightloom.md",
				"cut cancellation rates by 25%",
			),
		).toMatchObject({ ok: true });
		expect(checkQuote(profile, "skills.md", "Python")).toMatchObject({
			ok: false,
			reason: "quote is from a caution line",
		});
		expect(checkQuote(profile, "skills.md", "ClickHouse")).toMatchObject({
			ok: false,
			reason: "quote is from the Don't claim list",
		});
		expect(checkQuote(profile, "education.md", "Bachelor's")).toMatchObject({
			ok: false,
		});
		expect(
			checkQuote(
				profile,
				"experience/2019-fieldline.md",
				"Izmir, Turkey · Remote",
			),
		).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/old CV record/),
		});
		expect(
			checkQuote(profile, "sources/linkedin-2026-10-23.md", "Python"),
		).toMatchObject({ ok: false, reason: "sources/ is not evidence" });
	});
});

describe("rules come from each user's own profile", () => {
	const other = {
		files: [
			{
				path: "education.md",
				content:
					"# Education\n\n- **B.Sc. Computer Science**, Example University, 2012 – 2016.\n",
			},
			{
				path: "skills.md",
				content: "# Skills\n\n- Python, ClickHouse, Go\n",
			},
		],
	};
	const otherRules = ruleSet(other);
	const checkOther = (text: string) =>
		checkDocumentRules("cv", text, otherRules, context);

	it("lets a user with a degree, Python and ClickHouse write them", () => {
		expect(bannedTerms(other)).toEqual([]);
		for (const text of [
			"B.Sc. Computer Science, Example University",
			"Strong Python skills",
			"Built analytics on ClickHouse",
		])
			expect(checkOther(text).map((i) => i.rule)).not.toContain("banned_term");
	});

	it("applies no Tablewise wording rule to a profile without one", () => {
		expect(
			checkOther("- Tablewise: sole engineer, 900 commits").map((i) => i.rule),
		).not.toContain("cv_wording");
	});

	it("still bans what this profile itself rules out", () => {
		expect(check("cv", "graduated in 2025").map((i) => i.rule)).toContain(
			"banned_term",
		);
	});
});

describe("the cover letter's length", () => {
	const letter = (words: number) =>
		Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
	const length = (words: number) =>
		check("cover_letter", letter(words)).filter((i) => i.rule === "length");

	it("accepts 220 to 400 words (the owner's decision, 2026-11-03)", () => {
		expect(length(220)).toEqual([]);
		expect(length(400)).toEqual([]);
	});

	it("rejects 219 and 401 words", () => {
		expect(length(219).map((i) => i.message)).toEqual([
			"Cover letter has 219 words; it must be 220 to 400.",
		]);
		expect(length(401)).toHaveLength(1);
	});
});

describe("two roles at one company", () => {
	const stint = (id: string, title: string, dates: string) => ({
		path: `experience/${id}.md`,
		content: `# Quayside Labs B.V. — ${title}\n\n- **Dates:** ${dates}\n- **Location:** Remote\n`,
	});
	const records = experienceRecords({
		files: [
			stint("later", "Senior Software Engineer", "Apr 2025 – Sep 2026"),
			stint("early", "Frontend Developer", "Mar 2021 – Sep 2021"),
		],
	});
	const cv = (title: string, dates: string) =>
		`## Experience\n\n### ${title} — Quayside Labs B.V.\n*Remote · ${dates}*\n`;

	it("checks each role against its own file", () => {
		expect(
			checkExperienceRecords(
				cv("Frontend Developer", "Mar 2021 – Sep 2021") +
					cv("Senior Software Engineer", "Apr 2025 – Sep 2026"),
				records,
			),
		).toEqual([]);
	});

	it("names the right file's title when the title is off", () => {
		expect(
			checkExperienceRecords(
				cv("First Time Frontend Developer", "Mar 2021 – Sep 2021"),
				records,
			).map((i) => i.message),
		).toEqual([
			'Quayside Labs B.V. title must be "Frontend Developer" (experience/early.md header).',
		]);
	});
});

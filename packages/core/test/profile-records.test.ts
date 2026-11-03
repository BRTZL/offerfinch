import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadProfileFromDir } from "../src/profile/load-node";
import {
	type DraftRecord,
	missingLines,
	type ProfileRecord,
	recordForCitation,
	recordLabel,
	recordsFromFiles,
	recordsFromStructured,
	renderRecords,
} from "../src/profile/records";
import {
	bannedTerms,
	evidenceProfile,
	experienceRecords,
	ruleSet,
} from "../src/tailor/profile-rules";

const FIXTURES = [
	path.join(import.meta.dirname, "fixtures/profile"),
	path.join(import.meta.dirname, "fixtures/tailor-profile"),
	path.join(import.meta.dirname, "fixtures/desktop-profile"),
];

const saved = (drafts: DraftRecord[]): ProfileRecord[] =>
	drafts.map((d, i) => ({
		...d,
		id: `r${String(i).padStart(3, "0")}`,
		position: i,
		sourceDate: new Date("2026-11-01T00:00:00Z"),
	}));

describe("profile records from Markdown files", () => {
	for (const dir of FIXTURES)
		it(`keeps every line of ${path.relative(process.cwd(), dir)}`, async () => {
			const original = evidenceProfile(await loadProfileFromDir(dir));
			const records = saved(recordsFromFiles(original.files, "test import"));
			const rendered = { files: renderRecords(records) };
			const lost = missingLines(original.files, rendered.files);
			expect(lost).toEqual([]);

			// The rules the pipeline derives from the profile are the same.
			const key = (r: { company: string; title: string; dates: string }) =>
				`${r.company}|${r.title}|${r.dates}`;
			expect(experienceRecords(rendered).map(key).sort()).toEqual(
				experienceRecords(original).map(key).sort(),
			);
			expect(
				bannedTerms(rendered)
					.map((t) => t.term)
					.sort(),
			).toEqual(
				bannedTerms(original)
					.map((t) => t.term)
					.sort(),
			);
			expect(ruleSet(rendered).wording).toEqual(
				ruleSet(original).wording.map((r) => ({
					...r,
					file: expect.any(String),
				})),
			);
		});
});

describe("rendering records", () => {
	const records = saved([
		{
			kind: "about",
			source: "you",
			data: {
				name: "Avery Quinn",
				email: "avery@example.com",
				phone: "",
				location: "Lisbon, Portugal",
				linkedin: "",
				website: "",
				github: "",
				summary: "Frontend engineer.",
				more: "",
			},
		},
		{ kind: "skill", source: "you", data: { name: "React" } },
		{ kind: "skill", source: "you", data: { name: "**Testing:** Vitest" } },
		{
			kind: "experience",
			source: "you",
			data: {
				company: "Harbor Mills",
				title: "Engineer",
				location: "Remote",
				start: "Jan 2021",
				end: "",
				bullets: ["Built the billing page in React."],
				more: "",
			},
		},
	]);

	it("writes each record to a path keyed by its id, stable across edits", () => {
		const files = renderRecords(records);
		const role = records[3] as ProfileRecord;
		expect(files.map((f) => f.path)).toEqual([
			"personal.md",
			"summary.md",
			"skills.md",
			`experience/${role.id}.md`,
		]);
		const edited = records.map((r) =>
			r.id === role.id && r.kind === "experience"
				? { ...r, data: { ...r.data, company: "Harbor Mills Ltd" } }
				: r,
		);
		expect(renderRecords(edited).map((f) => f.path)).toEqual(
			files.map((f) => f.path),
		);
		expect(files.find((f) => f.path === "skills.md")?.content).toContain(
			"- **Testing:** Vitest",
		);
		expect(experienceRecords({ files })[0]).toMatchObject({
			company: "Harbor Mills",
			title: "Engineer",
			dates: "Jan 2021 – Present",
		});
	});

	it("names the record a citation points at", () => {
		const role = records[3] as ProfileRecord;
		expect(
			recordForCitation(records, `experience/${role.id}.md`, "billing page"),
		).toBe(role);
		expect(recordLabel(role)).toBe("Experience · Harbor Mills, Engineer");
		expect(recordForCitation(records, "skills.md", "React")?.id).toBe(
			records[1]?.id,
		);
		expect(recordForCitation(records, "personal.md")?.kind).toBe("about");
		expect(recordForCitation(records, "experience/gone.md")).toBeNull();
	});

	it("drafts records from a structured resume", () => {
		const drafts = recordsFromStructured(
			{
				personal: {
					name: "Avery Quinn",
					email: "",
					phone: "",
					location: "",
					linkedin: "",
					website: "",
					github: "",
				},
				summary: "Engineer.",
				skills: ["React", " "],
				experience: [
					{
						company: "Harbor Mills",
						title: "Engineer",
						location: "",
						start: "2021",
						end: "Present",
						bullets: ["Shipped it."],
					},
				],
				education: [],
				projects: [],
				languages: ["English"],
				notes: [],
			},
			"a pasted resume",
		);
		expect(drafts.map((d) => d.kind)).toEqual([
			"about",
			"skill",
			"experience",
			"extra",
		]);
	});
});

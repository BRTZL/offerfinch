import { describe, expect, it } from "vitest";

import { type ProfileRecord, renderRecords } from "../src/profile/records";
import { citedUnits, staleCitations } from "../src/tailor/stale";

const day = new Date("2026-11-01T00:00:00Z");

const role: ProfileRecord = {
	id: "role-1",
	kind: "experience",
	position: 0,
	source: "you",
	sourceDate: day,
	data: {
		company: "Harbor Mills",
		title: "Frontend Engineer",
		location: "Remote",
		start: "Jan 2021",
		end: "Mar 2024",
		bullets: [
			"Built the billing page in React and cut checkout errors by 30%.",
			"Ran the design review every week.",
		],
		more: "",
	},
};
const skill: ProfileRecord = {
	id: "skill-1",
	kind: "skill",
	position: 0,
	source: "you",
	sourceDate: day,
	data: { name: "TypeScript" },
};

const profileOf = (records: ProfileRecord[]) => ({
	files: renderRecords(records),
});

/** A claim as a passed review stores it. */
const claim = (file: string, quote: string) => ({
	document: "cv",
	text: "Cut checkout errors by 30% with a React billing page.",
	supported: true,
	evidence: [{ file, quote }],
	note: "",
	rejected: [],
});

describe("a claim citing a profile record", () => {
	const cites = [
		claim(
			"experience/role-1.md",
			"Built the billing page in React and cut checkout errors by 30%.",
		),
		claim("skills.md", "TypeScript"),
	];

	it("is current while the records say what it quotes", () => {
		expect(staleCitations(cites, profileOf([role, skill]))).toEqual([]);
	});

	it("is stale once the cited record is removed", () => {
		const stale = staleCitations(cites, profileOf([skill]));
		expect(stale).toEqual([
			expect.objectContaining({
				file: "experience/role-1.md",
				reason: "file not in profile",
			}),
		]);
	});

	it("is stale once the record is edited so the quote is gone", () => {
		const edited: ProfileRecord = {
			...role,
			data: {
				...role.data,
				bullets: [
					"Built the billing page in React and cut checkout errors by 20%.",
				],
			},
		} as ProfileRecord;
		const stale = staleCitations(cites, profileOf([edited, skill]));
		expect(stale).toEqual([
			expect.objectContaining({
				file: "experience/role-1.md",
				reason: "quote not found in file",
			}),
		]);
	});

	it("stays current when an edit leaves the quoted text as it was", () => {
		const edited = {
			...role,
			data: { ...role.data, title: "Senior Frontend Engineer" },
		} as ProfileRecord;
		expect(staleCitations(cites, profileOf([edited, skill]))).toEqual([]);
	});

	it("is stale when an edit turns the quoted line into a caution", () => {
		const edited = {
			...skill,
			data: { name: "TypeScript: don't list on CVs" },
		} as ProfileRecord;
		expect(
			staleCitations(
				[claim("skills.md", "TypeScript")],
				profileOf([role, edited]),
			),
		).toEqual([
			expect.objectContaining({ reason: "quote is from a caution line" }),
		]);
	});

	it("ignores claims the review did not pass and has nothing to check without a profile", () => {
		expect(
			staleCitations([{ ...cites[0], supported: false }], profileOf([])),
		).toEqual([]);
		expect(staleCitations(cites, null)).toHaveLength(2);
	});

	it("is stale once the answer confirming a flagged line is removed or edited", () => {
		const line = "Mentored two junior engineers.";
		const flags = [{ state: "confirmed", text: line }];
		const withAnswer = (text: string) => ({
			files: [
				...renderRecords([role, skill]),
				{
					path: "answers.md",
					content: `# Answers\n\n## Confirmed by the user in a review\n\n- Confirmed as true by the user: ${text}\n`,
				},
			],
		});
		expect(staleCitations([], withAnswer(line), flags)).toEqual([]);
		expect(
			staleCitations([], withAnswer("Mentored one junior engineer."), flags),
		).toHaveLength(1);
		expect(staleCitations([], profileOf([role, skill]), flags)).toEqual([
			expect.objectContaining({
				reason: "the confirmation was removed or edited",
			}),
		]);
	});
});

/** Codex review of b74f1bc: a quote kept word for word under a changed record is not current. */
describe("a check bound to the cited record's whole text", () => {
	const alpha: ProfileRecord = {
		id: "role-a",
		kind: "experience",
		position: 0,
		source: "you",
		sourceDate: day,
		data: {
			company: "Alpha",
			title: "Engineer",
			location: "Remote",
			start: "2020",
			end: "2022",
			bullets: ["Built React services."],
			more: "",
		},
	};
	const other: ProfileRecord = {
		...alpha,
		id: "role-b",
		data: {
			...alpha.data,
			company: "Gamma",
			bullets: ["Ran the on-call rota."],
		},
	} as ProfileRecord;
	const claims = [
		{
			document: "cv",
			text: "I built React services at Alpha",
			supported: true,
			evidence: [
				{ file: "experience/role-a.md", quote: "Built React services." },
			],
			note: "",
			rejected: [],
		},
		{
			document: "cv",
			text: "Knows TypeScript",
			supported: true,
			evidence: [{ file: "skills.md", quote: "TypeScript" }],
			note: "",
			rejected: [],
		},
	];
	const checkedOn = [alpha, other, skill];
	const cited = citedUnits(claims, profileOf(checkedOn));

	it("is stale when the cited role's company changes and the bullet stays", () => {
		const renamed = {
			...alpha,
			data: { ...alpha.data, company: "Beta" },
		} as ProfileRecord;
		expect(
			staleCitations(claims, profileOf([renamed, other, skill]), [], cited),
		).toEqual([
			expect.objectContaining({
				file: "experience/role-a.md",
				reason: "the cited record changed since the check",
			}),
		]);
	});

	it("stays current when only uncited records change", () => {
		const edited = {
			...other,
			data: { ...other.data, company: "Delta" },
		} as ProfileRecord;
		const moreSkills: ProfileRecord = {
			...skill,
			id: "skill-2",
			position: 1,
			data: { name: "Go" },
		};
		expect(
			staleCitations(
				claims,
				profileOf([alpha, edited, skill, moreSkills]),
				[],
				cited,
			),
		).toEqual([]);
	});
});

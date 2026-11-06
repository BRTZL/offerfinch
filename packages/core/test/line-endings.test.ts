import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeLineEndings } from "../src/domain/line-endings";
import { loadProfileFromDir } from "../src/profile/load-node";
import { missingLines, recordsFromFiles } from "../src/profile/records";
import { segmentDocuments } from "../src/tailor/claims/segments";
import {
	checkDocumentRules,
	evidenceProfile,
	ruleSet,
} from "../src/tailor/profile-rules";
import { FIXTURES } from "./helpers";

describe.each(["\r\n", "\r"])("imported line ending %j", (ending) => {
	const convert = (text: string) =>
		normalizeLineEndings(text).replace(/\n/g, ending);

	it.each(["profile", "tailor-profile", "desktop-profile"])(
		"parses %s files and rules exactly as LF, without the disk loader",
		async (fixture) => {
			const lf = await loadProfileFromDir(join(FIXTURES, fixture));
			const imported = {
				files: lf.files.map((f) => ({ ...f, content: convert(f.content) })),
			};
			expect(recordsFromFiles(imported.files, "test")).toEqual(
				recordsFromFiles(lf.files, "test"),
			);
			expect(missingLines(imported.files, lf.files)).toEqual([]);
			expect(evidenceProfile(imported)).toEqual(lf);
			expect(ruleSet(imported)).toEqual(ruleSet(lf));
		},
	);

	it("normalizes files read from disk", async () => {
		const dir = await mkdtemp(join(tmpdir(), "offerfinch-lines-"));
		try {
			const content = "# Personal\n\n- **Name:** Test Candidate\n";
			await writeFile(join(dir, "personal.md"), convert(content));
			expect((await loadProfileFromDir(dir)).files).toEqual([
				{ path: "personal.md", content },
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("checks CV roles, wording and cover letters exactly as LF", async () => {
		const profile = await loadProfileFromDir(join(FIXTURES, "tailor-profile"));
		const rules = ruleSet(profile);
		const context = { companyName: "Acme", jobTitle: "Engineer" };
		const cv =
			"## Experience\n### Wrong title — Tablewise\n*2020 – 2021 · Remote*\n- Sole committer on Tablewise (514 commits).\n";
		const expected = checkDocumentRules("cv", cv, rules, context);
		expect(expected.some((issue) => issue.rule === "cv_wording")).toBe(true);
		expect(checkDocumentRules("cv", convert(cv), rules, context)).toEqual(
			expected,
		);
		const letter =
			"Dear team,\n\nBuilt services with Python.\n\nRegards,\nTest Candidate";
		expect(
			checkDocumentRules("cover_letter", convert(letter), rules, context),
		).toEqual(checkDocumentRules("cover_letter", letter, rules, context));
		const input = {
			profile,
			documents: { cv, cover_letter: letter, form_answers: "" },
			context,
			postingText: "",
			formAnswers: [],
		};
		expect(
			segmentDocuments({
				...input,
				documents: {
					cv: convert(cv),
					cover_letter: convert(letter),
					form_answers: "",
				},
			}),
		).toEqual(segmentDocuments(input));
	});
});

it("normalizes mixed line endings without dropping blank lines", () => {
	expect(normalizeLineEndings("a\r\nb\rc\n\r\n")).toBe("a\nb\nc\n\n");
});

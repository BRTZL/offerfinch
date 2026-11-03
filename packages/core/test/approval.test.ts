import { describe, expect, it } from "vitest";

import { compareApproval, hashDocuments } from "../src/domain/approval";

describe("approval hashes", () => {
	it("matches only when every submitted document is unchanged", async () => {
		const docs = [
			{ kind: "cv", content: "# CV" },
			{ kind: "cover_letter", content: "Dear team" },
			{ kind: "notes", content: "private" },
		];
		const posting = { title: "Role", company: "Co", description: "Text" };
		const approved = await hashDocuments(docs, posting);
		expect(Object.keys(approved).sort()).toEqual([
			"cover_letter",
			"cv",
			"posting",
		]);
		expect(
			compareApproval(approved, await hashDocuments(docs, posting)),
		).toEqual({
			ok: true,
		});
		// Notes are not submitted, so editing them keeps the approval.
		expect(
			compareApproval(
				approved,
				await hashDocuments(
					[...docs.slice(0, 2), { kind: "notes", content: "x" }],
					posting,
				),
			).ok,
		).toBe(true);
		expect(
			compareApproval(
				approved,
				await hashDocuments(
					[{ kind: "cv", content: "# CV edited" }, docs[1] as never],
					posting,
				),
			),
		).toEqual({ ok: false, reason: "cv changed after approval" });
		expect(
			compareApproval(
				approved,
				await hashDocuments(
					[...docs, { kind: "form_answers", content: "{}" }],
					posting,
				),
			),
		).toEqual({ ok: false, reason: "form_answers was added after approval" });
	});

	it("refuses without an approval or without a CV", async () => {
		expect(compareApproval(null, { cv: "a" }).ok).toBe(false);
		expect(compareApproval({}, {})).toEqual({
			ok: false,
			reason: "no CV to submit",
		});
	});
});

describe("compareApproval and the posting", () => {
	const docs = { cv: "c", cover_letter: "l", form_answers: "f" };

	it("refuses a record made before postings were hashed, even if the posting changed since", () => {
		expect(
			compareApproval({ ...docs }, { ...docs, posting: "p2" }),
		).toMatchObject({ ok: false });
	});

	it("refuses when the current posting can't be hashed", () => {
		expect(
			compareApproval({ ...docs, posting: "p1" }, { ...docs }),
		).toMatchObject({ ok: false });
	});

	it("accepts the same documents and posting", () => {
		expect(
			compareApproval({ ...docs, posting: "p1" }, { ...docs, posting: "p1" }),
		).toEqual({ ok: true });
	});
});

import { describe, expect, it } from "vitest";

import {
	type ApplicantData,
	applyUrl,
	exactOption,
	type FormField,
	markdownToPlain,
	planFill,
	sameQuestion,
} from "../src/apply/forms";

const data: ApplicantData = {
	contact: {
		name: "Ada Q Example",
		email: "ada@example.test",
		phone: "+90 555",
		location: "Izmir, Turkey",
		linkedin: "linkedin.com/in/ada",
		website: "",
		github: "",
	},
	answers: [
		{ question: "What is your notice period?", answer: "Four weeks." },
		{ question: "Do you require visa sponsorship?", answer: "No" },
		{ question: "Which languages do you speak?", answer: "English\nTurkish" },
	],
	coverLetterText: "Letter",
	hasCoverLetterFile: false,
};

let n = 0;
const field = (f: Partial<FormField>): FormField => ({
	ref: String(++n),
	kind: "text",
	label: "",
	required: false,
	name: "",
	options: [],
	visible: true,
	...f,
});

describe("answer matching", () => {
	it("matches the same question despite case and punctuation, never a different one", () => {
		expect(
			sameQuestion("What is your notice period?", "what is your NOTICE period"),
		).toBe(true);
		expect(
			sameQuestion(
				"What is your notice period?",
				"What is your salary expectation?",
			),
		).toBe(false);
		expect(exactOption("no.", ["Yes", "No"])).toBe("No");
		expect(exactOption("No, never", ["Yes", "No"])).toBeNull();
	});

	it("builds each board's hosted form URL", () => {
		const job = { url: "", externalId: "123", companyKey: "acme" };
		expect(applyUrl("ashby", job)).toBe(
			"https://jobs.ashbyhq.com/acme/123/application",
		);
		expect(applyUrl("greenhouse", job)).toBe(
			"https://job-boards.greenhouse.io/acme/jobs/123",
		);
		expect(applyUrl("lever", job)).toBe("https://jobs.lever.co/acme/123/apply");
		expect(applyUrl("lever", job, { lever: "http://127.0.0.1:9/lever/" })).toBe(
			"http://127.0.0.1:9/lever/acme/123/apply",
		);
	});
});

describe("planFill", () => {
	it("fills contact fields and approved answers, uploads files last, and leaves optional unknowns blank", () => {
		const plan = planFill(
			[
				field({
					kind: "file",
					name: "resume",
					label: "Resume/CV",
					required: true,
				}),
				field({ name: "first_name", label: "First Name", required: true }),
				field({ name: "last_name", label: "Last Name", required: true }),
				field({ label: "What is your notice period?", required: true }),
				field({
					kind: "select",
					label: "Do you require visa sponsorship?",
					options: ["Yes", "No"],
					required: true,
				}),
				field({
					kind: "checkbox",
					label: "Which languages do you speak?",
					options: ["English", "Turkish", "German"],
					required: true,
				}),
				field({ label: "Twitter", required: false }),
				field({
					kind: "radio",
					name: "gender",
					label: "Gender",
					options: ["Male", "Female"],
				}),
				field({ kind: "file", name: "cover_letter", label: "Cover Letter" }),
			],
			data,
		);
		expect(plan.unknown).toEqual([]);
		expect(plan.actions.map((a) => a.kind)).toEqual([
			"fill",
			"fill",
			"fill",
			"select",
			"choose",
			"file",
		]);
		expect(plan.actions[0]).toMatchObject({ value: "Ada Q" });
		expect(plan.actions[1]).toMatchObject({ value: "Example" });
		expect(plan.actions[4]).toMatchObject({ values: ["English", "Turkish"] });
		expect(plan.blank).toEqual(["Twitter", "Gender", "Cover Letter"]);
	});

	it("never invents: a required question without an approved answer, or one whose answer is not an option, is unknown", () => {
		const plan = planFill(
			[
				field({
					label: "Are you willing to relocate?",
					required: true,
					kind: "radio",
					options: ["Yes", "No"],
				}),
				field({
					kind: "select",
					label: "Do you require visa sponsorship?",
					options: ["Yes, H1B", "No, I am authorized"],
					required: true,
				}),
				field({
					kind: "radio",
					name: "gender",
					label: "Gender",
					options: ["Male", "Female"],
					required: true,
				}),
			],
			data,
		);
		expect(plan.actions).toEqual([]);
		expect(plan.unknown.map((q) => [q.label, q.answered ?? null])).toEqual([
			["Are you willing to relocate?", null],
			["Do you require visa sponsorship?", "No"],
			["Gender", null],
		]);
	});

	it("turns the approved letter into plain text for a text box", () => {
		expect(
			markdownToPlain("Ada\\\n**Bold** and [link](https://x.y)\n\n\n\nEnd"),
		).toBe("Ada\nBold and link\n\nEnd");
	});
});

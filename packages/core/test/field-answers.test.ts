import { describe, expect, it } from "vitest";
import {
	openFormQuestions,
	planFormFields,
	whatWillBeSent,
} from "../src/apply/field-answers";
import {
	alignWithSchema,
	type FormSchema,
	type SchemaField,
	schemaKey,
} from "../src/apply/form-schema";
import {
	type ApplicantData,
	type FormField,
	planFill,
} from "../src/apply/forms";

/** Step 3 of docs/auto-apply-plan.md: every field of the read form maps to an approved value. */

const field = (
	ref: string,
	kind: FormField["kind"],
	name: string,
	label: string,
	extra: { required?: boolean; options?: string[]; section?: string } = {},
): SchemaField => {
	const f: FormField = {
		ref,
		kind,
		name,
		label,
		required: extra.required ?? false,
		options: extra.options ?? [],
		visible: true,
		current: [],
	};
	return { ...f, key: schemaKey(f), page: 1, section: extra.section ?? "" };
};

const required = { required: true };
const EEO = "Voluntary self-identification";

const SCHEMA: FormSchema = {
	board: "greenhouse",
	url: "http://127.0.0.1/greenhouse/acme/jobs/1",
	submit: "Submit application",
	fields: [
		field("1", "text", "first_name", "First Name", required),
		field("2", "text", "last_name", "Last Name", required),
		field("3", "text", "email", "Email", required),
		field("4", "text", "phone", "Phone"),
		field("5", "file", "resume", "Resume/CV", required),
		field("6", "file", "cover_letter", "Cover Letter"),
		field(
			"7",
			"text",
			"question_1",
			"Why do you want to work at Acme?",
			required,
		),
		field("8", "text", "question_2", "What is your notice period?", required),
		// Planted: nothing on file answers it.
		field(
			"9",
			"combobox",
			"question_3",
			"Do you hold an active security clearance?",
			{
				required: true,
				options: ["Yes", "No"],
			},
		),
		field("10", "text", "question_4", "Anything else we should know?"),
		field("11", "combobox", "gender", "Gender", {
			options: ["Male", "Female", "Decline To Self Identify"],
			section: EEO,
		}),
		field("12", "select", "veteran_status", "Veteran status", {
			options: ["I am a veteran", "I am not a veteran"],
			section: EEO,
		}),
	],
};

const DATA: ApplicantData = {
	contact: {
		name: "Ada Example",
		email: "ada@example.test",
		phone: "+90 555 000 00 00",
		location: "Izmir, Turkey",
		linkedin: "",
		website: "",
		github: "",
	},
	answers: [
		{
			question: "Why do you want to work at Acme?",
			answer: "The robotics work matches what I build.",
		},
	],
	coverLetterText: "Letter.",
	hasCoverLetterFile: true,
};

const SAVED = [
	{
		id: "fact-1",
		question: "What is your notice period?",
		answer: "Four weeks.",
	},
];

describe("answers per field", () => {
	const plan = planFormFields(SCHEMA, DATA, SAVED);
	const line = (label: string) => plan.fields.find((f) => f.label === label);

	it("fills contact details and the approved files", () => {
		expect(line("First Name")).toMatchObject({
			value: "Ada",
			source: { kind: "contact" },
		});
		expect(line("Last Name")).toMatchObject({ value: "Example" });
		expect(line("Email")).toMatchObject({ value: "ada@example.test" });
		expect(line("Resume/CV")).toMatchObject({
			value: "CV.pdf",
			source: { kind: "file", file: "cv" },
		});
		expect(line("Cover Letter")).toMatchObject({
			value: "Cover letter.pdf",
			source: { kind: "file", file: "cover_letter" },
		});
	});

	it("uses an approved form answer, and a saved answer with its record id", () => {
		expect(line("Why do you want to work at Acme?")).toMatchObject({
			value: "The robotics work matches what I build.",
			source: { kind: "form_answer" },
		});
		expect(line("What is your notice period?")).toMatchObject({
			value: "Four weeks.",
			source: { kind: "profile_fact", id: "fact-1" },
		});
		// The saved answer joins the form answers, so the claims check and approval cover it.
		expect(plan.add).toEqual([
			{
				question: "What is your notice period?",
				answer: "Four weeks.",
				sourceId: "fact-1",
			},
		]);
	});

	it("turns a required field nothing answers into a question, never a guess", () => {
		expect(line("Do you hold an active security clearance?")).toMatchObject({
			value: null,
			source: { kind: "question" },
		});
		expect(plan.ask).toEqual([
			expect.objectContaining({
				label: "Do you hold an active security clearance?",
				required: true,
				options: ["Yes", "No"],
			}),
		]);
		expect(plan.ask).toHaveLength(1);
	});

	it("declines self-identification when the field offers it, else leaves it blank", () => {
		expect(line("Gender")).toMatchObject({
			value: "Decline To Self Identify",
			source: { kind: "decline" },
			section: "Voluntary self-identification",
		});
		// No decline option and optional: left blank.
		expect(line("Veteran status")).toMatchObject({
			value: null,
			source: { kind: "blank" },
		});
		expect(line("Anything else we should know?")).toMatchObject({
			value: null,
			source: { kind: "blank" },
		});
		expect(line("Phone")).toMatchObject({ value: "+90 555 000 00 00" });
	});

	it("uses the user's own self-identification answer over the decline", () => {
		const own = planFormFields(
			SCHEMA,
			{
				...DATA,
				answers: [...DATA.answers, { question: "Gender", answer: "Female" }],
			},
			SAVED,
		);
		expect(own.fields.find((f) => f.label === "Gender")).toMatchObject({
			value: "Female",
			source: { kind: "form_answer" },
		});
	});

	it("passes only the questions nothing on file answers to the drafting model", () => {
		expect(openFormQuestions(SCHEMA, [], SAVED).map((q) => q.label)).toEqual([
			"Why do you want to work at Acme?",
			"Do you hold an active security clearance?",
			"Anything else we should know?",
		]);
	});

	it("never declines for the user on a form that was not read before review", () => {
		const live = SCHEMA.fields;
		const without = planFill(live, DATA);
		expect(without.actions.find((a) => a.label === "Gender")).toBeUndefined();
		const withSchema = planFill(live, DATA, { declineVoluntary: true });
		expect(withSchema.actions.find((a) => a.label === "Gender")).toMatchObject({
			kind: "combobox",
			value: "Decline To Self Identify",
		});
	});
});

describe("review's header names where an employer's form sends (Codex review, 2026-11-09)", () => {
	const readOf = (schema: FormSchema) =>
		whatWillBeSent(
			{ status: "read", schema, readAt: "2026-11-09T00:00:00Z" },
			DATA,
			[],
		);

	it("names the form page's host on an employer's form", () => {
		const web: FormSchema = {
			...SCHEMA,
			board: "web",
			url: "https://jobs.acme.test/apply",
			formUrl: "https://jobs.acme.test/careers/apply?id=1",
		};
		expect(readOf(web)).toMatchObject({ sendsTo: "jobs.acme.test" });
		// A read saved without the form's page: the link itself.
		expect(readOf({ ...web, formUrl: undefined })).toMatchObject({
			sendsTo: "jobs.acme.test",
		});
	});

	it("names none on a board", () => {
		expect(readOf(SCHEMA)).toMatchObject({ sendsTo: null });
	});
});

describe("the live form against the approved schema", () => {
	it("names a required question the form added since review", () => {
		const live: FormField[] = [
			...SCHEMA.fields.map(({ key: _k, page: _p, section: _s, ...f }) => ({
				...f,
				options: f.kind === "combobox" ? [] : f.options,
			})),
			{
				ref: "99",
				kind: "select",
				name: "question_9",
				label: "Will you require visa sponsorship?",
				required: true,
				options: ["Yes", "No"],
				visible: true,
			},
		];
		const aligned = alignWithSchema(live, SCHEMA.fields);
		expect(aligned.unexpected).toEqual([
			{ label: "Will you require visa sponsorship?", kind: "select" },
		]);
		// A combobox's options come from the schema (they show only when it is opened).
		expect(aligned.fields.find((f) => f.name === "gender")?.options).toEqual([
			"Male",
			"Female",
			"Decline To Self Identify",
		]);
	});

	it("lets an optional added question through, left blank", () => {
		const extra: FormField = {
			ref: "98",
			kind: "text",
			name: "question_8",
			label: "Favourite colour",
			required: false,
			options: [],
			visible: true,
		};
		expect(alignWithSchema([extra], SCHEMA.fields).unexpected).toEqual([]);
	});
});

import { describe, expect, it } from "vitest";

import { schemaKey } from "../src/apply/form-schema";
import {
	type ApplicantData,
	applyUrl,
	BOARD_CONFIGS,
	dialCode,
	exactOption,
	type FormField,
	markdownToPlain,
	planFill,
	sameQuestion,
	sessionHosts,
	verifyFilled,
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

/** Drift found on the real forms on 2026-11-09 (docs/form-inspection.md). */
describe("2026-11-09 form drift", () => {
	it("keys Ashby's EEO radios without the UUID that changes on every load", () => {
		const a = schemaKey({
			kind: "radio",
			name: "48a5ac0a-8696-4f4b-9283-3e1010d67194__systemfield_eeoc_gender",
			label: "Gender",
		});
		const b = schemaKey({
			kind: "radio",
			name: "d4a050b1-953d-41ab-9d43-fec43e7512cf__systemfield_eeoc_gender",
			label: "Gender",
		});
		expect(a).toBe("radio:_systemfield_eeoc_gender");
		expect(b).toBe(a);
		// Lever's card ids are stable and stay in the key.
		expect(
			schemaKey({
				kind: "checkbox",
				name: "cards[95e981e4-5566-4377-abbf-351be458e327][field0]",
				label: "",
			}),
		).toBe("checkbox:cards[95e981e4-5566-4377-abbf-351be458e327][field0]");
	});

	it("reads the calling code only when it is set apart", () => {
		expect(dialCode("+1 555 010 0199")).toBe("+1");
		expect(dialCode("+90 (555) 000 00 00")).toBe("+90");
		expect(dialCode("+90-555")).toBe("+90");
		expect(dialCode("+905550000000")).toBeNull();
		expect(dialCode("0555 000 00 00")).toBeNull();
	});

	it("expects Greenhouse's phone country from the number and checks what it holds", () => {
		const country = field({
			kind: "combobox",
			label: "Country",
			name: "country",
			options: ["United States +1", "Turkey +90"],
		});
		const phone = field({ label: "Phone", name: "phone" });
		const plan = planFill([country, phone], data);
		expect(plan.actions).toContainEqual({
			ref: country.ref,
			label: "Country",
			kind: "expect",
			value: "+90",
		});
		expect(plan.unknown).toEqual([]);
		const held = (value: string[]) => [
			{ ...country, current: value },
			{ ...phone, current: ["+90 555"] },
		];
		expect(verifyFilled(plan, [country, phone], held(["+90"]))).toEqual([]);
		expect(verifyFilled(plan, [country, phone], held(["Turkey +90"]))).toEqual(
			[],
		);
		expect(verifyFilled(plan, [country, phone], held(["+1"]))).toEqual([
			'"Country" holds "+1", not "+90".',
		]);
		// No calling code to read: the picker is left blank like any optional field.
		const plain = planFill([country, phone], {
			...data,
			contact: { ...data.contact, phone: "0555 000" },
		});
		expect(plain.actions.some((a) => a.ref === country.ref)).toBe(false);
		expect(plain.blank).toContain("Country");
	});

	it("checks a location exactly, and an approved answer for it wins", () => {
		const location = field({
			label: "Current location",
			name: "location",
			required: true,
		});
		const plan = planFill([location], data);
		expect(plan.actions).toEqual([
			{
				ref: location.ref,
				label: "Current location",
				kind: "location",
				value: "Izmir, Turkey",
			},
		]);
		expect(
			verifyFilled(plan, [location], [{ ...location, current: ["Izmir"] }]),
		).toEqual(['"Current location" holds "Izmir", not "Izmir, Turkey".']);
		const answered = planFill([location], {
			...data,
			answers: [
				...data.answers,
				{ question: "Current location", answer: "Izmir, Izmir, Turkey" },
			],
		});
		expect(answered.actions[0]).toMatchObject({
			kind: "location",
			value: "Izmir, Izmir, Turkey",
		});
	});
});

describe("a board's other hosts in a real submission", () => {
	it("adds the board's data hosts to the allowed ones, and its asset and scoring hosts as read-only rules", () => {
		const hosts = sessionHosts("greenhouse", ["job-boards.greenhouse.io"]);
		expect(hosts.form).toEqual([
			"job-boards.greenhouse.io",
			"email-address-validator.us.greenhouse.io",
			"grnhse-prod-jben-us-east-1.s3.amazonaws.com",
		]);
		expect(hosts.rules.read).toContain("www.recaptcha.net");
		expect(hosts.rules.read).not.toContain("job-boards.greenhouse.io");
		// Trackers are never listed: they are refused like any other host.
		expect(sessionHosts("lever", []).rules.read).not.toContain(
			"www.googletagmanager.com",
		);
	});

	it("never adds a form host: with none allowed, the form's own host is still not allowed", () => {
		for (const board of ["ashby", "greenhouse", "lever"] as const) {
			const own = new URL(
				applyUrl(board, { url: "", externalId: "1", companyKey: "acme" }),
			).hostname;
			expect(sessionHosts(board, []).form).not.toContain(own);
			expect(sessionHosts(board, []).rules.read).not.toContain(own);
		}
	});

	it("lists exact names, never a suffix many companies share", () => {
		for (const config of Object.values(BOARD_CONFIGS))
			for (const host of [
				...(config.hosts ?? []),
				...(config.formHosts ?? []),
			]) {
				expect(host).toMatch(/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/);
				if (host.startsWith("*.")) expect(host).toMatch(/\.hcaptcha\.com$/);
				expect(host).not.toMatch(
					/^(\*\.)?(s3\.amazonaws\.com|amazonaws\.com|cloudfront\.net|googleapis\.com|appspot\.com)$/,
				);
			}
	});
});

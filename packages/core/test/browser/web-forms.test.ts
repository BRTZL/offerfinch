import type { ApplicationRun } from "@offerfinch/core/apply/applier";
import { planFormFields } from "@offerfinch/core/apply/field-answers";
import type { FormSchema } from "@offerfinch/core/apply/form-schema";
import type { FormBoard } from "@offerfinch/core/apply/forms";
import {
	readApplicationForm,
	readFormOnPage,
} from "@offerfinch/core/apply/read-form";
import {
	applicantData,
	type SubmissionStore,
	submitStep,
} from "@offerfinch/core/apply/submit";
import { runWebApplication } from "@offerfinch/core/apply/web-form";
import {
	llmWebFormModel,
	type WebFormModel,
} from "@offerfinch/core/apply/web-model";
import { MemoryBlobStore } from "@offerfinch/core/export/export";
import type { PipelineDeps } from "@offerfinch/core/pipeline/ports";
import { FakeLlmProvider } from "@offerfinch/core/scoring/fake";
import {
	DESTINATION_REFUSED,
	NOT_A_DESTINATION,
} from "@offerfinch/core/scrape/browser";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fixtureBrowser, localBrowser } from "./browser";
import {
	type FixtureWebForms,
	startFixtureWebForms,
} from "./fixture-web-forms";

/**
 * Plan step 6 on local stand-ins for employers' own forms: the form is read before review with
 * nothing sent, filled from the approved plan step by step, submitted once after the claim, and
 * only a confirmation the page bears out records it applied. Fabricated applicant; only
 * 127.0.0.1 is allowed, so localhost is "another site".
 */

let forms: FixtureWebForms;
beforeAll(async () => {
	forms = await startFixtureWebForms();
});
afterAll(async () => {
	await forms?.close();
});

const urlOf = (variant: string) => `${forms.url}/web/${variant}/apply`;

const PROFILE = {
	files: [
		{
			path: "personal.md",
			content:
				"# Personal\n\n- **Name:** Ada Example\n- **Email:** ada@example.test\n- **Phone:** +90 555 000 00 00\n- **Location:** Izmir, Turkey\n- **LinkedIn:** linkedin.com/in/adaexample\n",
		},
	],
};

const ANSWERS = [
	{
		question: "Why do you want to work at Acme Robotics?",
		answer: "The robotics work matches what I build.",
	},
	{ question: "What is your notice period?", answer: "Four weeks." },
];

const fakeModel = (): WebFormModel => llmWebFormModel(new FakeLlmProvider());

async function read(variant: string, model: WebFormModel | null = fakeModel()) {
	const session = await localBrowser().openSession({
		network: "read_only",
		allowedHosts: ["127.0.0.1"],
	});
	try {
		const page = await session.newPage();
		const result = await readFormOnPage(page, "web", urlOf(variant), model);
		return { result, log: page.networkLog() };
	} finally {
		await session.close();
	}
}

async function schemaOf(variant: string): Promise<FormSchema> {
	const { result } = await read(variant);
	if (!result.ok) throw new Error(result.reason);
	return result.schema;
}

/** The plain form's read, as if the job's link (`variant`) had shown it: the live page differs. */
async function readAs(from: string, variant: string): Promise<FormSchema> {
	return { ...(await schemaOf(from)), formUrl: urlOf(variant) };
}

const data = () =>
	applicantData(
		PROFILE,
		{ formAnswers: ANSWERS, coverLetterMarkdown: "Dear team,\n\nLetter." },
		false,
	);

const CV = {
	name: "CV.pdf",
	mimeType: "application/pdf",
	buffer: new TextEncoder().encode("%PDF-1.4 cv"),
};

describe("reading an employer's form before review", () => {
	it("lists every question with a stable key, sending nothing but reads", async () => {
		const { result, log } = await read("single");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const fields = result.schema.fields.map((f) => [
			f.key,
			f.label,
			f.required,
			f.page,
		]);
		expect(fields).toEqual([
			["text:full_name", "Full name", true, 1],
			["text:email", "Email address", true, 1],
			["text:phone", "Phone number", false, 1],
			// No label, only a name: the model chose a label from the text beside it.
			["text:profile_url", "LinkedIn", false, 1],
			["text:location", "Where are you based?", false, 1],
			["textarea:why", "Why do you want to work at Acme Robotics?", true, 1],
			["text:notice", "What is your notice period?", true, 1],
			["file:cv", "Resume / CV", true, 1],
			["checkbox:news", "Send me news about future openings", false, 1],
		]);
		expect(
			result.schema.fields.find((f) => f.key === "text:profile_url"),
		).toMatchObject({ labelSource: "model" });
		expect(result.schema.submit).toBe("Submit application");
		// The form's page, where its link landed: the only host that may receive it.
		expect(result.schema.formUrl).toBe(urlOf("single"));
		expect(log.filter((r) => r.allowed && r.method !== "GET")).toEqual([]);
		expect(forms.count("single")).toBe(0);
		// The ids change on every load; the keys do not.
		const again = await schemaOf("single");
		expect(again.fields.map((f) => f.key)).toEqual(
			result.schema.fields.map((f) => f.key),
		);
	});

	it("leaves a control nothing names unlabelled without a model", async () => {
		const { result } = await read("single", null);
		if (!result.ok) throw new Error(result.reason);
		expect(
			result.schema.fields.find((f) => f.key === "text:profile_url")?.label,
		).toBe("");
	});

	it("reads a two-step form's hidden step as page 2", async () => {
		const schema = await schemaOf("two-step");
		expect(schema.fields.map((f) => [f.key, f.page])).toEqual([
			["text:full_name", 1],
			["text:email", 1],
			["text:phone", 1],
			["textarea:why", 2],
			["text:notice", 2],
			["file:cv", 2],
		]);
		expect(forms.count("two-step")).toBe(0);
	});

	it("a button outside any form is never its submit (Codex, 2026-11-09)", async () => {
		const { result } = await read("formless", null);
		if (!result.ok) throw new Error(result.reason);
		expect(result.schema.fields.map((f) => f.key)).toEqual([
			"text:email",
			"text:full_name",
		]);
		expect(result.schema.submit).toBeNull();
	});

	it("is read in preparation only where submission may go, in its own session", async () => {
		const context = {
			applicationId: "app-1",
			source: "web",
			board: "web" as const,
			boardFrom: "url" as const,
			companyKey: "acme-robotics",
			externalId: "single",
			jobUrl: urlOf("single"),
			formAnswers: [],
			coverLetterMarkdown: null,
			cvPdfKey: null,
			coverLetterPdfKey: null,
		};
		const apply = {
			store: {} as SubmissionStore,
			browser: localBrowser(),
			blobs: new MemoryBlobStore(),
			allowedHosts: ["127.0.0.1"],
		};
		const prepared = await readApplicationForm(
			apply,
			context,
			new Date(),
			fakeModel(),
		);
		expect(prepared).toMatchObject({
			status: "read",
			schema: { board: "web", url: urlOf("single") },
		});
		// Not an allowed host: no browser opens.
		expect(
			await readApplicationForm({ ...apply, allowedHosts: [] }, context),
		).toMatchObject({
			status: "skipped",
			note: expect.stringMatching(/not turned on/),
		});
	});

	it("reads a form in a frame of the same site", async () => {
		const schema = await schemaOf("framed");
		expect(schema.fields.map((f) => f.key)).toContain("textarea:why");
		expect(schema.url).toBe(urlOf("framed"));
	});

	it("gives review a value for every field, and asks the question nothing answers", async () => {
		const single = planFormFields(await schemaOf("single"), data(), []);
		expect(single.ask).toEqual([]);
		expect(
			Object.fromEntries(single.fields.map((f) => [f.label, f.value])),
		).toMatchObject({
			"Full name": "Ada Example",
			LinkedIn: "https://linkedin.com/in/adaexample",
			"Where are you based?": "Izmir, Turkey",
			"Resume / CV": "CV.pdf",
			"Send me news about future openings": null,
		});
		const unknown = planFormFields(await schemaOf("unknown"), data(), []);
		expect(unknown.ask.map((q) => q.label)).toEqual([
			"Do you hold a valid driving licence?",
		]);
	});

	it.each([
		["login", /password/],
		["code", /code sent by email or SMS/],
		["frame-away", /frame from localhost.*another site/],
	])("does not read %s: %s", async (variant, why) => {
		const { result } = await read(variant);
		expect(result).toMatchObject({
			ok: false,
			reason: expect.stringMatching(why),
		});
	});
});

describe("filling an employer's form (dry run, network closed)", () => {
	async function dryRun(variant: string, schema: FormSchema) {
		const session = await localBrowser().openSession({ network: "read_only" });
		try {
			const page = await session.newPage();
			const run: ApplicationRun = {
				board: "web",
				url: urlOf(variant),
				mode: "dry_run",
				schema: schema.fields,
				data: data(),
				files: { cv: CV, coverLetter: null },
				model: fakeModel(),
				beforeFill: () => page.restrictNetwork("none"),
			};
			const result = await runWebApplication(page, run);
			return { result, log: page.networkLog() };
		} finally {
			await session.close();
		}
	}

	it("fills a single-page form with the approved values only", async () => {
		const { result, log } = await dryRun("single", await schemaOf("single"));
		expect(result.outcome).toBe("dry_run");
		expect(
			Object.fromEntries(result.filled.map((f) => [f.label, f.value])),
		).toEqual({
			"Full name": "Ada Example",
			"Email address": "ada@example.test",
			"Phone number": "+90 555 000 00 00",
			LinkedIn: "https://linkedin.com/in/adaexample",
			"Where are you based?": "Izmir, Turkey",
			"Why do you want to work at Acme Robotics?":
				"The robotics work matches what I build.",
			"What is your notice period?": "Four weeks.",
			"Resume / CV": "CV.pdf",
		});
		expect(log.filter((r) => r.allowed && r.method !== "GET")).toEqual([]);
		expect(forms.count("single")).toBe(0);
	});

	it("walks a two-step form with Next and stops short of the submit", async () => {
		const { result } = await dryRun("two-step", await schemaOf("two-step"));
		expect(result.outcome).toBe("dry_run");
		expect(result.filled.map((f) => f.label)).toEqual([
			"Full name",
			"Email address",
			"Phone number",
			"Why do you want to work at Acme Robotics?",
			"What is your notice period?",
			"Resume / CV",
		]);
		expect(forms.count("two-step")).toBe(0);
	});
});

/* --------------------------------------------------------------- submit */

function harness(
	variant: string,
	schema: FormSchema | null,
	{
		source = "web",
		board = "web" as FormBoard | null,
		boardFrom = "url" as "url" | "source" | null,
		answers = ANSWERS,
		withModel = true,
	} = {},
) {
	const blobs = new MemoryBlobStore();
	void blobs.put("cv.pdf", CV.buffer, "application/pdf");
	const calls: {
		method: string;
		reason?: string;
		key?: string | null;
		submitted?: boolean;
	}[] = [];
	const store = {
		submissionsPaused: async () => false,
		resolveInterrupted: async () => false,
		submissionContext: async () => ({
			applicationId: "app-1",
			source,
			board,
			boardFrom,
			companyKey: "acme-robotics",
			externalId: variant,
			jobUrl: urlOf(variant),
			formAnswers: answers,
			coverLetterMarkdown: "Dear team,\n\nLetter.",
			cvPdfKey: "cv.pdf",
			coverLetterPdfKey: null,
		}),
		formRead: async () =>
			schema
				? { status: "read" as const, schema, readAt: "2026-11-09T00:00:00Z" }
				: null,
		claimSubmission: vi.fn(async (_u, _a, input) => {
			calls.push({ method: "claim", key: input.beforeKey });
			return { go: true as const, attemptId: "attempt-1" };
		}),
		finishSubmission: vi.fn(async (_u, _a, _id, input) => {
			calls.push({
				method: "finish",
				reason: input.reason,
				key: input.afterKey,
				submitted: input.submitted,
			});
		}),
		stopSubmission: vi.fn(async (_u, _a, input) => {
			calls.push({ method: "stop", reason: input.reason });
		}),
		stopForQuestions: vi.fn(async (_u, _a, input) => {
			calls.push({ method: "questions", reason: input.reason });
			return { asked: input.questions.length, reused: 0 };
		}),
		recordDryRun: vi.fn(async () => "dry"),
		savedAnswers: async () => [],
		handOverStuck: async () => [],
		beginSubmission: async () => ({ outcome: "started" as const }),
	} satisfies SubmissionStore;
	const deps = {
		repo: {
			getState: async () => "applying",
			getProfile: async () => PROFILE,
		},
		...(withModel ? { llm: new FakeLlmProvider() } : {}),
		apply: {
			store,
			browser: fixtureBrowser(),
			blobs,
			allowedHosts: ["127.0.0.1"],
		},
	} as unknown as PipelineDeps;
	return { deps, calls, blobs };
}

describe("submitting an employer's form", () => {
	it.each(["single", "two-step"])(
		"%s: fills, submits once after the claim, with screenshots before and after",
		async (variant) => {
			const { deps, calls, blobs } = harness(variant, await schemaOf(variant));
			const outcome = await submitStep(deps, "u1", "app-1");
			expect(outcome).toMatchObject({ outcome: "applied" });
			expect(forms.count(variant)).toBe(1);
			expect(calls.map((c) => c.method)).toEqual(["claim", "finish"]);
			expect(calls[1]?.reason).toMatch(
				/^Submitted; the employer's page confirmed: "Thank you for/,
			);
			for (const c of calls) {
				expect(c.key).toBeTruthy();
				expect(await blobs.get(c.key ?? "")).not.toBeNull();
			}
			// Only the reviewed fields' values were sent.
			const sent = forms.submissions.find((s) => s.variant === variant);
			expect(sent?.body).toContain("Four weeks.");
			expect(sent?.fields).not.toContain("company_website_filled");
			expect(forms.away).toEqual([]);
		},
		60_000,
	);

	it.each([
		// No control has a name; one box has no label either (only text beside it).
		["nameless", /^This form has unlabelled fields; finish it yourself\.$/],
		// Two boxes under "Contact details" with no name, id or label (Codex re-review, 2026-11-09).
		["shifted", /^This form has unlabelled fields; finish it yourself\.$/],
		["contact-swap", /^This form has unlabelled fields; finish it yourself\.$/],
		// Two boxes with one name.
		[
			"twin-keys",
			/^This form has fields that share one name or label; finish it yourself\.$/,
		],
	])(
		"%s: a field with nothing of its own is a hand-off at read time (Codex re-review, 2026-11-09)",
		async (variant, why) => {
			const { result } = await read(variant);
			expect(result).toMatchObject({
				ok: false,
				reason: expect.stringMatching(why),
			});
			expect(forms.count(variant)).toBe(0);
		},
	);

	it("swapped nameless boxes never take each other's value: the run stops before the claim (Codex re-review, 2026-11-09)", async () => {
		// The read Codex's case gave before this fix: both boxes keyed by their place.
		const schema = await readAs("single", "contact-swap");
		const field = (name: string, label: string) => ({
			ref: name,
			kind: "text" as const,
			label,
			required: false,
			name,
			options: [],
			visible: true,
			current: [],
			section: "",
			key: `text:${name}`,
			page: 1,
			// What the read kept for a place key before this fix.
			...(name.startsWith("#")
				? { hint: "Contact details", autocomplete: "" }
				: {}),
		});
		const { deps, calls } = harness("contact-swap", {
			...schema,
			fields: [
				{ ...field("full_name", "Full name"), required: true },
				field("#text-1", "Email"),
				field("#text-2", "Phone"),
			],
		});
		const outcome = await submitStep(deps, "u1", "app-1");
		expect(outcome).toMatchObject({
			outcome: "needs_human",
			reason: expect.stringMatching(
				/^This form has unlabelled fields; finish it yourself\./,
			),
		});
		expect(calls.map((c) => c.method)).toEqual(["stop"]);
		expect(forms.count("contact-swap")).toBe(0);
	}, 60_000);

	it("a box with nothing of its own that appears after review stops the run before the claim (Codex re-review, 2026-11-09)", async () => {
		const schema = await schemaOf("adds-unlabelled");
		expect(schema.fields.map((f) => f.key)).toEqual([
			"text:email",
			"text:full_name",
		]);
		const { deps, calls } = harness("adds-unlabelled", schema);
		const outcome = await submitStep(deps, "u1", "app-1");
		expect(outcome).toMatchObject({
			outcome: "needs_human",
			reason: expect.stringMatching(
				/^This form has unlabelled fields; finish it yourself\./,
			),
		});
		expect(calls.map((c) => c.method)).toEqual(["stop"]);
		expect(forms.count("adds-unlabelled")).toBe(0);
	}, 60_000);

	it("a changed box is never paired with a reviewed one by the model (Codex, 2026-11-09)", async () => {
		// Read with the email box; at submit an optional "Promo code" box stands in its place.
		const schema = await schemaOf("swapped");
		expect(schema.fields.map((f) => f.key)).toEqual([
			"text:email",
			"text:full_name",
		]);
		const pairing = {
			...fakeModel(),
			// A model that pairs every changed box with the reviewed email.
			match: async (request: { live: { ref: string }[] }) =>
				request.live.map((l) => ({ ref: l.ref, key: "text:email" })),
		} as unknown as WebFormModel;
		const session = await fixtureBrowser().openSession({
			network: "allowlist",
			allowedHosts: ["127.0.0.1"],
		});
		try {
			const page = await session.newPage();
			const result = await runWebApplication(page, {
				board: "web",
				url: urlOf("swapped"),
				mode: "submit",
				schema: schema.fields,
				data: data(),
				files: { cv: CV, coverLetter: null },
				model: pairing,
				allowedHosts: ["127.0.0.1"],
				claim: async () => ({ go: true }),
			});
			expect(result.filled.map((f) => f.label)).toEqual(["Full name"]);
		} finally {
			await session.close();
		}
		const sent = forms.submissions.find((s) => s.variant === "swapped");
		expect(sent?.body).toBe("promo=&full_name=Ada+Example");
	}, 60_000);

	it("an ambiguous page after the click is an unknown outcome, never a retry", async () => {
		const { deps, calls } = harness("ambiguous", await schemaOf("ambiguous"));
		const outcome = await submitStep(deps, "u1", "app-1");
		expect(outcome).toMatchObject({
			outcome: "needs_human",
			reason: expect.stringMatching(
				/does not say the application was received/,
			),
		});
		expect(forms.count("ambiguous")).toBe(1);
		expect(calls.map((c) => c.method)).toEqual(["claim", "finish"]);
		expect(calls[1]?.submitted).toBe(false);
	}, 60_000);

	it("without a model, a changed page is unknown", async () => {
		const { deps } = harness("single", await schemaOf("single"), {
			withModel: false,
		});
		const before = forms.count("single");
		const outcome = await submitStep(deps, "u1", "app-1");
		expect(outcome).toMatchObject({
			outcome: "needs_human",
			reason: expect.stringMatching(/no model was available/),
		});
		expect(forms.count("single")).toBe(before + 1);
	}, 60_000);

	it("a confirmation quote the page does not show is not believed", async () => {
		const schema = await schemaOf("single");
		const liar: WebFormModel = {
			...fakeModel(),
			outcome: async () => ({
				verdict: "confirmed",
				quote: "Thank you for applying to Example Corp",
			}),
		};
		const session = await fixtureBrowser().openSession({
			network: "allowlist",
			allowedHosts: ["127.0.0.1"],
		});
		try {
			const page = await session.newPage();
			const result = await runWebApplication(page, {
				board: "web",
				url: urlOf("single"),
				mode: "submit",
				schema: schema.fields,
				data: data(),
				files: { cv: CV, coverLetter: null },
				model: liar,
				allowedHosts: ["127.0.0.1"],
				claim: async () => ({ go: true }),
			});
			expect(result).toMatchObject({
				outcome: "unknown",
				reason: expect.stringMatching(/does not bear out/),
			});
		} finally {
			await session.close();
		}
	}, 60_000);

	it("a model that says confirmed while the form stays on the page is not believed", async () => {
		const schema = await schemaOf("stays");
		const liar: WebFormModel = {
			...fakeModel(),
			outcome: async () => ({
				verdict: "confirmed",
				quote: "Thank you for applying!",
			}),
		};
		const session = await fixtureBrowser().openSession({
			network: "allowlist",
			allowedHosts: ["127.0.0.1"],
		});
		try {
			const page = await session.newPage();
			const result = await runWebApplication(page, {
				board: "web",
				url: urlOf("stays"),
				mode: "submit",
				schema: schema.fields,
				data: data(),
				files: { cv: CV, coverLetter: null },
				model: liar,
				allowedHosts: ["127.0.0.1"],
				confirmTimeoutMs: 3_000,
				claim: async () => ({ go: true }),
			});
			expect(result).toMatchObject({
				outcome: "unknown",
				reason: expect.stringMatching(/the form is still on the page/),
			});
			expect(forms.count("stays")).toBe(1);
		} finally {
			await session.close();
		}
	}, 60_000);
});

describe("a step that may send answers waits for the claim (Codex, 2026-11-09)", () => {
	async function runNext(claim: ApplicationRun["claim"]) {
		const schema = await schemaOf("posting-next");
		const session = await fixtureBrowser().openSession({
			network: "allowlist",
			allowedHosts: ["127.0.0.1"],
		});
		try {
			const page = await session.newPage();
			return await runWebApplication(page, {
				board: "web",
				url: urlOf("posting-next"),
				mode: "submit",
				schema: schema.fields,
				data: data(),
				files: { cv: CV, coverLetter: null },
				model: fakeModel(),
				allowedHosts: ["127.0.0.1"],
				confirmTimeoutMs: 3_000,
				claim,
			});
		} finally {
			await session.close();
		}
	}

	it("a refused claim before the first Next sends nothing", async () => {
		const schema = await schemaOf("posting-next");
		expect(schema.fields.map((f) => [f.key, f.page])).toEqual([
			["text:email", 1],
			["text:full_name", 1],
			["text:phone", 2],
			["text:location", 2],
		]);
		const claim = vi.fn(async () => ({
			go: false as const,
			reason: "Submissions are paused.",
		}));
		const result = await runNext(claim);
		expect(result).toMatchObject({ outcome: "not_claimed" });
		expect(claim).toHaveBeenCalledTimes(1);
		expect(forms.count("posting-next")).toBe(0);
	}, 60_000);

	it("after the claim, a step that ends the run is an unknown outcome, never a plain stop", async () => {
		const { deps, calls } = harness(
			"posting-next",
			await schemaOf("posting-next"),
		);
		const outcome = await submitStep(deps, "u1", "app-1");
		expect(outcome).toMatchObject({
			outcome: "needs_human",
			reason: expect.stringMatching(
				/^Outcome unknown .*Step 2 of the form showed no questions.*"Next" was clicked/,
			),
		});
		expect(calls.map((c) => c.method)).toEqual(["claim", "finish"]);
		expect(calls[1]?.submitted).toBe(false);
		expect(forms.count("posting-next")).toBe(1);
	}, 60_000);

	it("a pause after the first Next ends the run as unknown, with no further click", async () => {
		const { deps, calls } = harness("two-step", await schemaOf("two-step"));
		const store = deps.apply?.store;
		if (!store) throw new Error("no store");
		// Not paused when the form opens; paused at the next check, on step 2 (after the claim).
		let checks = 0;
		store.submissionsPaused = async () => ++checks > 1;
		const before = forms.count("two-step");
		const outcome = await submitStep(deps, "u1", "app-1");
		expect(outcome).toMatchObject({
			outcome: "needs_human",
			reason: expect.stringMatching(
				/^Outcome unknown .*Submissions were paused before .*"Next" was clicked/,
			),
		});
		expect(calls.map((c) => c.method)).toEqual(["claim", "finish"]);
		expect(forms.count("two-step")).toBe(before);
	}, 60_000);
});

describe("files from another host are fixed before the first keystroke (Codex, 2026-11-09)", () => {
	it("only a file loaded with the page loads again; a new path is refused quietly", async () => {
		const schema = await schemaOf("assets");
		const session = await fixtureBrowser().openSession({
			network: "allowlist",
			allowedHosts: ["127.0.0.1"],
			hostRules: { assets: ["localhost"] },
			formValues: ["Ada Example", "ada@example.test", "Izmir, Turkey"],
		});
		const awayBefore = forms.away.length;
		try {
			const page = await session.newPage();
			const result = await runWebApplication(page, {
				board: "web",
				url: urlOf("assets"),
				mode: "submit",
				schema: schema.fields,
				data: data(),
				files: { cv: CV, coverLetter: null },
				model: fakeModel(),
				allowedHosts: ["127.0.0.1"],
				claim: async () => ({ go: true }),
			});
			expect(result.outcome === "stopped" ? result.stop : null).toBeNull();
			expect(result.outcome).toBe("submitted");
			const log = page.networkLog();
			// The pieces were tried, and refused without stopping the run.
			expect(
				log.filter(
					(r) => r.reason === NOT_A_DESTINATION && r.url.endsWith(".png"),
				).length,
			).toBeGreaterThan(0);
			expect(log.filter((r) => r.reason === DESTINATION_REFUSED)).toEqual([]);
		} finally {
			await session.close();
		}
		const reached = new Set(
			forms.away.slice(awayBefore).map((a) => `${a.method} ${a.path}`),
		);
		expect([...reached]).toEqual(["GET /web/assets/logo.png"]);
	}, 60_000);
});

describe("what counts as a confirmation on an employer's form (Codex, 2026-11-09)", () => {
	it.each([
		// The button only changed the query string: nothing was sent, the form stayed.
		["preview", 0, /the form is still on the page/],
		// Posted and the form went, but the thank-you words were on the page before the click.
		["echo", 1, /does not bear out/],
		// A new thank-you replaced the form, but nothing was sent.
		["silent", 0, /sent nothing/],
	])(
		"%s: not a confirmation without a send, a new page and new words",
		async (variant, posts, why) => {
			const { deps, calls } = harness(variant, await schemaOf(variant));
			const outcome = await submitStep(deps, "u1", "app-1");
			expect(outcome).toMatchObject({
				outcome: "needs_human",
				reason: expect.stringMatching(why),
			});
			expect(calls.map((c) => c.method)).toEqual(["claim", "finish"]);
			expect(calls[1]?.submitted).toBe(false);
			expect(forms.count(variant)).toBe(posts);
		},
		60_000,
	);
});

describe("stops on an employer's form: nothing is sent", () => {
	it("stops when the live form asks a required question review never listed", async () => {
		const { deps, calls } = harness(
			"unknown",
			await readAs("single", "unknown"),
		);
		const outcome = await submitStep(deps, "u1", "app-1");
		expect(outcome).toMatchObject({
			outcome: "needs_human",
			reason: expect.stringMatching(
				/driving licence.*not in the approved list/,
			),
		});
		expect(calls.map((c) => c.method)).toEqual(["stop"]);
		expect(forms.count("unknown")).toBe(0);
	}, 60_000);

	it("asks a reviewed required question that has no approved answer", async () => {
		const { deps, calls } = harness("unknown", await schemaOf("unknown"));
		const outcome = await submitStep(deps, "u1", "app-1");
		expect(outcome).toMatchObject({ outcome: "needs_human" });
		expect(calls.map((c) => c.method)).toEqual(["questions"]);
		expect(forms.count("unknown")).toBe(0);
	}, 60_000);

	it.each([
		["login", /password/],
		["code", /code sent by email or SMS/],
		["frame-away", /frame from localhost/],
	])(
		"%s: hands it to the user",
		async (variant, why) => {
			// The schema of the plain form: the live page is what stops the run.
			const { deps, calls } = harness(variant, await readAs("single", variant));
			const outcome = await submitStep(deps, "u1", "app-1");
			expect(outcome).toMatchObject({
				outcome: "needs_human",
				reason: expect.stringMatching(why),
			});
			expect(calls.map((c) => c.method)).toEqual(["stop"]);
			expect(forms.count(variant)).toBe(0);
			expect(forms.away.filter((a) => a.method === "POST")).toEqual([]);
		},
		60_000,
	);

	it("stops when the CV is uploaded to another site, before the claim", async () => {
		const { deps, calls } = harness(
			"upload-away",
			await schemaOf("upload-away"),
		);
		const outcome = await submitStep(deps, "u1", "app-1");
		expect(outcome).toMatchObject({
			outcome: "needs_human",
			reason: expect.stringMatching(/localhost/),
		});
		expect(calls.map((c) => c.method)).toEqual(["stop"]);
		expect(forms.away.filter((a) => a.method === "POST")).toEqual([]);
		expect(forms.count("upload-away")).toBe(0);
	}, 60_000);

	it("stops before opening a browser when the form was never read", async () => {
		const { deps, calls } = harness("single", null);
		const before = forms.count("single");
		const outcome = await submitStep(deps, "u1", "app-1");
		expect(outcome).toMatchObject({
			outcome: "needs_human",
			reason: expect.stringMatching(/not read before review/),
		});
		expect(calls.map((c) => c.method)).toEqual(["stop"]);
		expect(forms.count("single")).toBe(before);
	}, 60_000);

	it.each([
		["linkedin", null, null, /Easy Apply is never used/],
		["manual", "web", "url", /Added by hand/],
		["sample", "web", "url", /sample job/],
	] as const)(
		"sends nothing for a %s job",
		async (source, board, boardFrom, why) => {
			const { deps, calls } = harness("single", await schemaOf("single"), {
				source,
				board,
				boardFrom,
			});
			const before = forms.count("single");
			const outcome = await submitStep(deps, "u1", "app-1");
			expect(outcome).toMatchObject({
				outcome: "needs_human",
				reason: expect.stringMatching(why),
			});
			expect(calls.map((c) => c.method)).toEqual(["stop"]);
			expect(forms.count("single")).toBe(before);
		},
		60_000,
	);
});

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
	type ApplicationRun,
	runApplication,
} from "@offerfinch/core/apply/applier";
import { planFormFields } from "@offerfinch/core/apply/field-answers";
import type { FormSchema } from "@offerfinch/core/apply/form-schema";
import { applyUrl, type Board } from "@offerfinch/core/apply/forms";
import {
	readApplicationForm,
	readFormOnPage,
} from "@offerfinch/core/apply/read-form";
import type {
	ApplyDeps,
	SubmissionContext,
} from "@offerfinch/core/apply/submit";
import { MemoryBlobStore } from "@offerfinch/core/export/export";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { localBrowser } from "./browser";
import { type FixtureBoards, startFixtureBoards } from "./fixture-boards";

/**
 * The form reader (docs/auto-apply-plan.md, step 2) on the local fixture boards: every field is
 * read with the network read-only, nothing but GETs leaves while loading, and nothing at all once
 * the form is scanned. At submit time the saved schema is what the run may answer.
 */

let boards: FixtureBoards;
beforeAll(async () => {
	boards = await startFixtureBoards();
});
afterAll(async () => {
	await boards?.close();
});

const urlFor = (board: Board, jobId: string) =>
	applyUrl(
		board,
		{ url: "", externalId: jobId, companyKey: "acme-robotics" },
		{ [board]: `${boards.url}/${board}` },
	);

async function readOn(board: Board, jobId: string) {
	const session = await localBrowser().openSession({ network: "read_only" });
	try {
		const page = await session.newPage();
		const result = await readFormOnPage(page, board, urlFor(board, jobId));
		return { result, log: page.networkLog() };
	} finally {
		await session.close();
	}
}

const WHY = "Why do you want to work at Acme Robotics?";
const NOTICE = "What is your notice period?";

/** [key, label, required, options, section] per board, as the fixtures render them. */
const EXPECTED: Record<
	"ashby" | "greenhouse" | "lever",
	[string, string, boolean, string[], string][]
> = {
	ashby: [
		["text:_systemfield_name", "Name", true, [], ""],
		["text:_systemfield_email", "Email", true, [], ""],
		["file:_systemfield_resume", "Resume", true, [], ""],
		["text:phone", "Phone", false, [], ""],
		["file:cover_letter", "Cover Letter", false, [], ""],
		["text:question_101", "LinkedIn Profile", false, [], ""],
		["textarea:question_102", WHY, true, [], ""],
		["text:question_103", NOTICE, true, [], ""],
		[
			// The per-load UUID in front of the control name is not part of the key.
			"radio:_systemfield_eeoc_gender",
			"Gender",
			false,
			["Male", "Female", "Decline to self-identify"],
			"Voluntary self-identification",
		],
	],
	greenhouse: [
		["text:first_name", "First Name", true, [], ""],
		["text:last_name", "Last Name", true, [], ""],
		["text:email", "Email", true, [], ""],
		[
			"combobox:country",
			"Country",
			false,
			["United States +1", "Canada +1", "Turkey +90"],
			"",
		],
		["text:phone", "Phone", false, [], ""],
		["file:resume", "Resume/CV", true, [], ""],
		["file:cover_letter", "Cover Letter", false, [], ""],
		["text:question_201", "LinkedIn Profile", false, [], ""],
		["text:question_202", WHY, true, [], ""],
		["text:question_203", NOTICE, true, [], ""],
		[
			"combobox:gender",
			"Gender",
			false,
			// A combobox lists its options only when opened: read with the network closed.
			["Male", "Female", "Decline To Self Identify"],
			"Voluntary self-identification",
		],
	],
	lever: [
		["file:resume", "Resume/CV", true, [], ""],
		["text:name", "Full name", true, [], ""],
		["text:email", "Email", true, [], ""],
		["text:phone", "Phone", false, [], ""],
		["text:location", "Current location", true, [], ""],
		["text:urls[LinkedIn]", "LinkedIn URL", false, [], ""],
		["text:urls[GitHub]", "GitHub URL", false, [], ""],
		["textarea:cards[c1][field0]", WHY, true, [], ""],
		["text:cards[c1][field1]", NOTICE, true, [], ""],
		["textarea:comments", "Additional information", false, [], ""],
	],
};

const DATA: ApplicationRun["data"] = {
	contact: {
		name: "Ada Example",
		email: "ada@example.test",
		phone: "+90 555 000 00 00",
		location: "Izmir, Turkey",
		linkedin: "linkedin.com/in/adaexample",
		website: "",
		github: "github.com/adaexample",
	},
	answers: [
		{ question: WHY, answer: "The robotics work matches what I build." },
		{ question: NOTICE, answer: "Four weeks." },
	],
	coverLetterText: "Dear Hiring Team,\n\nLetter body.",
	hasCoverLetterFile: true,
};

const pdf = (name: string) => ({
	name,
	mimeType: "application/pdf",
	buffer: new TextEncoder().encode("%PDF-1.4 fixture"),
});

function run(board: Board, jobId: string, schema: FormSchema): ApplicationRun {
	return {
		board,
		mode: "submit",
		url: urlFor(board, jobId),
		data: DATA,
		files: { cv: pdf("cv.pdf"), coverLetter: pdf("cover-letter.pdf") },
		schema: schema.fields,
		claim: async () => ({ go: true }),
		confirmTimeoutMs: 3_000,
	};
}

async function submit(board: Board, jobId: string, schema: FormSchema) {
	const session = await localBrowser().openSession({ network: "open" });
	try {
		return await runApplication(
			await session.newPage(),
			run(board, jobId, schema),
		);
	} finally {
		await session.close();
	}
}

describe.each(["ashby", "greenhouse", "lever"] as const)(
	"%s form reader",
	(board) => {
		it("reads every field, the files and the submit control, sending nothing", async () => {
			const { result, log } = await readOn(board, `${board}-ok`);
			expect(result.ok, JSON.stringify(result)).toBe(true);
			if (!result.ok) return;
			expect(
				result.schema.fields.map((f) => [
					f.key,
					f.label,
					f.required,
					f.options,
					f.section,
				]),
			).toEqual(EXPECTED[board]);
			expect(result.schema.fields.every((f) => f.page === 1)).toBe(true);
			expect(result.schema.submit).toMatch(/^Submit application$/i);
			// Only reads while loading; nothing at all after the network closed.
			expect(log.filter((r) => r.allowed && r.method !== "GET")).toEqual([]);
			expect(boards.count(`${board}-ok`)).toBe(0);
		}, 60_000);

		it("stops a submission whose form added a required question since review", async () => {
			const { result } = await readOn(board, `${board}-ok`);
			if (!result.ok) throw new Error(result.reason);
			const jobId = `${board}-unknown`;
			const outcome = await submit(board, jobId, result.schema);
			expect(outcome.outcome).toBe("stopped");
			if (outcome.outcome !== "stopped") return;
			expect(outcome.stop.kind).toBe("form_changed");
			expect(outcome.stop.message).toMatch(/sponsorship|relocate/i);
			expect(outcome.filled).toEqual([]);
			expect(boards.count(jobId)).toBe(0);
		}, 60_000);
	},
);

describe("what is sent is what review listed", () => {
	it("an optional field the review did not list stays empty", async () => {
		const { result } = await readOn("greenhouse", "greenhouse-ok");
		if (!result.ok) throw new Error(result.reason);
		const phone = result.schema.fields.find((f) => f.name === "phone");
		expect(phone, "the fixture asks for a phone").toBeDefined();
		const reviewed = {
			...result.schema,
			fields: result.schema.fields.filter((f) => f.name !== "phone"),
		};
		const jobId = "greenhouse-unlisted";
		const outcome = await submit("greenhouse", jobId, reviewed);
		expect(outcome.outcome, JSON.stringify(outcome)).toBe("submitted");
		const sent = boards.submissions.find((s) => s.path.includes(`/${jobId}/`));
		expect(sent?.values.phone ?? [""]).toEqual([""]);
	}, 60_000);

	it.each(["ashby", "greenhouse"] as const)(
		"%s: the self-identification question gets its decline option, as listed",
		async (board) => {
			const { result } = await readOn(board, `${board}-ok`);
			if (!result.ok) throw new Error(result.reason);
			const listed = planFormFields(result.schema, DATA, []);
			const gender = listed.fields.find((f) => f.label === "Gender");
			expect(gender?.source).toEqual({ kind: "decline" });
			expect(listed.ask).toEqual([]);
			const jobId = `${board}-listed`;
			const outcome = await submit(board, jobId, result.schema);
			expect(outcome.outcome, JSON.stringify(outcome)).toBe("submitted");
			const sent = boards.submissions.find((s) =>
				s.path.includes(`/${jobId}/`),
			);
			// Ashby's control name changes on every load (a UUID in front).
			const name = Object.keys(sent?.values ?? {}).find((n) =>
				board === "ashby"
					? n.endsWith("__systemfield_eeoc_gender")
					: n === "gender",
			);
			expect(name).toBeDefined();
			expect(sent?.values[name ?? ""]).toEqual([gender?.value]);
			// Every value sent is a value the list showed.
			for (const line of listed.fields.filter(
				(f) => f.value && f.kind !== "file",
			))
				expect(Object.values(sent?.values ?? {}).flat()).toContain(line.value);
		},
		60_000,
	);
});

describe("reading before review: the gates", () => {
	const context = (board: Board, jobId: string): SubmissionContext => ({
		applicationId: "app-1",
		source: board,
		board,
		companyKey: "acme-robotics",
		externalId: jobId,
		jobUrl: "",
		formAnswers: [],
		coverLetterMarkdown: null,
		cvPdfKey: null,
		coverLetterPdfKey: null,
	});
	const apply = (
		bases: ApplyDeps["boardBases"],
		opened: { n: number },
	): ApplyDeps => {
		const browser = localBrowser();
		return {
			store: {} as ApplyDeps["store"],
			blobs: new MemoryBlobStore(),
			allowedHosts: ["127.0.0.1"],
			fixtures: true,
			boardBases: bases,
			browser: {
				name: browser.name,
				openSession: (options) => {
					opened.n++;
					return browser.openSession(options);
				},
			},
		};
	};

	it("records a challenge as a failed read with its reason", async () => {
		const opened = { n: 0 };
		const read = await readApplicationForm(
			apply({ greenhouse: `${boards.url}/greenhouse` }, opened),
			context("greenhouse", "greenhouse-captcha"),
		);
		expect(read).toMatchObject({
			status: "failed",
			note: expect.stringMatching(
				/could not be read before review: .*challenge/i,
			),
		});
		expect(opened.n).toBe(1);
	}, 60_000);

	it("never opens a browser for a host submission may not use", async () => {
		const opened = { n: 0 };
		// No fixture base: the real board host, which is not allowed.
		const read = await readApplicationForm(
			apply(undefined, opened),
			context("lever", "x"),
		);
		expect(read).toMatchObject({
			status: "skipped",
			note: expect.stringContaining("jobs.lever.co"),
		});
		expect(opened.n).toBe(0);
	});

	it("refuses a redirect to a host submission may not use", async () => {
		// 127.0.0.1 is allowed; the form it redirects to sits on localhost, which is not.
		const away = boards.url.replace("127.0.0.1", "localhost");
		const server = createServer((req, res) => {
			res.writeHead(302, { location: `${away}${req.url ?? ""}` });
			res.end();
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const port = (server.address() as AddressInfo).port;
		const reached: string[] = [];
		const record = (req: { headers: { host?: string }; url?: string }) => {
			if (req.headers.host?.startsWith("localhost"))
				reached.push(req.url ?? "");
		};
		boards.server.on("request", record);
		try {
			const read = await readApplicationForm(
				apply(
					{ greenhouse: `http://127.0.0.1:${port}/greenhouse` },
					{
						n: 0,
					},
				),
				context("greenhouse", "greenhouse-ok"),
			);
			expect(read.status).toBe("failed");
			expect(reached).toEqual([]);
		} finally {
			boards.server.off("request", record);
			server.close();
		}
	}, 60_000);

	it("never reads a hand-off source's form", async () => {
		const opened = { n: 0 };
		const read = await readApplicationForm(
			apply({ greenhouse: `${boards.url}/greenhouse` }, opened),
			{ ...context("greenhouse", "greenhouse-ok"), source: "linkedin" },
		);
		expect(read.status).toBe("skipped");
		expect(opened.n).toBe(0);
	});
});

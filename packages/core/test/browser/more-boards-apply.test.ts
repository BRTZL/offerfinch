import {
	type ApplicationRun,
	runApplication,
} from "@offerfinch/core/apply/applier";
import { applyUrl, type Board } from "@offerfinch/core/apply/forms";
import { readFormOnPage } from "@offerfinch/core/apply/read-form";
import {
	type SubmissionStore,
	submitStep,
} from "@offerfinch/core/apply/submit";
import { MemoryBlobStore } from "@offerfinch/core/export/export";
import type { PipelineDeps } from "@offerfinch/core/pipeline/ports";
import { PlaywrightBrowserProvider } from "@offerfinch/core/scrape/browser";
import { USER_AGENT } from "@offerfinch/core/sources/types";
import type { FormAnswer } from "@offerfinch/core/tailor/tailor";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromePath, localBrowser } from "./browser";
import {
	type MoreFixtureBoards,
	startMoreFixtureBoards,
} from "./fixture-more-boards";

/**
 * Workable, Recruitee, Teamtailor and Personio on their local stand-ins (docs/auto-apply-plan.md,
 * step 5): the form is read before review, filled from approved data only, submitted once with
 * screenshots before and after, and every stop sends nothing.
 */

const NEW_BOARDS = ["workable", "recruitee", "teamtailor", "personio"] as const;

/**
 * Boards whose confirmation element is known (Workable's `successful-submit`, Recruitee's success
 * panel). Teamtailor's and Personio's confirmation pages were never seen, so their submissions end
 * as unknown outcomes until a watched submission records them.
 */
const CONFIRMS = new Set<string>(["workable", "recruitee"]);

let boards: MoreFixtureBoards;
beforeAll(async () => {
	boards = await startMoreFixtureBoards();
});
afterAll(async () => {
	await boards?.close();
});

/** Headless Chromium without Local Network Access checks, so a request to localhost is attempted. */
const fixtureBrowser = () =>
	new PlaywrightBrowserProvider(
		"fixture-playwright",
		() =>
			chromium.launch({
				headless: true,
				executablePath: chromePath,
				args: [
					"--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights",
				],
			}),
		USER_AGENT,
	);

/** Each board's privacy consent: the question as the form labels it, and its one option. */
const CONSENT: Record<(typeof NEW_BOARDS)[number], FormAnswer | null> = {
	workable: {
		question: "I have read and accept the Privacy Notice.",
		answer: "I have read and accept the Privacy Notice.",
	},
	recruitee: {
		question: "Your personal data",
		answer: "I agree that Acme Robotics keeps my data for 90 days.",
	},
	teamtailor: {
		question:
			"I have read the Privacy Policy and agree that Acme Robotics stores my data.",
		answer:
			"I have read the Privacy Policy and agree that Acme Robotics stores my data.",
	},
	personio: null,
};

const answersFor = (board: (typeof NEW_BOARDS)[number]): FormAnswer[] => [
	{
		question: "Why do you want to work at Acme Robotics?",
		answer: "The robotics work matches what I build.",
	},
	{ question: "What is your notice period?", answer: "Four weeks." },
	{ question: "Will you require visa sponsorship?", answer: "No" },
	...(CONSENT[board] ? [CONSENT[board]] : []),
];

const externalId = (board: Board, jobId: string) =>
	board === "recruitee" ? `acme-robotics:${jobId}` : jobId;

const urlFor = (board: Board, jobId: string) =>
	applyUrl(
		board,
		{
			url: "",
			externalId: externalId(board, jobId),
			companyKey: "acme-robotics",
		},
		{ [board]: `${boards.url}/${board}` },
	);

const pdf = (name: string) => ({
	name,
	mimeType: "application/pdf",
	buffer: new TextEncoder().encode("%PDF-1.4 fixture"),
});

function run(
	board: (typeof NEW_BOARDS)[number],
	jobId: string,
	mode: ApplicationRun["mode"] = "submit",
): ApplicationRun {
	return {
		board,
		mode,
		url: urlFor(board, jobId),
		data: {
			contact: {
				name: "Ada Example",
				email: "ada@example.test",
				phone: "+90 555 000 00 00",
				location: "Izmir, Turkey",
				linkedin: "linkedin.com/in/adaexample",
				website: "",
				github: "github.com/adaexample",
			},
			answers: answersFor(board),
			coverLetterText: "Dear Hiring Team,\n\nLetter body.",
			hasCoverLetterFile: true,
		},
		files: { cv: pdf("cv.pdf"), coverLetter: pdf("cover-letter.pdf") },
		claim: async () => ({ go: true }),
		confirmTimeoutMs: 3_000,
	};
}

type Page = Awaited<
	ReturnType<
		Awaited<
			ReturnType<ReturnType<typeof localBrowser>["openSession"]>
		>["newPage"]
	>
>;

async function withPage<T>(
	network: "open" | "read_only",
	fn: (page: Page) => Promise<T>,
): Promise<T> {
	const session = await localBrowser().openSession({ network });
	try {
		return await fn(await session.newPage());
	} finally {
		await session.close();
	}
}

const PROFILE = {
	files: [
		{
			path: "personal.md",
			content:
				"# Personal\n\n- **Name:** Ada Example\n- **Email:** ada@example.test\n- **Phone:** +90 555 000 00 00\n- **Location:** Izmir, Turkey\n- **LinkedIn:** linkedin.com/in/adaexample\n",
		},
	],
};

/** The submission path end to end (submitStep), with only 127.0.0.1 allowed. */
function harness(
	board: (typeof NEW_BOARDS)[number],
	jobId: string,
	source: string = board,
) {
	const blobs = new MemoryBlobStore();
	void blobs.put("cv.pdf", new TextEncoder().encode("%PDF-1.4 cv"), "x");
	const calls: { method: string; reason?: string; key?: string | null }[] = [];
	const store = {
		submissionsPaused: async () => false,
		resolveInterrupted: async () => false,
		submissionContext: async () => ({
			applicationId: "app-1",
			source,
			board,
			companyKey: "acme-robotics",
			externalId: externalId(board, jobId),
			jobUrl: "",
			formAnswers: answersFor(board),
			coverLetterMarkdown: "Dear Hiring Team,\n\nLetter body.",
			cvPdfKey: "cv.pdf",
			coverLetterPdfKey: null,
		}),
		claimSubmission: vi.fn(async (_u, _a, input) => {
			calls.push({ method: "claim", key: input.beforeKey });
			return { go: true as const, attemptId: "attempt-1" };
		}),
		finishSubmission: vi.fn(async (_u, _a, _id, input) => {
			calls.push({
				method: "finish",
				reason: input.reason,
				key: input.afterKey,
			});
		}),
		stopSubmission: vi.fn(async (_u, _a, input) => {
			calls.push({ method: "stop", reason: input.reason });
		}),
		stopForQuestions: vi.fn(async () => ({ asked: 0, reused: 0 })),
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
		apply: {
			store,
			browser: fixtureBrowser(),
			blobs,
			allowedHosts: ["127.0.0.1"],
			fixtures: true,
			boardBases: { [board]: `${boards.url}/${board}` },
		},
	} as unknown as PipelineDeps;
	return { deps, calls, blobs };
}

const sent = (jobId: string) =>
	boards.submissions.find((s) => s.path.includes(`/${jobId}/`));

describe.each(NEW_BOARDS)("%s fixture form", (board) => {
	it("submits once on approval, with screenshots before and after", async () => {
		const jobId = `${board}-auto-submit`;
		const { deps, calls, blobs } = harness(board, jobId);
		const outcome = await submitStep(deps, "u1", "app-1");
		// Without the board's own confirmation element or path, a submission is never "applied".
		expect(outcome.outcome, JSON.stringify(calls)).toBe(
			CONFIRMS.has(board) ? "applied" : "needs_human",
		);
		if (!CONFIRMS.has(board))
			expect(calls[1]?.reason).toMatch(
				/^Outcome unknown after a click that may have sent the application/,
			);
		expect(boards.count(jobId)).toBe(1);
		expect(calls.map((c) => c.method)).toEqual(["claim", "finish"]);
		for (const c of calls) {
			expect(c.key).toBeTruthy();
			expect((await blobs.get(c.key ?? ""))?.byteLength).toBeGreaterThan(1000);
		}
		const post = sent(jobId);
		expect(post?.files.join(" ")).toContain("CV.pdf");
		const values = Object.values(post?.values ?? {}).flat();
		expect(values).toContain("Four weeks.");
		expect(values).toContain("ada@example.test");
	}, 90_000);

	it("reads the form before review, and a later load with new ids lines up with it", async () => {
		const jobId = `${board}-read`;
		const started = Date.now();
		const { result, log } = await withPage("read_only", async (page) => ({
			result: await readFormOnPage(page, board, urlFor(board, jobId)),
			log: page.networkLog(),
		}));
		// Workable's combobox sits behind its cookie backdrop: declined first, read at once.
		expect(Date.now() - started).toBeLessThan(15_000);
		expect(result.ok, JSON.stringify(result)).toBe(true);
		if (board === "workable" && result.ok)
			expect(
				result.schema.fields.find((f) => f.kind === "combobox")?.options,
			).toEqual(["A friend", "LinkedIn"]);
		expect(log.filter((r) => r.allowed && r.method !== "GET")).toEqual([]);
		if (!result.ok) return;
		const labels = result.schema.fields.map((f) => f.label);
		expect(labels).toContain("What is your notice period?");
		expect(labels).toContain("Will you require visa sponsorship?");
		const cv = result.schema.fields.find(
			(f) => f.kind === "file" && f.required,
		);
		expect(cv?.key).toBeTruthy();
		expect(
			result.schema.fields.every((f) => !/required|optional/i.test(f.label)),
		).toBe(true);
		// Ids change on every load (Workable, Recruitee): the schema must still match.
		const outcome = await withPage("open", (page) =>
			runApplication(page, {
				...run(board, jobId),
				schema: result.schema.fields,
			}),
		);
		expect(
			outcome.outcome,
			JSON.stringify(outcome.outcome === "stopped" ? outcome.stop : ""),
		).toBe(CONFIRMS.has(board) ? "submitted" : "unknown");
	}, 90_000);

	it("dry run fills everything and posts nothing", async () => {
		const jobId = `${board}-dry`;
		const { result, log } = await withPage("read_only", async (page) => {
			const ran = await runApplication(page, {
				...run(board, jobId, "dry_run"),
				beforeFill: () => page.restrictNetwork("none"),
			});
			return { result: ran, log: page.networkLog() };
		});
		expect(
			result.outcome,
			JSON.stringify(result.outcome === "stopped" ? result.stop : ""),
		).toBe("dry_run");
		expect(boards.count(jobId)).toBe(0);
		expect(log.filter((r) => r.allowed && r.method !== "GET")).toEqual([]);
	}, 60_000);

	it("stops on a required question with no approved answer, before typing anything", async () => {
		const jobId = `${board}-unknown`;
		const result = await withPage("open", (page) =>
			runApplication(page, run(board, jobId)),
		);
		expect(result.outcome).toBe("stopped");
		if (result.outcome === "stopped") {
			expect(result.stop.kind).toBe("unknown_questions");
			expect(result.stop.questions?.map((q) => q.label)).toEqual([
				"Are you willing to relocate to Ankara?",
			]);
			expect(result.filled).toEqual([]);
		}
		expect(boards.count(jobId)).toBe(0);
	}, 60_000);

	it("stops on a visible challenge and sends nothing", async () => {
		const jobId = `${board}-captcha`;
		const result = await withPage("open", (page) =>
			runApplication(page, run(board, jobId)),
		);
		expect(result.outcome === "stopped" && result.stop.kind).toBe("challenge");
		expect(boards.count(jobId)).toBe(0);
	}, 60_000);

	it("calls a refusal after the click an unknown outcome, never submitted", async () => {
		const jobId = `${board}-already`;
		const result = await withPage("open", (page) =>
			runApplication(page, run(board, jobId)),
		);
		expect(boards.count(jobId)).toBe(1);
		expect(
			result.outcome,
			result.outcome === "submitted" ? result.confirmation : "",
		).toBe("unknown");
	}, 60_000);

	it("refuses a host not on the list quietly and still submits once", async () => {
		const jobId = `${board}-tracker`;
		const { deps } = harness(board, jobId);
		const before = boards.trackerHits;
		const outcome = await submitStep(deps, "u1", "app-1");
		// Teamtailor's and Personio's confirmations were never seen: their outcome stays unknown.
		const confirms = board !== "teamtailor" && board !== "personio";
		expect(outcome.outcome, JSON.stringify(outcome)).toBe(
			confirms ? "applied" : "needs_human",
		);
		expect(boards.count(jobId)).toBe(1);
		expect(boards.trackerHits).toBe(before);
	}, 60_000);
});

describe("SmartRecruiters stays hand-off", () => {
	it("opens no browser and sends nothing for a SmartRecruiters job", async () => {
		const jobId = "workable-smartrecruiters-source";
		const { deps, calls } = harness("workable", jobId, "smartrecruiters");
		const outcome = await submitStep(deps, "u1", "app-1");
		expect(outcome.outcome).toBe("needs_human");
		expect(boards.count(jobId)).toBe(0);
		expect(calls.map((c) => c.method)).toEqual(["stop"]);
		expect(calls[0]?.reason).toMatch(/DataDome/);
	}, 60_000);
});

/** Codex review of step 5 (2026-11-09): findings 1, 3 and 4. */
describe("review regressions", () => {
	it("never clicks a submit-capable control to tick a box: nothing is posted before the claim", async () => {
		const jobId = "recruitee-button-toggle";
		const result = await withPage("open", (page) =>
			runApplication(page, {
				...run("recruitee", jobId),
				claim: async () => ({ go: false, reason: "not cleared" }),
			}),
		);
		expect(boards.count(jobId)).toBe(0);
		expect(
			result.outcome,
			JSON.stringify(result.outcome === "stopped" ? result.stop : ""),
		).toBe("not_claimed");
	}, 60_000);

	it("stops when the phone widget shows another country code than the approved number", async () => {
		const jobId = "workable-wrong-country";
		const result = await withPage("open", (page) =>
			runApplication(page, run("workable", jobId)),
		);
		expect(boards.count(jobId)).toBe(0);
		expect(result.outcome === "stopped" && result.stop.kind).toBe("validation");
		if (result.outcome === "stopped")
			expect(result.stop.message).toMatch(/Phone/);
	}, 60_000);

	it('does not take an email-verification page saying "All done!" for Recruitee\'s confirmation', async () => {
		const jobId = "recruitee-verify-email";
		const result = await withPage("open", (page) =>
			runApplication(page, run("recruitee", jobId)),
		);
		expect(boards.count(jobId)).toBe(1);
		expect(
			result.outcome,
			result.outcome === "submitted" ? result.confirmation : "",
		).toBe("unknown");
	}, 60_000);
});

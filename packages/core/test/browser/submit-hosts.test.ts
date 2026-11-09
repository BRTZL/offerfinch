import type { FormRead } from "@offerfinch/core/apply/form-schema";
import type { Board } from "@offerfinch/core/apply/forms";
import { readApplicationForm } from "@offerfinch/core/apply/read-form";
import {
	type ApplyDeps,
	type SubmissionContext,
	type SubmissionStore,
	submitStep,
} from "@offerfinch/core/apply/submit";
import { MemoryBlobStore } from "@offerfinch/core/export/export";
import type { PipelineDeps } from "@offerfinch/core/pipeline/ports";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fixtureBrowser, siteBrowser } from "./browser";
import { type FixtureBoards, startFixtureBoards } from "./fixture-boards";

/**
 * Codex phase 3 review, finding 1: only the first URL's host was checked. A board host that
 * redirects, navigates or posts elsewhere must stop the run before anything is sent there.
 * Only 127.0.0.1 is allowed here; localhost stands in for the disallowed host.
 */

let boards: FixtureBoards;
beforeAll(async () => {
	boards = await startFixtureBoards();
});
afterAll(async () => {
	await boards?.close();
});

const PROFILE = {
	files: [
		{
			path: "personal.md",
			content:
				"# Personal\n\n- **Name:** Ada Example\n- **Email:** ada@example.test\n- **Phone:** +90 555 000 00 00\n- **Location:** Izmir, Turkey\n- **LinkedIn:** linkedin.com/in/adaexample\n",
		},
	],
};

function harness(board: Board, jobId: string, source: string = board) {
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
			externalId: jobId,
			jobUrl: "",
			formAnswers: [
				{
					question: "Why do you want to work at Acme Robotics?",
					answer: "The robotics work matches what I build.",
				},
				{ question: "What is your notice period?", answer: "Four weeks." },
			],
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

const away = (jobId: string) =>
	boards.submissions.filter(
		(s) => s.host === "localhost" && s.path.includes(`/${jobId}/`),
	);

describe.each(["ashby", "greenhouse", "lever"] as const)(
	"%s: allowed destinations",
	(board) => {
		it("stops when the allowed form URL redirects to another host, before filling", async () => {
			const jobId = `${board}-redirect-away`;
			const { deps, calls } = harness(board, jobId);
			const outcome = await submitStep(deps, "u1", "app-1");
			expect(outcome.outcome).toBe("needs_human");
			expect(away(jobId)).toEqual([]);
			expect(calls.map((c) => c.method)).toEqual(["stop"]);
			expect(calls[0]?.reason).toMatch(/localhost/);
		}, 60_000);

		it("stops when the form navigates itself to another host", async () => {
			const jobId = `${board}-nav-away`;
			const { deps, calls } = harness(board, jobId);
			const outcome = await submitStep(deps, "u1", "app-1");
			expect(outcome.outcome).toBe("needs_human");
			expect(away(jobId)).toEqual([]);
			expect(calls.some((c) => c.method === "claim")).toBe(false);
			expect(calls.at(-1)?.reason).toMatch(/localhost/);
		}, 60_000);

		// Codex re-check of 647487f, finding 6: non-navigation GETs passed whatever their host,
		// so a page could carry the applicant's data out in a fetch, image or iframe URL.
		it("never lets a typed value leave in a GET to another host", async () => {
			const jobId = `${board}-leak-away`;
			const { deps, calls } = harness(board, jobId);
			const outcome = await submitStep(deps, "u1", "app-1");
			expect(
				boards.leaks.filter(
					(l) => l.host === "localhost" && l.path.includes(`/${jobId}`),
				),
			).toEqual([]);
			expect(outcome.outcome).toBe("needs_human");
			expect(calls.some((c) => c.method === "claim")).toBe(false);
			expect(calls.at(-1)?.reason).toMatch(/localhost/);
		}, 60_000);

		it("never lets the submission reach another host", async () => {
			const jobId = `${board}-post-away`;
			const { deps, calls } = harness(board, jobId);
			const outcome = await submitStep(deps, "u1", "app-1");
			expect(outcome.outcome).toBe("needs_human");
			expect(away(jobId)).toEqual([]);
			// The click happened, so it is an unknown outcome naming the refused host.
			expect(calls.at(-1)?.method).toBe("finish");
			expect(calls.at(-1)?.reason).toMatch(/localhost/);
		}, 60_000);
	},
);

describe.each(["ashby", "greenhouse", "lever"] as const)(
	"%s: submission on approval",
	(board) => {
		it("fills and submits once, with screenshots before and after", async () => {
			const jobId = `${board}-auto-submit`;
			const { deps, calls, blobs } = harness(board, jobId);
			const outcome = await submitStep(deps, "u1", "app-1");
			expect(outcome.outcome).toBe("applied");
			expect(boards.count(jobId)).toBe(1);
			expect(calls.map((c) => c.method)).toEqual(["claim", "finish"]);
			expect(calls[1]?.reason).toMatch(/^Submitted; the board confirmed/);
			for (const c of calls) {
				expect(c.key).toBeTruthy();
				expect(await blobs.get(c.key ?? "")).not.toBeNull();
			}
		}, 60_000);

		it("sends nothing for a hand-off source's job, even on this board", async () => {
			const jobId = `${board}-handoff-source`;
			const { deps, calls } = harness(board, jobId, "linkedin");
			const outcome = await submitStep(deps, "u1", "app-1");
			expect(outcome.outcome).toBe("needs_human");
			expect(boards.count(jobId)).toBe(0);
			expect(calls.map((c) => c.method)).toEqual(["stop"]);
			expect(calls[0]?.reason).toMatch(/Easy Apply is never used/);
		}, 60_000);
	},
);

/**
 * Codex review of PR #149 (2026-11-09), P1: the real app allowed 127.0.0.1 and localhost in every
 * run, so a board host that redirected to this Mac (and a `POST /mutate` there) was followed. Here
 * the board is on a public-looking name (`boards.acme.test`, answered by the local fixture server
 * through `siteBrowser`), with the hosts the desktop used to pass (`submitAllowedHosts`: its own
 * and 127.0.0.1, localhost) and no `fixtures`: the real configuration. Its form 302s to
 * `http://localhost:<port>/…`, which must be refused, in the submission and in the form read.
 */
describe("the real configuration: a redirect to this Mac is refused", () => {
	const jobId = "greenhouse-redirect-away";
	const port = () => new URL(boards.url).port;
	const base = () => `http://boards.acme.test:${port()}/greenhouse`;
	const allowedHosts = ["boards.acme.test", "127.0.0.1", "localhost"];
	const context = (): SubmissionContext => ({
		applicationId: "app-1",
		source: "greenhouse",
		board: "greenhouse",
		companyKey: "acme-robotics",
		externalId: jobId,
		jobUrl: "",
		formAnswers: [],
		coverLetterMarkdown: null,
		cvPdfKey: "cv.pdf",
		coverLetterPdfKey: null,
	});

	it("stops the submission at the redirect, before anything is filled or sent", async () => {
		const { deps, calls } = harness("greenhouse", jobId);
		const url = `${base()}/acme-robotics/jobs/${jobId}`;
		const read: FormRead = {
			status: "read",
			schema: {
				board: "greenhouse",
				url,
				submit: "Submit application",
				fields: [],
			},
			readAt: new Date().toISOString(),
		};
		const apply = deps.apply as ApplyDeps;
		Object.assign(apply, {
			browser: siteBrowser(Number(port())),
			boardBases: { greenhouse: base() },
			allowedHosts,
			fixtures: undefined,
		});
		Object.assign(apply.store, { formRead: async () => read });
		const outcome = await submitStep(deps, "u1", "app-1");
		expect(outcome).toMatchObject({
			outcome: "needs_human",
			reason: expect.stringMatching(/localhost/),
		});
		expect(calls.map((c) => c.method)).toEqual(["stop"]);
		expect(away(jobId)).toEqual([]);
	}, 60_000);

	it("reads no form there before review", async () => {
		const read = await readApplicationForm(
			{
				store: {} as SubmissionStore,
				browser: siteBrowser(Number(port())),
				blobs: new MemoryBlobStore(),
				boardBases: { greenhouse: base() },
				allowedHosts,
			},
			context(),
		);
		// The navigation is refused at its redirect to localhost: nothing is read there.
		expect(read).toMatchObject({
			status: "failed",
			note: expect.stringMatching(/ERR_BLOCKED_BY_CLIENT/),
		});
	}, 60_000);
});

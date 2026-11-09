import type { Board } from "@offerfinch/core/apply/forms";
import {
	type SubmissionStore,
	submitStep,
} from "@offerfinch/core/apply/submit";
import { MemoryBlobStore } from "@offerfinch/core/export/export";
import type { PipelineDeps } from "@offerfinch/core/pipeline/ports";
import { PlaywrightBrowserProvider } from "@offerfinch/core/scrape/browser";
import { USER_AGENT } from "@offerfinch/core/sources/types";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromePath } from "./browser";
import { type FixtureBoards, startFixtureBoards } from "./fixture-boards";

/**
 * Codex phase 3 review, finding 1: only the first URL's host was checked. A board host that
 * redirects, navigates or posts elsewhere must stop the run before anything is sent there.
 * Only 127.0.0.1 is allowed here; localhost stands in for the disallowed host.
 */

/**
 * Headless Chromium with its Local Network Access checks off. A page the guard fulfills has no
 * address, so Chromium treats it as public and blocks its requests to localhost by itself, which
 * would hide a leak to the away host these tests look for. Test-only; never used on a real board.
 */
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

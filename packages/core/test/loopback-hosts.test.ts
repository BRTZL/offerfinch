import { describe, expect, it, vi } from "vitest";
import type { FormBoard } from "../src/apply/forms";
import { readApplicationForm } from "../src/apply/read-form";
import {
	type ApplyDeps,
	allowedHostsFor,
	dryRunApplication,
	type SubmissionContext,
	type SubmissionStore,
	submitStep,
} from "../src/apply/submit";
import { MemoryBlobStore } from "../src/export/export";
import type { PipelineDeps } from "../src/pipeline/ports";

/**
 * Codex review of PR #149 (2026-11-09), P1: every run allowed 127.0.0.1 and localhost, and a form
 * there needed no read before review. A Recruitee, Teamtailor or Personio company key such as
 * `localhost:8123#` built `https://localhost:8123#.recruitee.com/…`, whose host is this Mac, and
 * the run opened it with the board closed and no saved read. Only a fixture run (`fixtures`, test
 * code) may open this Mac. Nothing here opens a browser or contacts a site: the browser throws
 * and the run is a stub.
 */

const PROFILE = {
	files: [
		{
			path: "personal.md",
			content:
				"# Personal\n\n- **Name:** Ada Example\n- **Email:** ada@example.test\n- **Location:** Izmir, Turkey\n",
		},
	],
};

const BAD_KEY = "localhost:8123#";

function contextFor(
	board: FormBoard,
	companyKey: string,
	boardOpened?: boolean,
): SubmissionContext {
	return {
		applicationId: "app-1",
		source: board === "web" ? "web" : board,
		board,
		...(boardOpened === undefined ? {} : { boardOpened }),
		companyKey,
		externalId: board === "recruitee" ? `${companyKey}:engineer` : "1",
		jobUrl: "https://example.test/jobs/1-engineer",
		formAnswers: [],
		coverLetterMarkdown: null,
		cvPdfKey: "cv.pdf",
		coverLetterPdfKey: null,
	};
}

function harness(context: SubmissionContext, extra: Partial<ApplyDeps> = {}) {
	const blobs = new MemoryBlobStore();
	void blobs.put("cv.pdf", new TextEncoder().encode("%PDF-1.4 cv"), "x");
	const stops: string[] = [];
	const opened: string[] = [];
	const runs: string[] = [];
	const store = {
		submissionsPaused: async () => false,
		resolveInterrupted: async () => false,
		submissionContext: async () => context,
		claimSubmission: vi.fn(async () => ({
			go: false as const,
			reason: "no claim in tests",
			paused: false,
		})),
		finishSubmission: vi.fn(async () => {}),
		stopSubmission: vi.fn(async (_u, _a, input) => {
			stops.push(input.reason);
		}),
		stopForQuestions: vi.fn(async () => ({ asked: 0, reused: 0 })),
		recordDryRun: vi.fn(async (_u, _a, input) => {
			stops.push(input.reason);
			return "dry";
		}),
		savedAnswers: async () => [],
		handOverStuck: async () => [],
		beginSubmission: async () => ({ outcome: "started" as const }),
		formRead: async () => null,
	} satisfies SubmissionStore;
	const apply: ApplyDeps = {
		store,
		browser: {
			name: "none",
			openSession: async () => {
				opened.push("session");
				throw new Error("no browser in tests");
			},
		},
		blobs,
		run: async (run) => {
			runs.push(run.url);
			return {
				outcome: "stopped",
				stop: { kind: "form_changed", message: "Stub run." },
				screenshot: null,
				filled: [],
			};
		},
		readForm: async ({ url }) => {
			runs.push(url);
			return { ok: false, reason: "stub" };
		},
		...extra,
	};
	const deps = {
		repo: {
			getState: async () => "applying",
			getProfile: async () => PROFILE,
		},
		apply,
	} as unknown as PipelineDeps;
	return { deps, apply, stops, opened, runs };
}

describe.each(["recruitee", "teamtailor", "personio"] as const)(
	"%s: a company key that is not one DNS label",
	(board) => {
		it.each([undefined, false, true])(
			"stops the submission before any browser opens (board opened: %s)",
			async (boardOpened) => {
				const { deps, stops, opened, runs } = harness(
					contextFor(board, BAD_KEY, boardOpened),
					// What the desktop gave every run before the fix.
					{ allowedHosts: ["127.0.0.1", "localhost"] },
				);
				const outcome = await submitStep(deps, "u1", "app-1");
				expect(outcome.outcome).toBe("needs_human");
				expect(runs).toEqual([]);
				expect(opened).toEqual([]);
				expect(stops).toHaveLength(1);
				expect(stops[0]).toMatch(/company key/);
			},
		);

		it("reads no form before review", async () => {
			const { apply, runs, opened } = harness(
				contextFor(board, BAD_KEY, true),
				{
					allowedHosts: ["127.0.0.1", "localhost"],
				},
			);
			const read = await readApplicationForm(
				apply,
				contextFor(board, BAD_KEY, true),
			);
			expect(read.status).toBe("skipped");
			expect(runs).toEqual([]);
			expect(opened).toEqual([]);
		});

		it("dry-runs nothing", async () => {
			const { deps, runs, opened, stops } = harness(
				contextFor(board, BAD_KEY, true),
			);
			expect(await dryRunApplication(deps, "u1", "app-1")).toMatchObject({
				outcome: "stopped",
			});
			expect(runs).toEqual([]);
			expect(opened).toEqual([]);
			expect(stops[0]).toMatch(/company key/);
		});

		it("never allows a host for the run", () => {
			const context = contextFor(board, BAD_KEY, true);
			expect(
				allowedHostsFor(
					{ allowedHosts: ["127.0.0.1", "localhost"] },
					context,
					"https://localhost:8123/#.recruitee.com/o/engineer/c/new",
				),
			).toEqual([]);
		});
	},
);

describe("the real configuration never allows this Mac", () => {
	const LOOPBACK = ["127.0.0.1", "localhost"];

	it("drops loopback and private hosts from a run's allowed hosts", () => {
		// What the desktop passed (`submitAllowedHosts`): 127.0.0.1 and localhost, always.
		const greenhouse = contextFor("greenhouse", "acme", true);
		expect(
			allowedHostsFor(
				{ allowedHosts: [...LOOPBACK, "10.0.0.5", "printer.local"] },
				greenhouse,
				"https://job-boards.greenhouse.io/acme/jobs/1",
			),
		).toEqual(["job-boards.greenhouse.io"]);
		// No allowed hosts given: none by default.
		expect(
			allowedHostsFor(
				{},
				contextFor("greenhouse", "acme", false),
				"https://job-boards.greenhouse.io/acme/jobs/1",
			),
		).toEqual([]);
		// An employer's form on this Mac or a private network, opened: still nothing.
		for (const url of [
			"http://127.0.0.1:8123/apply",
			"http://localhost:8123/apply",
			"http://[::1]:8123/apply",
			"http://0.0.0.0/apply",
			"http://192.168.1.10/apply",
			"http://172.16.0.1/apply",
			"http://169.254.169.254/latest",
			"http://nas.local/apply",
		])
			expect(
				allowedHostsFor({}, contextFor("web", "", true), url),
				url,
			).toEqual([]);
	});

	it("keeps the fixture path: loopback only with `fixtures`", () => {
		const web = contextFor("web", "", true);
		expect(
			allowedHostsFor({ fixtures: true }, web, "http://127.0.0.1:8123/apply"),
		).toEqual(LOOPBACK);
		expect(
			allowedHostsFor({ fixtures: true }, contextFor("greenhouse", "acme"), ""),
		).toEqual(LOOPBACK);
	});

	it("never fills a form on this Mac without a read before review", async () => {
		const bases = { greenhouse: "http://127.0.0.1:9/greenhouse" };
		const greenhouse = contextFor("greenhouse", "acme");
		// The real configuration: a local base (however it got there) is refused.
		const real = harness(greenhouse, {
			boardBases: bases,
			allowedHosts: LOOPBACK,
		});
		expect(await submitStep(real.deps, "u1", "app-1")).toMatchObject({
			outcome: "needs_human",
		});
		expect(real.runs).toEqual([]);
		expect(real.opened).toEqual([]);
		// A fixture run fills the local stand-in from its scan, as before.
		const fixture = harness(greenhouse, {
			boardBases: bases,
			fixtures: true,
		} as Partial<ApplyDeps>);
		await submitStep(fixture.deps, "u1", "app-1");
		expect(fixture.runs).toEqual(["http://127.0.0.1:9/greenhouse/acme/jobs/1"]);
	});
});

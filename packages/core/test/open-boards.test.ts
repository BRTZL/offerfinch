import { describe, expect, it } from "vitest";
import {
	applyUrl,
	BOARDS,
	type Board,
	boardFormHost,
	companyKeyProblem,
} from "../src/apply/forms";
import {
	BOARD_RISKS,
	OPENABLE_BOARDS,
	runFormHosts,
	shownHosts,
} from "../src/apply/open-boards";
import { readApplicationForm } from "../src/apply/read-form";
import type { ApplyDeps, SubmissionContext } from "../src/apply/submit";

/**
 * Real job sites opened one by one (docs/auto-apply-plan.md, step 8): a run may open only its own
 * board's exact form host, and only once the user opened that board. Nothing here opens a browser
 * or contacts a site: the browser throws and the form read is a stub.
 */

const LOCAL = ["127.0.0.1", "localhost"];
const job = (companyKey: string) => ({
	url: "https://example.test/jobs/123-engineer",
	externalId: "acme:engineer",
	companyKey,
});

describe("the hosts a run may open", () => {
	it("derives each board's host exactly as its form URL is built", () => {
		for (const board of BOARDS)
			expect(boardFormHost(board, "acme")).toBe(
				new URL(applyUrl(board, job("acme"))).hostname,
			);
		expect(boardFormHost("recruitee", "Acme")).toBe("acme.recruitee.com");
		expect(boardFormHost("teamtailor", "acme")).toBe("acme.teamtailor.com");
		expect(boardFormHost("personio", "acme")).toBe("acme.jobs.personio.de");
	});

	it("never lets a company key name another site", () => {
		for (const board of ["recruitee", "teamtailor", "personio"] as Board[])
			for (const key of [
				"evil.com#",
				"x@evil.com",
				"a.b",
				"",
				"-a",
				"a/b",
				"localhost:8123#",
			]) {
				expect(
					runFormHosts(
						LOCAL,
						{ board, boardOpened: true, companyKey: key },
						"https://x.example/",
					),
				).toEqual(LOCAL);
				// No form address is ever built from it, real or fixture.
				expect(companyKeyProblem(board, key)).not.toBeNull();
				expect(() => applyUrl(board, job(key))).toThrow(/company key/);
				expect(() =>
					applyUrl(board, job(key), { [board]: "http://127.0.0.1:9/x" }),
				).toThrow(/company key/);
			}
	});

	it("adds only this run's board host, and only when that board is opened", () => {
		const url = "https://job-boards.greenhouse.io/acme/jobs/1";
		const greenhouse = { board: "greenhouse" as const, companyKey: "acme" };
		expect(
			runFormHosts(LOCAL, { ...greenhouse, boardOpened: false }, url),
		).toEqual(LOCAL);
		expect(runFormHosts(LOCAL, greenhouse, url)).toEqual(LOCAL);
		expect(
			runFormHosts(LOCAL, { ...greenhouse, boardOpened: true }, url),
		).toEqual([...LOCAL, "job-boards.greenhouse.io"]);
		expect(
			runFormHosts(
				LOCAL,
				{ board: "recruitee", boardOpened: true, companyKey: "acme" },
				"https://acme.recruitee.com/o/engineer/c/new",
			),
		).toEqual([...LOCAL, "acme.recruitee.com"]);
	});

	it("opens an employer's form on its page's exact host only", () => {
		const web = { board: "web" as const, boardOpened: true, companyKey: "" };
		expect(
			runFormHosts(LOCAL, web, "https://jobs.acme.example/apply?id=7"),
		).toEqual([...LOCAL, "jobs.acme.example"]);
		expect(
			runFormHosts(
				LOCAL,
				{ ...web, boardOpened: false },
				"https://jobs.acme.example/apply",
			),
		).toEqual(LOCAL);
	});

	it("lists every board and employers' forms with their hosts and risks", () => {
		expect(OPENABLE_BOARDS).toEqual([...BOARDS, "web"]);
		expect(shownHosts("greenhouse")).toEqual([
			"job-boards.greenhouse.io",
			"boards.greenhouse.io",
			"email-address-validator.us.greenhouse.io",
			"grnhse-prod-jben-us-east-1.s3.amazonaws.com",
		]);
		expect(shownHosts("teamtailor")).toEqual(["<company>.teamtailor.com"]);
		expect(shownHosts("web")).toEqual(["the form's own site only"]);
		for (const board of OPENABLE_BOARDS)
			expect(BOARD_RISKS[board].length).toBeGreaterThan(0);
	});
});

describe("the form read before review", () => {
	const context = (boardOpened: boolean): SubmissionContext => ({
		applicationId: "a1",
		source: "greenhouse",
		board: "greenhouse",
		boardOpened,
		companyKey: "acme",
		externalId: "1",
		jobUrl: "https://boards.greenhouse.io/acme/jobs/1",
		formAnswers: [],
		coverLetterMarkdown: null,
		cvPdfKey: null,
		coverLetterPdfKey: null,
	});
	const apply = (reads: string[]): ApplyDeps => ({
		store: {} as ApplyDeps["store"],
		browser: {
			name: "none",
			openSession: async () => {
				throw new Error("no browser in tests");
			},
		},
		blobs: {} as ApplyDeps["blobs"],
		readForm: async ({ url }) => {
			reads.push(url);
			return { ok: false, reason: "stub" };
		},
	});

	it("is refused for a closed board before anything opens", async () => {
		const reads: string[] = [];
		const read = await readApplicationForm(apply(reads), context(false));
		expect(read).toMatchObject({
			status: "skipped",
			note: "The form was not read before review: Greenhouse isn't opened in Settings › Applying. Nothing will be filled there until it is opened.",
		});
		expect(reads).toEqual([]);
	});

	it("reads an opened board's form on its own host", async () => {
		const reads: string[] = [];
		await readApplicationForm(apply(reads), context(true));
		expect(reads).toEqual(["https://job-boards.greenhouse.io/acme/jobs/1"]);
	});
});

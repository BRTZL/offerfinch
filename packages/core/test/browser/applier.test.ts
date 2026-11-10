import {
	type ApplicationRun,
	runApplication,
} from "@offerfinch/core/apply/applier";
import { applyUrl, type Board } from "@offerfinch/core/apply/forms";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { localBrowser, siteBrowser } from "./browser";
import { type FixtureBoards, startFixtureBoards } from "./fixture-boards";

let boards: FixtureBoards;
beforeAll(async () => {
	boards = await startFixtureBoards();
});
afterAll(async () => {
	await boards?.close();
});

const pdf = (name: string) => ({
	name,
	mimeType: "application/pdf",
	buffer: new TextEncoder().encode("%PDF-1.4 fixture"),
});

function run(
	board: Board,
	jobId: string,
	mode: ApplicationRun["mode"] = "submit",
): ApplicationRun {
	return {
		board,
		mode,
		url: applyUrl(
			board,
			{ url: "", externalId: jobId, companyKey: "acme-robotics" },
			{ [board]: `${boards.url}/${board}` },
		),
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
			answers: [
				{
					question: "Why do you want to work at Acme Robotics?",
					answer: "The robotics work matches what I build.",
				},
				{ question: "What is your notice period?", answer: "Four weeks." },
			],
			coverLetterText: "Dear Hiring Team,\n\nLetter body.",
			hasCoverLetterFile: true,
		},
		files: { cv: pdf("cv.pdf"), coverLetter: pdf("cover-letter.pdf") },
		claim: async () => ({ go: true }),
		// The fixtures answer at once; an outcome that never confirms waits this long.
		confirmTimeoutMs: 3_000,
	};
}

async function withPage<T>(
	network: "open" | "read_only",
	fn: (
		page: Awaited<
			ReturnType<
				Awaited<
					ReturnType<ReturnType<typeof localBrowser>["openSession"]>
				>["newPage"]
			>
		>,
	) => Promise<T>,
) {
	const session = await localBrowser().openSession({ network });
	try {
		return await fn(await session.newPage());
	} finally {
		await session.close();
	}
}

describe.each(["ashby", "greenhouse", "lever"] as const)(
	"%s fixture form",
	(board) => {
		it("fills from approved data, submits once and reads the confirmation", async () => {
			const jobId = `${board}-ok`;
			const result = await withPage("open", (page) =>
				runApplication(page, run(board, jobId)),
			);
			expect(
				result.outcome,
				JSON.stringify(result.outcome === "stopped" ? result.stop : result),
			).toBe("submitted");
			expect(boards.count(jobId)).toBe(1);
			const sent = boards.submissions.find((s) =>
				s.path.includes(`/${jobId}/`),
			);
			expect(sent?.files.join(" ")).toContain("cv.pdf");
			if (result.outcome === "submitted") {
				expect(result.before.byteLength).toBeGreaterThan(1000);
				expect(result.after.byteLength).toBeGreaterThan(1000);
				expect(result.filled.map((f) => f.value)).toContain("Four weeks.");
			}
		}, 60_000);

		it("dry run fills everything and posts nothing, with the network closed before the first keystroke", async () => {
			const jobId = `${board}-dry`;
			const { result, log } = await withPage("read_only", async (page) => {
				const result = await runApplication(page, {
					...run(board, jobId, "dry_run"),
					lookupsOffline: true,
					beforeFill: () => page.restrictNetwork("none"),
				});
				return { result, log: page.networkLog() };
			});
			expect(
				result.outcome,
				JSON.stringify(result.outcome === "stopped" ? result.stop : ""),
			).toBe("dry_run");
			expect(boards.count(jobId)).toBe(0);
			expect(log.filter((r) => r.allowed && r.method !== "GET")).toEqual([]);
			if (board === "lever" && result.outcome === "dry_run") {
				// The location box needs its lookup, which runs only with the network open: it is
				// left alone and listed as not chosen; the rest of the form, files included, is filled.
				expect(result.filled).toContainEqual({
					label: "Current location",
					value: "Izmir, Turkey (not chosen: the suggestions need the network)",
				});
				expect(result.filled.map((f) => f.value)).toContain("cv.pdf");
			}
		}, 60_000);

		it("stops on a required question with no approved answer, before typing anything", async () => {
			const jobId = `${board}-unknown`;
			const result = await withPage("open", (page) =>
				runApplication(page, run(board, jobId)),
			);
			expect(result.outcome).toBe("stopped");
			if (result.outcome === "stopped") {
				expect(result.stop.kind).toBe("unknown_questions");
				expect(result.stop.questions?.[0]?.options.length).toBeGreaterThan(0);
				expect(result.filled).toEqual([]);
			}
			expect(boards.count(jobId)).toBe(0);
		}, 60_000);

		it("stops on a visible CAPTCHA, and treats one after the click as an unknown outcome", async () => {
			const shown = await withPage("open", (page) =>
				runApplication(page, run(board, `${board}-captcha`)),
			);
			expect(shown.outcome === "stopped" && shown.stop.kind).toBe("challenge");
			const after = await withPage("open", (page) =>
				runApplication(page, run(board, `${board}-captcha-after`)),
			);
			expect(after.outcome).toBe("unknown");
			if (after.outcome === "unknown")
				expect(after.reason).toMatch(/reCAPTCHA challenge/);
			expect(boards.count(`${board}-captcha-after`)).toBe(0);
		}, 60_000);

		it("does not click when the claim refuses, and calls a failed POST unknown", async () => {
			const refused = await withPage("open", (page) =>
				runApplication(page, {
					...run(board, `${board}-paused`),
					claim: async () => ({ go: false, reason: "paused" }),
				}),
			);
			expect(refused.outcome).toBe("not_claimed");
			expect(boards.count(`${board}-paused`)).toBe(0);
			const failed = await withPage("open", (page) =>
				runApplication(page, run(board, `${board}-error-once`)),
			);
			expect(failed.outcome).toBe("unknown");
			expect(boards.count(`${board}-error-once`)).toBe(1);
		}, 60_000);
	},
);

/**
 * Codex phase 3 review, finding 2: an optional question left blank kept whatever the form had
 * chosen for it (gender "Male", marketing ticked), and an approved checkbox answer kept extra
 * ticked options. What is sent must be exactly the approved answers and nothing else.
 */
// A real dry run's session (apply/submit.ts): read-only, no allowed hosts, private networks
// refused. The board answers on a public-looking name, so the guard fetches every read itself.
describe.each(["ashby", "greenhouse", "lever"] as const)(
	"%s fixture form, dry run as a real one",
	(board) => {
		it("fills everything and posts nothing in a hostless read-only session", async () => {
			const jobId = `${board}-dry-real`;
			const port = new URL(boards.url).port;
			const session = await siteBrowser(Number(port)).openSession({
				network: "read_only",
				refusePrivateNetwork: true,
			});
			try {
				const page = await session.newPage();
				const result = await runApplication(page, {
					...run(board, jobId, "dry_run"),
					url: applyUrl(
						board,
						{ url: "", externalId: jobId, companyKey: "acme-robotics" },
						{ [board]: `http://jobs.acme.test:${port}/${board}` },
					),
					lookupsOffline: true,
					beforeFill: () => page.restrictNetwork("none"),
				});
				const log = page.networkLog();
				expect(
					result.outcome,
					JSON.stringify(result.outcome === "stopped" ? result.stop : ""),
				).toBe("dry_run");
				expect(page.url()).toContain("jobs.acme.test");
				expect(boards.count(jobId)).toBe(0);
				expect(log.filter((r) => r.allowed && r.method !== "GET")).toEqual([]);
			} finally {
				await session.close();
			}
		}, 60_000);
	},
);

describe("controls that arrive answered", () => {
	const withRelocation = (board: Board, jobId: string): ApplicationRun => {
		const base = run(board, jobId);
		return {
			...base,
			data: {
				...base.data,
				answers: [
					...base.data.answers,
					{
						question: "Are you willing to relocate to Ankara?",
						answer: "Yes",
					},
				],
			},
		};
	};
	const sent = (jobId: string) =>
		boards.submissions.find((s) => s.path.includes(`/${jobId}/`));

	it("ashby: clears a ticked marketing checkbox nobody approved", async () => {
		const result = await withPage("open", (page) =>
			runApplication(page, withRelocation("ashby", "ashby-defaults")),
		);
		expect(result.outcome).toBe("submitted");
		expect(sent("ashby-defaults")?.values.question_105).toBeUndefined();
	}, 60_000);

	it("greenhouse: sends no gender and no marketing consent when none was approved", async () => {
		const result = await withPage("open", (page) =>
			runApplication(page, withRelocation("greenhouse", "greenhouse-defaults")),
		);
		expect(result.outcome).toBe("submitted");
		const values = sent("greenhouse-defaults")?.values ?? {};
		expect(values.gender ?? [""]).toEqual([""]);
		expect(values.marketing_consent).toBeUndefined();
	}, 60_000);

	it("lever: sends exactly the approved checkbox answer and unticks the rest", async () => {
		const result = await withPage("open", (page) =>
			runApplication(page, withRelocation("lever", "lever-defaults")),
		);
		expect(
			result.outcome,
			JSON.stringify(result.outcome === "stopped" ? result.stop : ""),
		).toBe("submitted");
		const values = sent("lever-defaults")?.values ?? {};
		expect(values["cards[c1][field2]"]).toEqual(["Yes"]);
		expect(values["cards[c1][field3]"]).toBeUndefined();
		expect(values["consent[marketing]"]).toBeUndefined();
	}, 60_000);

	it("hands over a radio that arrives answered, without choosing a demographic answer", async () => {
		const result = await withPage("open", (page) =>
			runApplication(page, run("ashby", "ashby-radio-default")),
		);
		expect(result.outcome).toBe("stopped");
		if (result.outcome === "stopped") {
			expect(result.stop.kind).toBe("unknown_questions");
			expect(result.stop.questions?.map((q) => q.label)).toEqual(["Gender"]);
			expect(result.filled).toEqual([]);
		}
		expect(boards.count("ashby-radio-default")).toBe(0);
	}, 60_000);
});

/**
 * Codex phase 3 review, finding 5: any path containing /thanks or /confirmation, or Ashby's
 * success container whatever it said, counted as confirmed. A page saying "Application
 * rejected" must be an unknown outcome, never `submitted`.
 */
describe.each(["ashby", "greenhouse", "lever"] as const)(
	"%s: a page that only looks like a confirmation",
	(board) => {
		it("is an unknown outcome, not submitted", async () => {
			const jobId = `${board}-fake-thanks`;
			const result = await withPage("open", (page) =>
				runApplication(page, run(board, jobId)),
			);
			expect(boards.count(jobId)).toBe(1);
			expect(
				result.outcome,
				result.outcome === "submitted" ? result.confirmation : "",
			).toBe("unknown");
		}, 60_000);
	},
);

/**
 * Lever's location (docs/auto-apply-plan.md, step 4): review lists the approved text, so only a
 * suggestion that is exactly that text is picked. A lookup that offers only longer names stops
 * the run with them as the question's options; nothing is sent.
 */
describe("lever location suggestions", () => {
	it("picks the suggestion that is exactly the approved text, not the first", async () => {
		const jobId = "lever-location-exact";
		const result = await withPage("open", (page) =>
			runApplication(page, run("lever", jobId)),
		);
		expect(
			result.outcome,
			JSON.stringify(result.outcome === "stopped" ? result.stop : ""),
		).toBe("submitted");
		const sent = boards.submissions.find((s) => s.path.includes(`/${jobId}/`));
		expect(sent?.values.location).toEqual(["Izmir, Turkey"]);
		expect(sent?.values.selectedLocation).toEqual([
			JSON.stringify({ name: "Izmir, Turkey" }),
		]);
	}, 60_000);

	it("stops when no suggestion is exactly the approved text, offering them", async () => {
		const jobId = "lever-location-prefix";
		const result = await withPage("open", (page) =>
			runApplication(page, run("lever", jobId)),
		);
		expect(result.outcome).toBe("stopped");
		if (result.outcome !== "stopped") return;
		expect(result.stop.kind).toBe("unknown_questions");
		expect(result.stop.questions).toEqual([
			{
				label: "Current location",
				required: true,
				kind: "text",
				options: ["Izmir, Turkey, Region", "Izmir, Turkey Province, Region"],
				answered: "Izmir, Turkey",
			},
		]);
		expect(boards.count(jobId)).toBe(0);
	}, 60_000);

	it("an approved answer for the question wins over the profile's text", async () => {
		const jobId = "lever-location-prefix-answered";
		const base = run("lever", jobId);
		const result = await withPage("open", (page) =>
			runApplication(page, {
				...base,
				data: {
					...base.data,
					answers: [
						...base.data.answers,
						{ question: "Current location", answer: "Izmir, Turkey, Region" },
					],
				},
			}),
		);
		expect(
			result.outcome,
			JSON.stringify(result.outcome === "stopped" ? result.stop : ""),
		).toBe("submitted");
		const sent = boards.submissions.find((s) => s.path.includes(`/${jobId}/`));
		expect(sent?.values.location).toEqual(["Izmir, Turkey, Region"]);
	}, 60_000);
});

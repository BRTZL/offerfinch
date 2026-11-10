import { describe, expect, it } from "vitest";
import { BOARDS } from "../src/apply/forms";

import {
	BOARD_SUBMISSION_MODES,
	HANDOFF_SOURCES,
	submissionModeFor,
	submissionModeForSource,
} from "../src/apply/modes";

describe("submission modes", () => {
	it("submits automatically on every board with a form filler", () => {
		for (const board of BOARDS) {
			expect(BOARD_SUBMISSION_MODES[board].mode).toBe("auto");
			expect(BOARD_SUBMISSION_MODES[board].why).toMatch(
				/not proof the employer received it/,
			);
			expect(submissionModeFor(board)).toEqual({ mode: "auto", reason: "" });
			expect(submissionModeForSource(board, board)).toEqual({
				mode: "auto",
				reason: "",
			});
		}
	});

	it("keeps LinkedIn jobs hand-off whatever their board: the source decides first", () => {
		for (const board of ["ashby", "greenhouse", "lever", null] as const) {
			const decision = submissionModeForSource("linkedin", board);
			expect(decision.mode).toBe("handoff");
			expect(decision.reason).toMatch(/Easy Apply is never used/);
		}
	});

	it("keeps every hand-off source hand-off, even named with an automatic board", () => {
		for (const source of Object.keys(HANDOFF_SOURCES)) {
			const decision = submissionModeForSource(source, "greenhouse");
			expect(decision.mode).toBe("handoff");
			expect(decision.reason).toBe(HANDOFF_SOURCES[source]);
		}
		for (const source of ["manual", "indeed", "glassdoor", "sample"])
			expect(HANDOFF_SOURCES[source]).toBeDefined();
	});

	it("fills Workable, Recruitee, Teamtailor and Personio; SmartRecruiters stays hand-off for its CAPTCHA", () => {
		for (const board of [
			"workable",
			"recruitee",
			"teamtailor",
			"personio",
		] as const) {
			expect(HANDOFF_SOURCES[board]).toBeUndefined();
			expect(submissionModeForSource(board, board).mode).toBe("auto");
		}
		expect(BOARDS).not.toContain("smartrecruiters");
		const sr = submissionModeForSource("smartrecruiters", null);
		expect(sr.mode).toBe("handoff");
		expect(sr.reason).toMatch(/CAPTCHA \(DataDome\)/);
	});

	it("hands off a source with no board and no form filler", () => {
		expect(submissionModeForSource("scrape", null)).toMatchObject({
			mode: "handoff",
			reason: expect.stringMatching(/no automatic form filling yet/),
		});
	});
});

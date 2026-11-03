import { describe, expect, it } from "vitest";

import { submissionModeFor, submissionModeForSource } from "../src/apply/modes";

describe("submission modes", () => {
	it("keeps LinkedIn jobs hand-off even with fixture auto-submission on a local host", () => {
		for (const board of ["ashby", "greenhouse", "lever", null] as const) {
			const decision = submissionModeForSource(
				"linkedin",
				board,
				"http://127.0.0.1:4000/form",
				{ autoSubmitFixtures: true },
			);
			expect(decision.mode).toBe("handoff");
			expect(decision.reason).toMatch(/Easy Apply is never used/);
		}
	});

	it("leaves other sources to their board", () => {
		expect(
			submissionModeForSource(
				"greenhouse",
				"greenhouse",
				"http://127.0.0.1/x",
				{
					autoSubmitFixtures: true,
				},
			),
		).toEqual(
			submissionModeFor("greenhouse", "http://127.0.0.1/x", {
				autoSubmitFixtures: true,
			}),
		);
		expect(
			submissionModeForSource(
				"greenhouse",
				"greenhouse",
				"https://job-boards.greenhouse.io/a/jobs/1",
			).mode,
		).toBe("handoff");
	});
});

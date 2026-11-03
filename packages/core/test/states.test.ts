import { describe, expect, it } from "vitest";

import {
	APPLICATION_STATES,
	type ApplicationState,
	AUTO_DISMISSABLE_STATES,
	assertTransition,
	canTransition,
	InvalidTransitionError,
} from "../src/domain/states";
import { nextAction } from "../src/workflow/flow";

function reachable(from: ApplicationState): Set<ApplicationState> {
	const seen = new Set<ApplicationState>();
	const stack = [from];
	while (stack.length) {
		const state = stack.pop() as ApplicationState;
		for (const next of APPLICATION_STATES) {
			if (canTransition(state, next) && !seen.has(next)) {
				seen.add(next);
				stack.push(next);
			}
		}
	}
	return seen;
}

describe("application state machine", () => {
	it("follows the plan's happy path", () => {
		const path: ApplicationState[] = [
			"found",
			"scored",
			"preparing",
			"needs_answers",
			"preparing",
			"ready_for_review",
			"approved",
			"applying",
			"applied",
		];
		for (let i = 1; i < path.length; i++)
			expect(
				canTransition(
					path[i - 1] as ApplicationState,
					path[i] as ApplicationState,
				),
			).toBe(true);
	});

	it("only enters applying from approved, or a retry from needs_human", () => {
		const into = APPLICATION_STATES.filter((s) => canTransition(s, "applying"));
		expect(into.sort()).toEqual(["approved", "needs_human"]);
		// needs_human is a submission handoff: only applying leads there, so it cannot route around approval.
		expect(
			APPLICATION_STATES.filter((s) => canTransition(s, "needs_human")),
		).toEqual(["applying"]);
	});

	it("has no path from found to applying that skips approved", () => {
		const seen = new Set<ApplicationState>(["found"]);
		const stack: ApplicationState[] = ["found"];
		while (stack.length) {
			const state = stack.pop() as ApplicationState;
			for (const next of APPLICATION_STATES) {
				if (next === "approved" || seen.has(next)) continue;
				if (canTransition(state, next)) {
					seen.add(next);
					stack.push(next);
				}
			}
		}
		expect(seen.has("applying")).toBe(false);
		expect(seen.has("needs_human")).toBe(false);
		expect(canTransition("preparing", "needs_human")).toBe(false);
	});

	it("lets an edit after approval send the application back to review", () => {
		expect(canTransition("approved", "ready_for_review")).toBe(true);
	});

	it("only enters approved from ready_for_review", () => {
		expect(
			APPLICATION_STATES.filter((s) => canTransition(s, "approved")),
		).toEqual(["ready_for_review"]);
	});

	it("never reaches approved or applying from expired", () => {
		expect(reachable("expired").size).toBe(0);
		expect(canTransition("expired", "approved")).toBe(false);
	});

	it("rejects invalid transitions", () => {
		expect(() => assertTransition("found", "approved")).toThrow(
			InvalidTransitionError,
		);
		expect(() => assertTransition("rejected_by_filter", "preparing")).toThrow(
			InvalidTransitionError,
		);
		expect(() => assertTransition("scored", "applying")).toThrow(
			InvalidTransitionError,
		);
	});

	it("dismisses only a found job or a listed match, and undo returns it there", () => {
		expect(
			APPLICATION_STATES.filter((s) => canTransition(s, "dismissed")).sort(),
		).toEqual(["found", "scored"]);
		expect([...AUTO_DISMISSABLE_STATES].sort()).toEqual(["found", "scored"]);
		expect(canTransition("dismissed", "scored")).toBe(true);
		expect(canTransition("dismissed", "found")).toBe(true);
		// Nothing past a match: no draft, review, approval or submission from dismissed.
		for (const to of [
			"preparing",
			"ready_for_review",
			"approved",
			"applying",
			"applied",
		] as const)
			expect(canTransition("dismissed", to)).toBe(false);
		for (const from of [
			"preparing",
			"needs_answers",
			"ready_for_review",
			"approved",
			"applying",
			"needs_human",
			"applied",
		] as const)
			expect(canTransition(from, "dismissed")).toBe(false);
	});

	it("ends the workflow on a dismissed application", () => {
		expect(nextAction("dismissed")).toEqual({
			kind: "done",
			state: "dismissed",
		});
	});

	it("lets the user bring a set-aside job back as a match, and no further", () => {
		expect(canTransition("rejected_by_filter", "scored")).toBe(true);
		expect(canTransition("rejected_by_filter", "found")).toBe(true);
		for (const to of [
			"preparing",
			"ready_for_review",
			"approved",
			"applying",
		] as const)
			expect(canTransition("rejected_by_filter", to)).toBe(false);
	});
});

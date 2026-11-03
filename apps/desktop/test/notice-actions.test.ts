import { describe, expect, it, vi } from "vitest";

import {
	type NoticeActionDeps,
	noticeButtons,
	runNoticeAction,
} from "../src/main/notice-actions";

function deps(outcome: "dismissed" | "stale" | Error = "dismissed") {
	const logged: string[] = [];
	const d = {
		open: vi.fn(),
		dismiss: vi.fn(async () => {
			if (outcome instanceof Error) throw outcome;
			return outcome;
		}),
		log: (message: string) => logged.push(message),
	} satisfies NoticeActionDeps;
	return { d, logged };
}

const one = {
	path: "/applications/a1",
	actions: ["open", "dismiss"] as ("open" | "dismiss")[],
	applicationId: "a1",
};

describe("notification buttons", () => {
	it("labels them as the app does, in order", () => {
		expect(noticeButtons(["open", "dismiss"])).toEqual([
			{ type: "button", text: "Open" },
			{ type: "button", text: "Not interested" },
		]);
		expect(noticeButtons(undefined)).toEqual([]);
	});

	it("Open opens what a click opens", async () => {
		const { d } = deps();
		await runNoticeAction(one, 0, d);
		expect(d.open).toHaveBeenCalledWith("/applications/a1");
		expect(d.dismiss).not.toHaveBeenCalled();
	});

	it("Not interested dismisses that one match and opens nothing", async () => {
		const { d, logged } = deps();
		await runNoticeAction(one, 1, d);
		expect(d.dismiss).toHaveBeenCalledWith("a1");
		expect(d.open).not.toHaveBeenCalled();
		expect(logged).toEqual(["notification action: match dismissed"]);
	});

	it("a match already decided or gone: nothing changes, one log line", async () => {
		const { d, logged } = deps("stale");
		await runNoticeAction(one, 1, d);
		expect(d.open).not.toHaveBeenCalled();
		expect(logged).toEqual([
			"notification action: match already decided or gone, nothing changed",
		]);
	});

	it("a failed dismiss is logged, not thrown", async () => {
		const { d, logged } = deps(new Error("Starting"));
		await expect(runNoticeAction(one, 1, d)).resolves.toBeUndefined();
		expect(logged).toEqual(["notification action failed"]);
	});

	it("an index the notification never offered does nothing", async () => {
		const { d, logged } = deps();
		const many = { path: "/inbox?view=matches", actions: ["open" as const] };
		await runNoticeAction(many, 1, d);
		await runNoticeAction({ ...many, actions: ["dismiss"] }, 0, d);
		expect(d.open).not.toHaveBeenCalled();
		expect(d.dismiss).not.toHaveBeenCalled();
		expect(logged).toHaveLength(2);
	});
});

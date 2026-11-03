import { describe, expect, it } from "vitest";
import {
	SETUP_STEPS,
	setupProgress,
	timeLeft,
} from "../src/shared/setup-steps";

describe("setup progress from the eight-step setup", () => {
	it("reads nothing as nothing", () => {
		expect(setupProgress({ done: [], skipped: [] })).toEqual({
			done: [],
			skipped: [],
		});
	});

	it("maps every earlier step onto the five", () => {
		const all = [
			"ai",
			"resume",
			"profile",
			"rules",
			"watchlist",
			"notifications",
			"login",
			"scan",
		];
		expect(setupProgress({ done: all, skipped: [] }).done).toEqual([
			...SETUP_STEPS,
		]);
	});

	it("a merged step is done only when both earlier parts are", () => {
		const p = setupProgress({
			done: ["ai", "resume", "profile", "rules", "notifications"],
			skipped: [],
		});
		expect(p.done).toEqual(["ai", "profile"]);
	});

	it("a draft made but never saved does not finish the profile", () => {
		expect(setupProgress({ done: ["ai", "resume"], skipped: [] }).done).toEqual(
			["ai"],
		);
	});

	it("keeps skips: a merged step with a skipped part reads as skipped", () => {
		const p = setupProgress({
			done: ["ai", "notifications", "login"],
			skipped: ["ai", "login"],
		});
		expect(p).toEqual({ done: ["ai", "loop"], skipped: ["ai", "loop"] });
	});

	it("reads the new keys, and its own key wins over the earlier parts", () => {
		const p = setupProgress({
			done: ["wants", "rules", "loop"],
			skipped: ["rules"],
		});
		expect(p).toEqual({ done: ["wants", "loop"], skipped: [] });
	});

	it("mixes both versions' keys", () => {
		const p = setupProgress({
			done: ["ai", "profile", "rules", "watchlist", "loop", "scan"],
			skipped: ["scan"],
		});
		expect(p.done).toEqual([...SETUP_STEPS]);
		expect(p.skipped).toEqual(["scan"]);
	});
});

describe("time left", () => {
	it("counts the current step and the open ones after it", () => {
		expect(timeLeft("ai", [])).toBe("about 5 minutes left");
		expect(timeLeft("wants", ["ai", "profile"])).toBe("about 3 minutes left");
		expect(timeLeft("ai", ["profile", "wants", "loop", "scan"])).toBe(
			"about a minute left",
		);
		expect(timeLeft("scan", [])).toBe("about a minute left");
	});
});

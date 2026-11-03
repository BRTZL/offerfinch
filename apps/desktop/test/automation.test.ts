import { describe, expect, it } from "vitest";

import { isAutomated } from "../src/main/automation";

/** Codex review of b74f1bc: the guard missed --inspect-brk=9229 and --remote-debugging-pipe. */
describe("the automation guard", () => {
	it("recognizes every remote debugging and inspector form", () => {
		for (const arg of [
			"--remote-debugging-port=0",
			"--remote-debugging-port",
			"--remote-debugging-pipe",
			"--inspect",
			"--inspect=9229",
			"--inspect-brk",
			"--inspect-brk=9229",
			"--inspect-wait",
			"--inspect-port=0",
		])
			expect(isAutomated(["/Applications/OfferFinch.app", arg]), arg).toBe(
				true,
			);
		expect(isAutomated(["OfferFinch"], "--inspect-brk=127.0.0.1:9229")).toBe(
			true,
		);
	});

	it("leaves an ordinary launch alone", () => {
		expect(isAutomated(["OfferFinch", "--offerfinch-vibrant"], "")).toBe(false);
		expect(
			isAutomated(
				["OfferFinch", "--inspector-theme=dark"],
				"--max-old-space-size=512",
			),
		).toBe(false);
	});
});

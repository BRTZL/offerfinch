import { describe, expect, it } from "vitest";

import { fixFor } from "../src/renderer/components/pipeline/settings/source-fix";

const linkedin = { signIn: true };
const held = { enabled: true, stop: { kind: "login_wall" } };

describe("a source row's action", () => {
	it("a sign-in wall: Sign in while the site asks, then Retry now once signed in again", () => {
		expect(fixFor(linkedin, held, { signIn: "needed" }, false)).toBe("sign-in");
		expect(fixFor(linkedin, held, { signIn: null }, false)).toBe("sign-in");
		expect(fixFor(linkedin, held, { signIn: "signed-in" }, false)).toBe(
			"retry",
		);
	});

	it("a run or a check: Watch live comes first", () => {
		expect(
			fixFor(linkedin, held, { signIn: "needed", running: true }, false),
		).toBe("watch");
		expect(fixFor({ signIn: false }, { enabled: true }, {}, true)).toBe(
			"watch",
		);
	});

	it("another stop: Retry now; nothing wrong: no action, or Sign in where it is missing", () => {
		expect(
			fixFor(
				{ signIn: false },
				{ enabled: true, stop: { kind: "selectors" } },
				{},
				false,
			),
		).toBe("retry");
		expect(fixFor({ signIn: false }, { enabled: true }, {}, false)).toBeNull();
		expect(fixFor(linkedin, { enabled: false }, { signIn: null }, false)).toBe(
			"sign-in",
		);
		expect(
			fixFor(linkedin, { enabled: true }, { signIn: "signed-in" }, false),
		).toBeNull();
	});
});

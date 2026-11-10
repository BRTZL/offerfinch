import { describe, expect, it } from "vitest";
import { IPC } from "../src/shared/bridge";

/**
 * Review fix (2026-11-09): the page cannot ask main to open a URL it names. Its links name an
 * application (and the attempt it showed); the worker resolves them (worker/links.ts).
 */
describe("the bridge's links", () => {
	it("has no channel that opens a URL the page names", () => {
		expect(IPC).not.toHaveProperty("openExternal");
		expect(IPC).toMatchObject({
			openPosting: expect.any(String),
			openApplicationForm: expect.any(String),
		});
	});
});

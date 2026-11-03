import { describe, expect, it } from "vitest";

import { snapshotScript } from "../src/main/page-read";

/** Just enough of a DOM for the read: elements, text nodes, matches and checkVisibility. */
type Fake = {
	nodeType: number;
	nodeValue?: string;
	childNodes?: Fake[];
	shown?: boolean;
	cls?: string;
};
const text = (value: string): Fake => ({ nodeType: 3, nodeValue: value });
const el = (children: Fake[], shown = true, cls = ""): Fake => ({
	nodeType: 1,
	childNodes: children,
	shown,
	cls,
});

function run(body: Fake, exclude: string) {
	const element = (f: Fake): unknown => ({
		nodeType: f.nodeType,
		nodeValue: f.nodeValue,
		childNodes: (f.childNodes ?? []).map(element),
		matches: (selector: string) => selector === `.${f.cls}`,
		checkVisibility: () => f.shown !== false,
	});
	const document = {
		body: element(body),
		doctype: null,
		documentElement: { outerHTML: "<html></html>" },
		title: "Security | Glassdoor",
	};
	return new Function(
		"document",
		"XMLSerializer",
		`return ${snapshotScript(exclude)}`,
	)(document, class {}) as { html: string; title: string; text: string };
}

describe("the site tab's page read", () => {
	it("gives the shown text, whitespace collapsed and every letter kept", () => {
		const page = run(
			el([
				el([text("Help Us   Protect\n Glassdoor")]),
				el([text("Sign in to see more")], false),
			]),
			"",
		);
		expect(page.text).toBe("Help Us Protect Glassdoor");
		expect(page.title).toBe("Security | Glassdoor");
	});

	it("leaves out the posting's own text", () => {
		const page = run(
			el([
				text("Jobs"),
				el([text("unusual activity in our fraud team")], true, "desc"),
			]),
			".desc",
		);
		expect(page.text).toBe("Jobs");
	});
});

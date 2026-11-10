import { describe, expect, it } from "vitest";
import { findMatches, locate, type TextPiece } from "../src/renderer/lib/find";

const slices = (text: string, query: string) =>
	findMatches(text, query).map(([a, b]) => text.slice(a, b));

/** ⌘F in an open application (components/system/find-bar.tsx). */
describe("find", () => {
	it("matches case-insensitively, every occurrence, in order", () => {
		expect(slices("Kotlin, kotlin and KOTLIN", "kotlin")).toEqual([
			"Kotlin",
			"kotlin",
			"KOTLIN",
		]);
		expect(slices("anything", "  ")).toEqual([]);
	});

	it("takes the query literally, and any run of spaces as space", () => {
		expect(slices("C++ and C#; (remote)", "c++")).toEqual(["C++"]);
		expect(slices("(remote)", "(remote)")).toEqual(["(remote)"]);
		expect(
			slices("Senior  Engineer, Senior\nEngineer", "senior engineer"),
		).toEqual(["Senior  Engineer", "Senior\nEngineer"]);
	});

	it("matches Turkish dotted and dotless i both ways, with offsets on the original text", () => {
		const text = "İzmir, ISPARTA, ılık, izmir";
		expect(slices(text, "izmir")).toEqual(["İzmir", "izmir"]);
		expect(slices(text, "İZMİR")).toEqual(["İzmir", "izmir"]);
		expect(slices(text, "ilik")).toEqual(["ılık"]);
		expect(slices(text, "isparta")).toEqual(["ISPARTA"]);
	});

	it("never matches across a block break", () => {
		expect(slices("Kotlin\u0000Android", "kotlin android")).toEqual([]);
		expect(slices("Kotlin\u0000Android", "linAnd")).toEqual([]);
	});

	it("locates a phrase that crosses bold text in its first and last nodes", () => {
		// "Strong **Kotlin** skills" as three text nodes.
		const parts = ["Strong ", "Kotlin", " skills"];
		let at = 0;
		const pieces: TextPiece<string>[] = parts.map((node) => {
			const piece = { node, start: at, length: node.length };
			at += node.length;
			return piece;
		});
		const text = parts.join("");
		const [match] = findMatches(text, "strong kotlin sk");
		expect(match).toBeDefined();
		expect(locate(pieces, match as [number, number])).toEqual({
			startNode: "Strong ",
			startOffset: 0,
			endNode: " skills",
			endOffset: 3,
		});
		// A match ending exactly at a node's end stays in that node.
		const [kotlin] = findMatches(text, "kotlin");
		expect(locate(pieces, kotlin as [number, number])).toEqual({
			startNode: "Kotlin",
			startOffset: 0,
			endNode: "Kotlin",
			endOffset: 6,
		});
	});
});

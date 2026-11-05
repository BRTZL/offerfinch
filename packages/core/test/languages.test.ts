import { describe, expect, it } from "vitest";
import { LANGUAGES } from "../src/filter/languages";
import { parseFilterSettings } from "../src/filter/settings";

describe("languages in Job search", () => {
	it("are offered by their own names", () => {
		expect(LANGUAGES).toEqual(
			expect.arrayContaining(["English", "Türkçe", "Deutsch", "Français"]),
		);
	});

	it("store an English or lower-case name as the native one, once, keeping unknown ones", () => {
		const { languages } = parseFilterSettings({
			languages: ["Turkish", "türkçe", " english ", "German", "Klingon", ""],
		});
		expect(languages).toEqual(["Türkçe", "English", "Deutsch", "Klingon"]);
	});

	it("default to English", () => {
		expect(parseFilterSettings({}).languages).toEqual(["English"]);
	});
});

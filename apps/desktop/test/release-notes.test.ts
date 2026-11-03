import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	compareVersions,
	notesUpTo,
	parseChangelog,
	whatsNew,
} from "../src/shared/release-notes";

const CHANGELOG = `# What's new

<!-- a note for maintainers -->

## Unreleased

- Coming soon.

## 1.2.0 (2026-11-03)

- Twelve.

## 1.1.0 - 2026-10-20

- Eleven.

## 1.0.0

- One.
`;
const sections = parseChangelog(CHANGELOG);

describe("the bundled changelog", () => {
	it("splits into sections, newest first, with their dates", () => {
		expect(sections.map((s) => [s.version, s.date, s.body])).toEqual([
			["Unreleased", null, "- Coming soon."],
			["1.2.0", "2026-11-03", "- Twelve."],
			["1.1.0", "2026-10-20", "- Eleven."],
			["1.0.0", null, "- One."],
		]);
	});

	it("has notes for the app's version, before and after the release script dates them", () => {
		const app = path.join(import.meta.dirname, "..");
		const text = fs.readFileSync(path.join(app, "CHANGELOG.md"), "utf8");
		const version = JSON.parse(
			fs.readFileSync(path.join(app, "package.json"), "utf8"),
		).version as string;
		// Between releases the notes wait under Unreleased; on a tag they carry its version.
		const ready = (changelog: string, v: string) =>
			parseChangelog(changelog).some(
				(s) =>
					(s.version === v || s.version === "Unreleased") && s.body.length > 0,
			);
		expect(ready(text, version)).toBe(true);
		// What scripts/release.mjs does to it on a bump: the notes become that version's.
		const dated = text.replace(
			/^## Unreleased[ \t]*$/m,
			"## 99.0.0 (2026-11-03)",
		);
		expect(ready(dated, "99.0.0")).toBe(true);
		expect(
			whatsNew({
				version: "99.0.0",
				seen: version,
				usedBefore: true,
				sections: parseChangelog(dated),
			}).kind,
		).toBe(text === dated ? "record" : "show");
	});

	it("compares versions by number, not by text", () => {
		expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
		expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
		expect(compareVersions("0.9.9", "1.0.0")).toBeLessThan(0);
	});

	it("puts a preview after the version before it and before its release", () => {
		expect(compareVersions("1.2.1-preview.1", "1.2.0")).toBeGreaterThan(0);
		expect(compareVersions("1.2.1-preview.1", "1.2.1")).toBeLessThan(0);
		expect(compareVersions("1.2.1-preview.2", "1.2.1-preview.10")).toBeLessThan(
			0,
		);
		expect(compareVersions("1.2.1-preview.3", "1.2.1-preview.3")).toBe(0);
	});
});

describe("what's new after an update", () => {
	const decide = (version: string, seen: string, usedBefore = true) =>
		whatsNew({ version, seen, usedBefore, sections });

	it("shows a new version's notes once, then never for the same version", () => {
		const first = decide("1.2.0", "1.1.0");
		expect(
			first.kind === "show" && first.sections.map((s) => s.version),
		).toEqual(["1.2.0"]);
		// Closing the sheet stores 1.2.0 as seen: the next start on 1.2.0 shows nothing.
		expect(decide("1.2.0", "1.2.0")).toEqual({ kind: "none" });
	});

	it("shows every version an update skipped", () => {
		const skipped = decide("1.2.0", "1.0.0");
		expect(
			skipped.kind === "show" && skipped.sections.map((s) => s.version),
		).toEqual(["1.2.0", "1.1.0"]);
	});

	it("shows nothing on a fresh install, and stores the version", () => {
		expect(decide("1.2.0", "", false)).toEqual({ kind: "record" });
	});

	it("treats a database used before What's new existed as an upgrade", () => {
		const upgrade = decide("1.2.0", "", true);
		expect(
			upgrade.kind === "show" && upgrade.sections.map((s) => s.version),
		).toEqual(["1.2.0"]);
	});

	it("stores a version without notes rather than showing an empty sheet", () => {
		expect(decide("1.3.0", "1.2.0")).toEqual({ kind: "record" });
		expect(decide("0.1.0", "", true)).toEqual({ kind: "record" });
	});

	it("never shows the unreleased notes after an update", () => {
		const result = decide("1.2.0", "1.1.0");
		expect(
			result.kind === "show" &&
				result.sections.some((s) => s.version === "Unreleased"),
		).toBe(false);
	});
});

describe("Settings › What's new", () => {
	it("shows this version's notes and the ones before it", () => {
		expect(notesUpTo("1.1.0", sections).map((s) => s.version)).toEqual([
			"1.1.0",
			"1.0.0",
		]);
	});

	it("shows the upcoming notes first in a build made before its release", () => {
		expect(notesUpTo("1.3.0", sections).map((s) => s.version)).toEqual([
			"Unreleased",
			"1.2.0",
			"1.1.0",
		]);
	});

	it("a preview shows the upcoming notes and the releases before it", () => {
		expect(
			notesUpTo("1.2.1-preview.1", sections).map((s) => s.version),
		).toEqual(["Unreleased", "1.2.0", "1.1.0"]);
	});
});

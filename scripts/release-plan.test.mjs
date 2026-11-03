import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import {
	applyVersion,
	bumpVersion,
	changelogSection,
	compareVersions,
	nextPreview,
	parseVersion,
	planRelease,
} from "./release-plan.mjs";

const CHANGELOG = `# What's new in OfferFinch

<!-- comment -->

## Unreleased

### Inbox

- Something new.

## 0.1.0 (2026-10-01)

- First release.
`;

const base = {
	pkgVersion: "0.1.0",
	tags: ["v0.1.0"],
	changelog: CHANGELOG,
	commits: ["- Fix a thing (abc1234)"],
};

describe("versions", () => {
	test("parses stable and preview versions, and refuses others", () => {
		assert.deepEqual(parseVersion("1.2.3"), {
			major: 1,
			minor: 2,
			patch: 3,
			preview: null,
		});
		assert.equal(parseVersion("1.2.3-preview.4").preview, 4);
		for (const bad of ["1.2", "v1.2.3", "1.2.3-beta.1", "1.2.3-preview"])
			assert.throws(() => parseVersion(bad));
	});

	test("orders a preview before its stable version", () => {
		assert.ok(compareVersions("0.1.1-preview.1", "0.1.0") > 0);
		assert.ok(compareVersions("0.1.1-preview.1", "0.1.1") < 0);
		assert.ok(compareVersions("0.1.1-preview.2", "0.1.1-preview.10") < 0);
		assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
		assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
	});

	test("bumps patch, minor and major", () => {
		assert.equal(bumpVersion("0.1.9", "patch"), "0.1.10");
		assert.equal(bumpVersion("0.1.9", "minor"), "0.2.0");
		assert.equal(bumpVersion("0.1.9", "major"), "1.0.0");
		assert.throws(() => bumpVersion("0.1.0", "nightly"));
		assert.throws(() => bumpVersion("0.1.1-preview.1", "patch"));
	});

	test("the next preview is the next patch, one past its highest tag", () => {
		assert.equal(nextPreview("0.1.0", ["v0.1.0"]), "0.1.1-preview.1");
		assert.equal(
			nextPreview("0.1.0", [
				"v0.1.1-preview.1",
				"v0.1.1-preview.3",
				"v0.1.2-preview.7",
				"v0.1.0",
			]),
			"0.1.1-preview.4",
		);
	});
});

describe("changelog", () => {
	test("reads a section up to the next one", () => {
		assert.equal(
			changelogSection(CHANGELOG, "Unreleased"),
			"### Inbox\n\n- Something new.",
		);
		assert.equal(changelogSection(CHANGELOG, "0.1.0"), "- First release.");
		assert.equal(changelogSection(CHANGELOG, "0.2.0"), null);
		// 0.1.0 must not match a 0.1.0x heading.
		assert.equal(changelogSection("## 0.1.01\n\nx\n", "0.1.0"), null);
	});
});

describe("planRelease on a tag push", () => {
	test("a stable tag takes its version's notes", () => {
		const plan = planRelease({ ...base, event: "push", ref: "v0.1.0" });
		assert.deepEqual(plan, {
			channel: "stable",
			version: "0.1.0",
			tag: "v0.1.0",
			prerelease: false,
			notes: "- First release.",
		});
	});

	test("a stable tag must match package.json", () => {
		assert.throws(
			() => planRelease({ ...base, event: "push", ref: "v0.1.1" }),
			/does not match/,
		);
	});

	test("a stable tag needs notes", () => {
		assert.throws(
			() =>
				planRelease({
					...base,
					changelog: "## 0.1.0 (2026-10-01)\n\n## 0.0.9\n- old\n",
					event: "push",
					ref: "v0.1.0",
				}),
			/no notes under "## 0.1.0"/,
		);
	});

	test("a preview tag is a prerelease with Unreleased and the commits", () => {
		const plan = planRelease({
			...base,
			event: "push",
			ref: "v0.1.1-preview.2",
		});
		assert.equal(plan.channel, "preview");
		assert.equal(plan.prerelease, true);
		assert.equal(plan.version, "0.1.1-preview.2");
		assert.match(plan.notes, /- Something new\./);
		assert.match(plan.notes, /Commits since the last release\n\n- Fix a thing/);
	});

	test("a preview must be newer than the stable version", () => {
		assert.throws(
			() => planRelease({ ...base, event: "push", ref: "v0.1.0-preview.1" }),
			/not newer/,
		);
	});

	test("refuses tags that are not release tags", () => {
		for (const ref of ["v0.1", "0.1.0", "v0.1.1-beta.1", "main"])
			assert.throws(() => planRelease({ ...base, event: "push", ref }));
	});
});

describe("planRelease from the Release button", () => {
	test("stable bumps package.json and takes the Unreleased notes", () => {
		const plan = planRelease({
			...base,
			event: "workflow_dispatch",
			channel: "stable",
			bump: "minor",
		});
		assert.equal(plan.version, "0.2.0");
		assert.equal(plan.tag, "v0.2.0");
		assert.equal(plan.prerelease, false);
		assert.equal(plan.notes, "### Inbox\n\n- Something new.");
	});

	test("stable refuses an empty Unreleased section", () => {
		assert.throws(
			() =>
				planRelease({
					...base,
					changelog: "## Unreleased\n\n## 0.1.0\n- x\n",
					event: "workflow_dispatch",
					channel: "stable",
					bump: "patch",
				}),
			/no notes under "## Unreleased"/,
		);
	});

	test("stable refuses a version whose tag exists", () => {
		assert.throws(
			() =>
				planRelease({
					...base,
					tags: ["v0.1.0", "v0.1.1"],
					event: "workflow_dispatch",
					channel: "stable",
					bump: "patch",
				}),
			/already exists/,
		);
	});

	test("preview ignores the bump and takes the next free number", () => {
		const plan = planRelease({
			...base,
			tags: ["v0.1.0", "v0.1.1-preview.1"],
			event: "workflow_dispatch",
			channel: "preview",
			bump: "major",
		});
		assert.equal(plan.version, "0.1.1-preview.2");
		assert.equal(plan.prerelease, true);
	});

	test("a preview with no notes and no commits still says so", () => {
		const plan = planRelease({
			...base,
			changelog: "## 0.1.0\n- x\n",
			commits: [],
			event: "workflow_dispatch",
			channel: "preview",
		});
		assert.equal(plan.notes, "No changes listed.");
	});

	test("refuses an unknown channel or event", () => {
		assert.throws(() =>
			planRelease({ ...base, event: "workflow_dispatch", channel: "nightly" }),
		);
		assert.throws(() => planRelease({ ...base, event: "schedule" }));
	});
});

describe("applyVersion", () => {
	const pkgText = '{\n\t"name": "x",\n\t"version": "0.1.0"\n}\n';

	test("stable sets the version and dates Unreleased, once", () => {
		const once = applyVersion({
			pkgText,
			changelog: CHANGELOG,
			version: "0.2.0",
			date: "2026-11-03",
		});
		assert.equal(JSON.parse(once.pkgText).version, "0.2.0");
		assert.match(once.changelog, /^## 0\.2\.0 \(2026-11-03\)$/m);
		assert.doesNotMatch(once.changelog, /## Unreleased/);
		const twice = applyVersion({
			...once,
			version: "0.2.0",
			date: "2026-11-04",
		});
		assert.deepEqual(twice, once);
	});

	test("a stable version that is already dated keeps a new Unreleased", () => {
		const changelog =
			"## Unreleased\n\n- later\n\n## 0.1.0 (2026-10-01)\n\n- x\n";
		const out = applyVersion({
			pkgText,
			changelog,
			version: "0.1.0",
			date: "2026-11-03",
		});
		assert.equal(out.changelog, changelog);
	});

	test("a preview only sets the version", () => {
		const out = applyVersion({
			pkgText,
			changelog: CHANGELOG,
			version: "0.1.1-preview.1",
			date: "2026-11-03",
		});
		assert.equal(JSON.parse(out.pkgText).version, "0.1.1-preview.1");
		assert.equal(out.changelog, CHANGELOG);
	});
});

describe("the CLI", () => {
	test("resolves a preview from a git repository and applies it", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-plan-"));
		try {
			const run = (cmd, args, env = {}) =>
				execFileSync(cmd, args, {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, ...env },
				});
			fs.mkdirSync(path.join(dir, "apps/desktop"), { recursive: true });
			fs.mkdirSync(path.join(dir, "scripts"));
			fs.copyFileSync(
				path.join(import.meta.dirname, "release-plan.mjs"),
				path.join(dir, "scripts/release-plan.mjs"),
			);
			fs.writeFileSync(
				path.join(dir, "apps/desktop/package.json"),
				'{\n\t"version": "0.1.0"\n}\n',
			);
			fs.writeFileSync(path.join(dir, "apps/desktop/CHANGELOG.md"), CHANGELOG);
			const id = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];
			run("git", ["init", "-q", "-b", "main"]);
			run("git", [...id, "add", "."]);
			run("git", [...id, "commit", "-qm", "Release 0.1.0"]);
			run("git", ["tag", "v0.1.0"]);
			run("git", [...id, "commit", "-q", "--allow-empty", "-m", "Add inbox"]);
			const notes = path.join(dir, "notes.md");
			const out = run(
				"node",
				["scripts/release-plan.mjs", "resolve", "--notes", notes],
				{
					RELEASE_EVENT: "workflow_dispatch",
					RELEASE_CHANNEL: "preview",
					RELEASE_BUMP: "patch",
					GITHUB_OUTPUT: "",
				},
			);
			assert.match(out, /^version=0\.1\.1-preview\.1$/m);
			assert.match(out, /^prerelease=true$/m);
			const text = fs.readFileSync(notes, "utf8");
			assert.match(text, /- Add inbox \([0-9a-f]+\)/);
			assert.doesNotMatch(text, /Release 0\.1\.0/);
			assert.match(out, /^date=\d{4}-\d{2}-\d{2}$/m);
			run("node", ["scripts/release-plan.mjs", "apply", "0.1.1-preview.1"]);
			assert.equal(
				JSON.parse(
					fs.readFileSync(path.join(dir, "apps/desktop/package.json"), "utf8"),
				).version,
				"0.1.1-preview.1",
			);
			// A stable version is dated with the date it is given (resolve's), not today.
			run("node", [
				"scripts/release-plan.mjs",
				"apply",
				"0.2.0",
				"--date",
				"2026-01-02",
			]);
			assert.match(
				fs.readFileSync(path.join(dir, "apps/desktop/CHANGELOG.md"), "utf8"),
				/^## 0\.2\.0 \(2026-01-02\)$/m,
			);
			assert.throws(
				() =>
					run("node", [
						"scripts/release-plan.mjs",
						"apply",
						"0.2.0",
						"--date",
						"tomorrow",
					]),
				/Not a date/,
			);
			// A stable tag that does not match fails with the reason.
			assert.throws(
				() =>
					run(
						"node",
						["scripts/release-plan.mjs", "resolve", "--notes", notes],
						{ RELEASE_EVENT: "push", RELEASE_REF: "v9.9.9" },
					),
				/does not match/,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

// Starts a stable release from this Mac: bumps apps/desktop/package.json, dates the changelog,
// commits, tags v<version> and pushes. The tag starts .github/workflows/desktop-release.yml, which tests,
// signs, notarizes and publishes the release that installed apps update from. The Release button
// in GitHub Actions does the same without a local checkout (docs/releasing.md).
//
// Usage: pnpm --filter @offerfinch/desktop release <patch|minor|major|x.y.z> [--dry-run]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
	applyVersion,
	bumpVersion,
	changelogSection,
	compareVersions,
} from "../../../scripts/release-plan.mjs";

const app = path.resolve(import.meta.dirname, "..");
const root = path.resolve(app, "../..");
const pkgPath = path.join(app, "package.json");
const changelogPath = path.join(app, "CHANGELOG.md");
const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const bump = args.find((a) => !a.startsWith("--"));

const git = (...a) =>
	execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const fail = (message) => {
	console.error(message);
	process.exit(1);
};

if (!bump) fail("Usage: pnpm release <patch|minor|major|x.y.z> [--dry-run]");

const pkgText = fs.readFileSync(pkgPath, "utf8");
const current = JSON.parse(pkgText).version;
let next;
if (/^\d+\.\d+\.\d+$/.test(bump)) next = bump;
else if (["patch", "minor", "major"].includes(bump))
	next = bumpVersion(current, bump);
else fail(`Not a version or bump: ${bump}`);

if (compareVersions(next, current) <= 0)
	fail(
		`${next} is not newer than ${current}: installed apps would not update to it.`,
	);

if (git("status", "--porcelain")) fail("Commit or stash your changes first.");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main") fail(`Release from main (you are on ${branch}).`);
const tag = `v${next}`;
if (git("tag", "--list", tag)) fail(`Tag ${tag} already exists.`);

// What's new shows the running version's section of the bundled changelog: the notes written
// under "Unreleased" become this version's. An empty section would release with no notes.
const changelog = fs.readFileSync(changelogPath, "utf8");
if (!changelogSection(changelog, "Unreleased"))
	fail(
		'CHANGELOG.md has no notes under "## Unreleased": write what changed for users first.',
	);
const applied = applyVersion({
	pkgText,
	changelog,
	version: next,
	date: new Date().toISOString().slice(0, 10),
});

console.log(`OfferFinch ${current} -> ${next} (tag ${tag})`);
if (dry) {
	console.log("Dry run: nothing changed.");
	process.exit(0);
}

fs.writeFileSync(pkgPath, applied.pkgText);
fs.writeFileSync(changelogPath, applied.changelog);
git("add", pkgPath, changelogPath);
git("commit", "-m", `Release ${next}`);
git("tag", "-a", tag, "-m", `OfferFinch ${next}`);
git("push", "origin", "main", tag);
console.log(
	`Pushed ${tag}. The Release workflow builds, notarizes and publishes it: gh run watch`,
);

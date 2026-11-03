// Starts a release: bumps apps/desktop/package.json, commits, tags v<version> and pushes.
// The tag starts .github/workflows/desktop-release.yml, which tests, signs, notarizes and
// publishes the release that installed apps update from.
//
// Usage: pnpm --filter @offerfinch/desktop release <patch|minor|major|x.y.z> [--dry-run]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
const parts = current.split(".").map(Number);
let next;
if (bump === "patch") next = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
else if (bump === "minor") next = `${parts[0]}.${parts[1] + 1}.0`;
else if (bump === "major") next = `${parts[0] + 1}.0.0`;
else if (/^\d+\.\d+\.\d+$/.test(bump)) next = bump;
else fail(`Not a version or bump: ${bump}`);

const newer = (a, b) => {
	const [x, y] = [a, b].map((v) => v.split(".").map(Number));
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
	return false;
};
if (!newer(next, current))
	fail(
		`${next} is not newer than ${current}: installed apps would not update to it.`,
	);

if (git("status", "--porcelain")) fail("Commit or stash your changes first.");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main") fail(`Release from main (you are on ${branch}).`);
const tag = `v${next}`;
if (git("tag", "--list", tag)) fail(`Tag ${tag} already exists.`);

// What's new shows the running version's section of the bundled changelog: the notes written
// under "Unreleased" become this version's.
const changelog = fs.readFileSync(changelogPath, "utf8");
const unreleased = /^## Unreleased[ \t]*$/m;
// The notes under it, up to the next section; an empty section would release with no notes.
const notes = changelog.split(unreleased)[1]?.split(/^## /m)[0] ?? "";
if (!notes.trim())
	fail(
		'CHANGELOG.md has no notes under "## Unreleased": write what changed for users first.',
	);
const datedChangelog = changelog.replace(
	unreleased,
	`## ${next} (${new Date().toISOString().slice(0, 10)})`,
);

console.log(`OfferFinch ${current} -> ${next} (tag ${tag})`);
if (dry) {
	console.log("Dry run: nothing changed.");
	process.exit(0);
}

fs.writeFileSync(
	pkgPath,
	pkgText.replace(`"version": "${current}"`, `"version": "${next}"`),
);
fs.writeFileSync(changelogPath, datedChangelog);
git("add", pkgPath, changelogPath);
git("commit", "-m", `Release ${next}`);
git("tag", "-a", tag, "-m", `OfferFinch ${next}`);
git("push", "origin", "main", tag);
console.log(
	`Pushed ${tag}. The Desktop release workflow builds, notarizes and publishes it: gh run watch`,
);

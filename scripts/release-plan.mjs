// Decides what a release run builds: the channel, the version, the tag and the release notes
// (.github/workflows/desktop-release.yml, resolve job), and stamps that version into the tree before a
// build (apply). The rules are pure functions below, tested in release-plan.test.mjs; the CLI
// only reads git, package.json and the changelog. See docs/releasing.md.
//
// Usage:
//   node scripts/release-plan.mjs resolve --notes <file>
//     RELEASE_EVENT=push|workflow_dispatch, RELEASE_REF=<tag on push>, RELEASE_CHANNEL and
//     RELEASE_BUMP (dispatch). Writes version, tag, channel and prerelease to $GITHUB_OUTPUT
//     (or stdout) and the release notes to <file>.
//   node scripts/release-plan.mjs apply <version>
//     Sets apps/desktop/package.json to <version>; a stable version also dates the changelog's
//     "## Unreleased" section as that version's. Running it twice changes nothing more.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+))?$/;
const TAG = /^v(\d+\.\d+\.\d+(?:-preview\.\d+)?)$/;

/** `1.2.3` or `1.2.3-preview.4`; anything else throws. */
export function parseVersion(version) {
	const m = VERSION.exec(version);
	if (!m) throw new Error(`Not a release version: ${version}`);
	return {
		major: Number(m[1]),
		minor: Number(m[2]),
		patch: Number(m[3]),
		preview: m[4] === undefined ? null : Number(m[4]),
	};
}

/** Semver order: a preview sorts before the stable version it leads to. */
export function compareVersions(a, b) {
	const [x, y] = [parseVersion(a), parseVersion(b)];
	for (const k of ["major", "minor", "patch"])
		if (x[k] !== y[k]) return x[k] - y[k];
	if (x.preview === y.preview) return 0;
	if (x.preview === null) return 1;
	if (y.preview === null) return -1;
	return x.preview - y.preview;
}

/** The next stable version after `current` (a stable version) for patch, minor or major. */
export function bumpVersion(current, bump) {
	const v = parseVersion(current);
	if (v.preview !== null)
		throw new Error(`${current} is a preview: bump from the stable version`);
	if (bump === "patch") return `${v.major}.${v.minor}.${v.patch + 1}`;
	if (bump === "minor") return `${v.major}.${v.minor + 1}.0`;
	if (bump === "major") return `${v.major + 1}.0.0`;
	throw new Error(`Not a bump: ${bump} (patch, minor or major)`);
}

/** The next patch after `current` as `-preview.N`, N one past the highest such tag. */
export function nextPreview(current, tags) {
	const base = bumpVersion(current, "patch");
	let n = 0;
	for (const tag of tags) {
		const m = /^v(\d+\.\d+\.\d+)-preview\.(\d+)$/.exec(tag);
		if (m && m[1] === base) n = Math.max(n, Number(m[2]));
	}
	return `${base}-preview.${n + 1}`;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The text of a changelog section, trimmed: "Unreleased" or a version (heading
 * `## 1.2.3 (2026-11-03)`), up to the next `## ` heading. Null when there is no such section.
 */
export function changelogSection(changelog, name) {
	const heading = new RegExp(`^## ${escapeRe(name)}(?:[ \\t].*)?$`, "m");
	const m = heading.exec(changelog);
	if (!m) return null;
	const rest = changelog.slice(m.index + m[0].length);
	return rest.split(/^## /m)[0].trim();
}

/** Renames "## Unreleased" to `## <version> (<date>)`: those notes become the version's. */
function dateChangelog(changelog, version, date) {
	return changelog.replace(/^## Unreleased[ \t]*$/m, `## ${version} (${date})`);
}

function previewNotes(unreleased, commits) {
	const parts = [];
	if (unreleased) parts.push(unreleased);
	if (commits.length)
		parts.push(`### Commits since the last release\n\n${commits.join("\n")}`);
	return parts.join("\n\n") || "No changes listed.";
}

/** The channel and version a run releases (see planRelease). */
function releaseVersion({ event, ref, channel, bump, pkgVersion, tags }) {
	if (event === "push") {
		const m = TAG.exec(ref ?? "");
		if (!m)
			throw new Error(`Not a release tag: ${ref} (vX.Y.Z or vX.Y.Z-preview.N)`);
		const version = m[1];
		const pushed =
			parseVersion(version).preview === null ? "stable" : "preview";
		if (pushed === "stable" && version !== pkgVersion)
			throw new Error(
				`Tag v${version} does not match apps/desktop/package.json (${pkgVersion}): tag with the release script, which bumps it first.`,
			);
		return { channel: pushed, version };
	}
	if (event !== "workflow_dispatch")
		throw new Error(`Not a release event: ${event}`);
	let version;
	if (channel === "stable") version = bumpVersion(pkgVersion, bump);
	else if (channel === "preview") version = nextPreview(pkgVersion, tags);
	else throw new Error(`Not a channel: ${channel} (stable or preview)`);
	if (tags.includes(`v${version}`))
		throw new Error(`Tag v${version} already exists.`);
	return { channel, version };
}

/** A stable release's notes: its changelog section (tag) or "Unreleased" (button). */
function stableNotes(changelog, event, version) {
	const notes = changelogSection(
		changelog,
		event === "push" ? version : "Unreleased",
	);
	if (notes) return notes;
	throw new Error(
		event === "push"
			? `CHANGELOG.md has no notes under "## ${version}".`
			: 'CHANGELOG.md has no notes under "## Unreleased": write what changed for users first.',
	);
}

/**
 * What to release.
 * - push: `ref` is the pushed tag. A stable tag must match package.json and have a non-empty
 *   changelog section; a preview tag must be newer than package.json.
 * - workflow_dispatch: stable bumps package.json's version and takes the "Unreleased" notes
 *   (refused when empty); preview is the next patch's next `-preview.N`.
 * Previews' notes are "Unreleased" plus the commits since the last tag.
 */
export function planRelease(input) {
	const { channel, version } = releaseVersion(input);
	const { event, pkgVersion, changelog, commits } = input;
	if (channel === "preview" && compareVersions(version, pkgVersion) <= 0)
		throw new Error(
			`${version} is not newer than ${pkgVersion}: installed apps would not update to it.`,
		);
	return {
		channel,
		version,
		tag: `v${version}`,
		prerelease: channel === "preview",
		notes:
			channel === "stable"
				? stableNotes(changelog, event, version)
				: previewNotes(changelogSection(changelog, "Unreleased"), commits),
	};
}

/** The tree with `version` stamped in: package.json, and the dated changelog (stable). */
export function applyVersion({ pkgText, changelog, version, date }) {
	const pkg = JSON.parse(pkgText);
	const nextPkg = pkgText.replace(
		`"version": "${pkg.version}"`,
		`"version": "${version}"`,
	);
	if (JSON.parse(nextPkg).version !== version)
		throw new Error('package.json has no "version" line to replace');
	const stable = parseVersion(version).preview === null;
	const dated =
		stable && changelogSection(changelog, version) === null
			? dateChangelog(changelog, version, date)
			: changelog;
	return { pkgText: nextPkg, changelog: dated };
}

// The CLI: only when run directly, not when imported (tests, the local release script).
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const root = path.resolve(import.meta.dirname, "..");
	const pkgPath = path.join(root, "apps/desktop/package.json");
	const changelogPath = path.join(root, "apps/desktop/CHANGELOG.md");
	const git = (...a) =>
		execFileSync("git", a, {
			cwd: root,
			encoding: "utf8",
			// No earlier tag is normal (the first release): git's complaint is noise.
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	const [command, ...rest] = process.argv.slice(2);
	const today = new Date().toISOString().slice(0, 10);
	try {
		if (command === "resolve") {
			const notesPath = rest[rest.indexOf("--notes") + 1];
			if (!rest.includes("--notes") || !notesPath)
				throw new Error("Usage: release-plan.mjs resolve --notes <file>");
			const pkgVersion = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
			const tags = git("tag", "--list", "v*").split("\n").filter(Boolean);
			const event = process.env.RELEASE_EVENT;
			const ref = process.env.RELEASE_REF;
			// The commits since the last tag before this release (previews' notes).
			let since = "";
			try {
				since = git(
					"describe",
					"--tags",
					"--abbrev=0",
					"--match",
					"v*",
					...(event === "push" ? ["--exclude", ref, "HEAD^"] : ["HEAD"]),
				);
			} catch {}
			const commits = git(
				"log",
				"--no-merges",
				"--max-count=100",
				"--format=- %s (%h)",
				...(since ? [`${since}..HEAD`] : ["HEAD"]),
			)
				.split("\n")
				.filter(Boolean);
			const plan = planRelease({
				event,
				ref,
				channel: process.env.RELEASE_CHANNEL,
				bump: process.env.RELEASE_BUMP,
				pkgVersion,
				tags,
				changelog: fs.readFileSync(changelogPath, "utf8"),
				commits,
			});
			fs.writeFileSync(notesPath, `${plan.notes}\n`);
			const out = [
				`channel=${plan.channel}`,
				`version=${plan.version}`,
				`tag=${plan.tag}`,
				`prerelease=${plan.prerelease}`,
			].join("\n");
			if (process.env.GITHUB_OUTPUT)
				fs.appendFileSync(process.env.GITHUB_OUTPUT, `${out}\n`);
			console.log(out);
		} else if (command === "apply") {
			const version = rest[0];
			parseVersion(version ?? "");
			const next = applyVersion({
				pkgText: fs.readFileSync(pkgPath, "utf8"),
				changelog: fs.readFileSync(changelogPath, "utf8"),
				version,
				date: today,
			});
			fs.writeFileSync(pkgPath, next.pkgText);
			fs.writeFileSync(changelogPath, next.changelog);
			console.log(`apps/desktop is now ${version}`);
		} else
			throw new Error(
				"Usage: release-plan.mjs resolve --notes <file> | apply <version>",
			);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}

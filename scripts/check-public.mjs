// Checks that nothing in the working tree names a real person's data: emails and phone numbers
// that are not fabricated, private notification topics, and the terms of a denylist kept outside
// the repository (never printed: a match is reported by its line number in the list).
//
// Usage: node scripts/check-public.mjs [--images] [--ci]
//   PUBLIC_DENYLIST: the list's path (default ~/.config/offerfinch/public-denylist.txt), one term
//   per line. In CI it comes from a secret; without it only the patterns run, with a warning.
//   --images: also reads the text in PNG, JPEG and TIFF files with macOS Vision, and in video
//   frames (one every 2 s, through ffmpeg); a file it still cannot read fails the check (slow).
//   --ci: a missing or empty denylist is a warning, not a failure (CI without the secret).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const images = process.argv.includes("--images");
const ci = process.argv.includes("--ci");
const listPath =
	process.env.PUBLIC_DENYLIST ??
	path.join(os.homedir(), ".config/offerfinch/public-denylist.txt");
const denylist = fs.existsSync(listPath)
	? fs
			.readFileSync(listPath, "utf8")
			.split("\n")
			.map((t) => t.trim())
			.filter((t) => t && !t.startsWith("#"))
	: null;

if (!ci && (!denylist || denylist.length === 0)) {
	console.error(
		`No denylist terms at ${listPath}: the check cannot say the tree is clean without them. Set PUBLIC_DENYLIST, or pass --ci to run the patterns alone.`,
	);
	process.exit(2);
}

/** Domains and numbers that are fabricated by convention (RFC 2606, the 555 range). */
const SAFE_EMAIL =
	/@(example\.(com|org|net|test)|[a-z0-9.-]+\.(test|invalid|example|localhost)|users\.noreply\.github\.com)$/i;
const PATTERNS = [
	{
		name: "email address",
		re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
		ok: (m, line, at) =>
			SAFE_EMAIL.test(m) ||
			/^git@|@\d|\.(png|svg|js|ts)$/i.test(m) ||
			// A placeholder (you@company.com) or a host under example: never a person.
			/^(?:you|user|name|someone|me|email)@/i.test(m) ||
			/@(?:[a-z0-9-]+\.)*example\./i.test(m) ||
			// URL credentials (postgres://user:pass@host), not an address.
			line[at - 1] === ":" ||
			/:\/\/[^\s@/]*$/.test(line.slice(0, at)),
	},
	{
		name: "phone number",
		re: /\+\d{1,3}[ .-]?\(?\d{2,4}\)?[ .-]?\d{3}[ .-]?\d{2,4}(?:[ .-]?\d{2,4})?/g,
		// The fabricated 555 range, with or without a country code before it.
		ok: (m) => /\b555\b|\b0100\b|^\+\d{1,3}[ .-]?555/.test(m),
	},
	{
		name: "private notification topic",
		re: /ntfy\.sh\/[A-Za-z0-9_-]+/g,
		ok: (m) => /ntfy\.sh\/(your-topic|example\w*|<topic>)/i.test(m),
	},
];
const TEXT =
	/\.(md|mdx|ts|tsx|mts|cts|js|mjs|cjs|json|jsonc|yml|yaml|toml|txt|css|html|svg|sh|swift|plist|sql|env|example|gitignore|schema)$/i;
const IMAGE = /\.(png|jpe?g|tiff?)$/i;
const VIDEO = /\.(mp4|mov|m4v|webm)$/i;
/** Icons: shapes, no text worth reading. Anything else unread is listed. */
const ICON = /\.(icns|ico|car)$/i;
/** Sounds the app synthesizes (no speech, no text): nothing to read. */
const SYNTHESIZED = new Set(["apps/desktop/build/chirp.aiff"]);

const files = execFileSync(
	"git",
	["ls-files", "--cached", "--others", "--exclude-standard"],
	{
		cwd: root,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	},
)
	.split("\n")
	.filter(Boolean)
	.filter(
		(f) => !f.startsWith("node_modules/") && fs.existsSync(path.join(root, f)),
	);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const terms = (denylist ?? []).map((t, i) => ({
	index: i + 1,
	re: new RegExp(`(?<![A-Za-z0-9])${escapeRe(t)}(?![A-Za-z0-9])`, "i"),
}));

/**
 * Generated or vendored third-party text (the lockfile's package metadata, agent skills copied
 * from vendors): only phones and topics apply.
 */
const GENERATED = /^(?:pnpm-lock\.yaml$|\.agents\/)/;
/**
 * A line saying why a listed term is not personal data there (a city in a place-name table)
 * carries this marker; its terms are not reported. Patterns still apply.
 */
const MARKER = "public-ok";

const findings = [];
/** Files of a kind this script cannot read (video, archives, documents): listed, never passed. */
const unread = [];
/**
 * Images whose OCR text may skip named patterns (scripts/public-ok-images.json), each pinned by
 * its content hash so any change to the image brings every check back. Only for screenshots of
 * fabricated test data that OCR misreads (a 555 number read as another).
 */
const OK_IMAGES = (() => {
	try {
		return JSON.parse(
			fs.readFileSync(path.join(root, "scripts/public-ok-images.json"), "utf8"),
		);
	} catch {
		return {};
	}
})();
function imageSkips(file) {
	const entry = OK_IMAGES[file];
	if (!entry || typeof entry !== "object" || !Array.isArray(entry.skip))
		return new Set();
	const hash = createHash("sha256")
		.update(fs.readFileSync(path.join(root, file)))
		.digest("hex");
	return hash === entry.sha256 ? new Set(entry.skip) : new Set();
}

function scan(file, text, skip = new Set()) {
	const lines = text.split("\n");
	const generated = GENERATED.test(file);
	lines.forEach((line, n) => {
		for (const p of PATTERNS) {
			if (generated && p.name === "email address") continue;
			if (skip.has(p.name)) continue;
			for (const m of line.matchAll(p.re))
				if (!p.ok(m[0], line, m.index ?? 0))
					findings.push(`${file}:${n + 1}: ${p.name}`);
		}
		if (generated || line.includes(MARKER)) return;
		for (const t of terms)
			if (t.re.test(line))
				findings.push(`${file}:${n + 1}: denylist term #${t.index}`);
	});
}

let ocr = null;
/** ffmpeg, for reading video frames with --images; without it a video is unread. */
let ffmpeg = null;
if (images)
	for (const candidate of [
		"ffmpeg",
		"/opt/homebrew/bin/ffmpeg",
		"/usr/local/bin/ffmpeg",
	])
		try {
			execFileSync(candidate, ["-version"], { stdio: "ignore" });
			ffmpeg = candidate;
			break;
		} catch {}
if (images) {
	ocr = path.join(os.tmpdir(), "offerfinch-ocr");
	if (!fs.existsSync(ocr))
		execFileSync("swiftc", [
			"-O",
			path.join(root, "scripts/ocr.swift"),
			"-o",
			ocr,
		]);
}
for (const file of files) {
	const full = path.join(root, file);
	if (!fs.statSync(full).isFile()) continue;
	if (TEXT.test(file) || !path.extname(file)) {
		if (fs.statSync(full).size > 5_000_000) continue;
		scan(file, fs.readFileSync(full, "utf8"));
	} else if ((IMAGE.test(file) || VIDEO.test(file)) && !ocr) {
		// Read with --images.
	} else if (VIDEO.test(file) && ffmpeg) {
		// One frame every 2 seconds, each read like an image.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-frames-"));
		try {
			execFileSync(ffmpeg, [
				"-loglevel",
				"error",
				"-i",
				full,
				"-vf",
				"fps=1/2",
				path.join(dir, "f%05d.png"),
			]);
			for (const frame of fs.readdirSync(dir).sort()) {
				const second = (Number.parseInt(frame.slice(1), 10) - 1) * 2;
				try {
					scan(
						`${file} (frame at ${second}s)`,
						execFileSync(ocr, [path.join(dir, frame)], { encoding: "utf8" }),
					);
				} catch {}
			}
		} catch {
			unread.push(file);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	} else if (!IMAGE.test(file) && !ICON.test(file) && !SYNTHESIZED.has(file)) {
		unread.push(file);
	} else if (ocr && IMAGE.test(file)) {
		try {
			scan(
				`${file} (image text)`,
				execFileSync(ocr, [full], { encoding: "utf8" }),
				imageSkips(file),
			);
		} catch {}
	}
}

if (unread.length) {
	const list = unread.map((f) => `  ${f}`).join("\n");
	if (images)
		// A full check that could not read a file has not checked the tree.
		findings.push(
			...unread.map(
				(f) => `${f}: not read${VIDEO.test(f) ? " (install ffmpeg)" : ""}`,
			),
		);
	else console.warn(`Not read without --images:\n${list}`);
}
if (!denylist)
	console.warn(
		`WARNING: no denylist at ${listPath}: only patterns were checked. Set PUBLIC_DENYLIST.`,
	);
if (findings.length) {
	console.error(findings.join("\n"));
	console.error(
		`\n${findings.length} finding(s): see docs/PLAN.md "Public-ready".`,
	);
	process.exit(1);
}
console.log(
	`No personal data found in ${files.length} files${images ? " (images read)" : ""}${denylist ? `, ${terms.length} denylist terms` : ""}.`,
);

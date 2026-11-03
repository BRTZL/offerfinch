// Pixelates, in place, every line of text in the repository's PNG and JPEG files that names a
// term of the denylist kept outside the repository (the one scripts/check-public.mjs reads).
// Only images `check-public.mjs --images` reports are touched.
//
// Usage: node scripts/redact-images.mjs [file …]   (no files: every reported image)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const list =
	process.env.PUBLIC_DENYLIST ??
	path.join(os.homedir(), ".config/offerfinch/public-denylist.txt");
if (!fs.existsSync(list)) {
	console.error(`No denylist at ${list}; set PUBLIC_DENYLIST.`);
	process.exit(2);
}

let files = process.argv.slice(2);
if (files.length === 0) {
	let report = "";
	try {
		execFileSync(
			"node",
			[path.join(root, "scripts/check-public.mjs"), "--images"],
			{
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	} catch (error) {
		report = String(error.stderr ?? "");
	}
	files = [
		...new Set(
			report
				.split("\n")
				.map((l) => l.match(/^(.+?) \(image text\):/)?.[1])
				.filter(Boolean),
		),
	];
}

const tool = path.join(os.tmpdir(), "offerfinch-redact-image");
if (!fs.existsSync(tool))
	execFileSync("swiftc", [
		"-O",
		path.join(root, "scripts/redact-image.swift"),
		"-o",
		tool,
	]);
for (const file of files) {
	const covered = execFileSync(tool, [path.join(root, file), list], {
		encoding: "utf8",
	}).trim();
	console.log(`${file}: ${covered} line(s) pixelated`);
}

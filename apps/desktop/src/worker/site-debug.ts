import fs from "node:fs";
import path from "node:path";
import { diagnosticDom, redact } from "@offerfinch/core/sites/debug";

/**
 * The page a site run stopped on for a layout change, a refusal or an unexpected page, kept in
 * the app's folder (`site-debug/`) so a breakage can be diagnosed from the page the reader saw.
 * Local only: never sent anywhere. What is kept is core's diagnostic DOM: an allowlist of the
 * page's structure and shown text, with no scripts, form values, meta tags, frames, header,
 * navigation or account menus, no attribute but the readers' hooks, links as paths only, and
 * emails and phone numbers blanked. No cookies are read. Bounded: each file at most
 * FILE_LIMIT bytes, the folder at most KEEP files and TOTAL_LIMIT bytes, newest kept.
 */
export const SITE_DEBUG_DIR = "site-debug";
export const KEEP = 5;
export const FILE_LIMIT = 512 * 1024;
export const TOTAL_LIMIT = 2 * 1024 * 1024;

/** The URL without its query or fragment (they carry tokens). */
function pathOf(url: string): string {
	try {
		const u = new URL(url);
		return redact(`${u.origin}${u.pathname}`);
	} catch {
		return "(no URL)";
	}
}

/** The page as kept: a header saying what stopped, then the diagnostic DOM, capped. */
export function debugSnapshot(
	page: { url: string; status: number | null; html: string },
	stop: { kind: string; reason: string },
	at: Date,
): string {
	const header = [
		`stopped: ${stop.kind}`,
		`reason: ${redact(stop.reason)}`,
		`url: ${pathOf(page.url)}`,
		`status: ${page.status ?? "unknown"}`,
		`at: ${at.toISOString()}`,
	]
		.map((line) => line.replace(/--/g, "- -"))
		.join("\n");
	const out = `<!--\n${header}\n-->\n${diagnosticDom(page.html)}`;
	if (Buffer.byteLength(out) <= FILE_LIMIT) return out;
	const note = "\n<!-- cut at the size limit -->\n";
	let cut = out.slice(0, FILE_LIMIT - note.length);
	while (Buffer.byteLength(cut) > FILE_LIMIT - note.length)
		cut = cut.slice(0, -1024);
	return cut + note;
}

/** Saves the page and keeps only the newest pages within the limits; returns the file written. */
export function saveDebugSnapshot(
	userData: string,
	site: string,
	page: { url: string; status: number | null; html: string },
	stop: { kind: string; reason: string },
	at = new Date(),
): string {
	const dir = path.join(userData, SITE_DEBUG_DIR);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stamp = at.toISOString().replace(/[:.]/g, "-");
	const file = path.join(
		dir,
		`${stamp}-${site.replace(/\W/g, "")}-${stop.kind.replace(/\W/g, "")}.html`,
	);
	fs.writeFileSync(file, debugSnapshot(page, stop, at), { mode: 0o600 });
	const kept = fs
		.readdirSync(dir)
		.filter((name) => name.endsWith(".html"))
		.sort()
		.reverse();
	let total = 0;
	kept.forEach((name, index) => {
		const full = path.join(dir, name);
		total += fs.statSync(full).size;
		// The newest file always stays; older ones go past the count or the total.
		if (index > 0 && (index >= KEEP || total > TOTAL_LIMIT))
			fs.rmSync(full, { force: true });
	});
	return file;
}

// Node-only loader. The desktop worker reads the profile snapshot from SQLite instead.
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { normalizeLineEndings } from "../domain/line-endings";

import type { ProfileSnapshot } from "./types";

/**
 * Reads every markdown file under the profile directory (read-only), except `sources/`: that is
 * an outdated raw export and must never be used as evidence.
 */
export async function loadProfileFromDir(
	dir: string,
): Promise<ProfileSnapshot> {
	const entries = await readdir(dir, { recursive: true, withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const absolute = join(entry.parentPath, entry.name);
		if (
			/^sources(?:\/|$)/.test(
				relative(dir, entry.parentPath).split(sep).join("/"),
			)
		)
			continue;
		files.push({
			path: relative(dir, absolute).split(sep).join("/"),
			content: normalizeLineEndings(await readFile(absolute, "utf8")),
		});
	}
	files.sort((a, b) => a.path.localeCompare(b.path));
	return { files };
}

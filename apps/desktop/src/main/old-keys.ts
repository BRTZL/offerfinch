import fs from "node:fs";
import path from "node:path";

/** Where earlier versions kept their API keys, encrypted with safeStorage. */
export const OLD_KEYS_FILE = "secrets.json";

/**
 * Deletes the API keys earlier versions stored. Models run on the user's own sign-ins now, and
 * nothing reads the keys any more: the file goes without being decrypted, so the Keychain is not
 * touched. True when a file was there.
 */
export function forgetOldKeys(userData: string): boolean {
	const file = path.join(userData, OLD_KEYS_FILE);
	let removed = false;
	for (const stale of [file, `${file}.tmp`]) {
		try {
			fs.rmSync(stale);
			if (stale === file) removed = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return removed;
}

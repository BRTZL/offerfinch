import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
// A large backup's entry list can exceed execFile's 1 MB default.
const run = (file: string, args: string[]) =>
	exec(file, args, { maxBuffer: 64 * 1024 * 1024 });

/** Never use PATH: Git for Windows' GNU tar cannot write zip files. */
export function windowsTarPath(env: NodeJS.ProcessEnv = process.env): string {
	return path.win32.join(
		env.SystemRoot || env.WINDIR || "C:\\Windows",
		"System32",
		"tar.exe",
	);
}

/** Reject both platforms' absolute paths, drive-relative paths and traversal everywhere. */
export function isSafeZipEntry(name: string): boolean {
	return (
		!path.posix.isAbsolute(name) &&
		!path.win32.isAbsolute(name) &&
		!/^[a-z]:/i.test(name) &&
		!name.split(/[\\/]/).some((part) => /^\.\.[ .]*$/.test(part))
	);
}

/** The tar binary is injectable so macOS's bsdtar can exercise the Windows operations. */
export function createZipTools(
	options: { platform?: NodeJS.Platform; tar?: string } = {},
) {
	const useTar = (options.platform ?? process.platform) === "win32";
	const tar = options.tar ?? windowsTarPath();
	return {
		async create(
			source: string,
			target: string,
			keepParent = false,
		): Promise<void> {
			const dir = path.resolve(source);
			const zip = path.resolve(target);
			if (useTar) {
				// .partial is not a zip suffix: format must be explicit, never inferred with -a.
				await run(tar, [
					"--format",
					"zip",
					"--options",
					"zip:hdrcharset=UTF-8",
					"-c",
					"-f",
					zip,
					"-C",
					keepParent ? path.dirname(dir) : dir,
					"--",
					keepParent ? path.basename(dir) : ".",
				]);
			} else {
				await run("/usr/bin/ditto", [
					"-c",
					"-k",
					"--norsrc",
					...(keepParent ? ["--keepParent"] : []),
					dir,
					zip,
				]);
			}
		},
		async list(source: string): Promise<string[]> {
			const zip = path.resolve(source);
			const { stdout } = await (useTar
				? run(tar, ["-t", "-f", zip])
				: run("/usr/bin/zipinfo", ["-1", zip]));
			return stdout.split(/\r?\n/).filter(Boolean);
		},
		async extract(source: string, target: string): Promise<void> {
			// Validate the entire list before the extractor writes anything.
			for (const name of await this.list(source))
				if (!isSafeZipEntry(name)) throw new Error("Unsafe path in zip");
			const zip = path.resolve(source);
			const dir = path.resolve(target);
			if (useTar) await run(tar, ["-x", "-f", zip, "-C", dir]);
			else await run("/usr/bin/ditto", ["-x", "-k", zip, dir]);
		},
	};
}

export const zipTools = createZipTools();

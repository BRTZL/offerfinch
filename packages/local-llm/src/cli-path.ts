import fs from "node:fs";
import path from "node:path";

/** Resolve Windows launchers without ever invoking a command shell. */
export function findCliOnPath(
	name: string,
	pathEnv: string,
	platform: NodeJS.Platform = process.platform,
	pathExt = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
	checks: {
		isFile?: (file: string) => boolean;
		resolve?: (file: string) => string;
	} = {},
): string | null {
	const isFile =
		checks.isFile ?? ((file: string) => isExecutableFile(file, platform));
	const resolve = checks.resolve ?? fs.realpathSync;
	const paths = platform === "win32" ? path.win32 : path;
	const extensions = cliExtensions(platform, pathExt);
	for (const dir of pathEnv.split(paths.delimiter).filter(Boolean)) {
		for (const ext of extensions) {
			const candidate = paths.join(dir, `${name}${ext}`);
			if (!isFile(candidate)) continue;
			if (
				platform === "win32" &&
				name === "claude" &&
				[".cmd", ".bat", ".ps1"].includes(ext)
			) {
				const executable = paths.join(
					dir,
					"node_modules",
					"@anthropic-ai",
					"claude-code",
					"bin",
					"claude.exe",
				);
				try {
					if (isFile(executable)) return resolve(executable);
				} catch {}
				continue;
			}
			try {
				return resolve(candidate);
			} catch {}
		}
	}
	return null;
}

function isExecutableFile(file: string, platform: NodeJS.Platform): boolean {
	try {
		fs.accessSync(
			file,
			platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK,
		);
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

function cliExtensions(platform: NodeJS.Platform, pathExt: string): string[] {
	return platform === "win32"
		? [
				...new Set([
					".exe",
					...pathExt
						.split(";")
						.map((ext) => {
							const value = ext.trim().toLowerCase();
							return value.startsWith(".") ? value : `.${value}`;
						})
						.filter((ext) => ext !== "."),
				]),
			]
		: [""];
}

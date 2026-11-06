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
		readFile?: (file: string) => string;
		resolve?: (file: string) => string;
	} = {},
): string | null {
	const isFile = checks.isFile ?? executableCheck(platform);
	const resolve = checks.resolve ?? fs.realpathSync;
	const paths = platform === "win32" ? path.win32 : path;
	const extensions = cliExtensions(platform, pathExt, name);
	for (const dir of pathEnv.split(paths.delimiter).filter(Boolean)) {
		for (const ext of extensions) {
			const candidate = paths.join(dir, `${name}${ext}`);
			if (!isFile(candidate)) continue;
			if (isClaudeShim(platform, name, ext)) {
				try {
					const executable = shimExecutable(
						candidate,
						checks.readFile ?? ((file) => fs.readFileSync(file, "utf8")),
						isFile,
					);
					if (executable) return resolve(executable);
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

function cliExtensions(
	platform: NodeJS.Platform,
	pathExt: string,
	name: string,
): string[] {
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
						.filter(
							(ext) => ext === ".exe" || isClaudeShim(platform, name, ext),
						),
				]),
			]
		: [""];
}

/** Read npm/pnpm launch targets, never execute batch code or select its Node runtime. */
function shimExecutable(
	shim: string,
	readFile: (file: string) => string,
	isFile: (file: string) => boolean,
): string | null {
	for (const match of readFile(shim).matchAll(
		/"(?:%dp0%|%~dp0)[\\/]?([^"\r\n]+\.(?:exe|js))"/gi,
	)) {
		const target = match[1];
		if (!target || /%/.test(target)) continue;
		const native = nativeTarget(target);
		if (!native || path.win32.basename(native).toLowerCase() !== "claude.exe")
			continue;
		const directory = path.win32.dirname(shim);
		const executable = path.win32.resolve(directory, native);
		const relative = path.win32.relative(directory, executable);
		if (relative.startsWith("..") || path.win32.isAbsolute(relative)) continue;
		if (isFile(executable)) return executable;
	}
	return null;
}

function nativeTarget(target: string): string | null {
	if (/\.exe$/i.test(target)) return target;
	if (/(?:^|[\\/])claude-code[\\/]cli\.js$/i.test(target))
		return target.replace(/cli\.js$/i, "bin\\claude.exe");
	if (/(?:^|[\\/])claude-code[\\/]bin[\\/]cli\.js$/i.test(target))
		return target.replace(/cli\.js$/i, "claude.exe");
	return null;
}

function executableCheck(platform: NodeJS.Platform): (file: string) => boolean {
	return (file) => isExecutableFile(file, platform);
}

function isClaudeShim(
	platform: NodeJS.Platform,
	name: string,
	ext: string,
): boolean {
	return (
		platform === "win32" &&
		name === "claude" &&
		[".cmd", ".bat", ".ps1"].includes(ext)
	);
}

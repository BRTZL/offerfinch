import { afterEach, describe, expect, it, vi } from "vitest";
import { findCliOnPath } from "../src/cli-path";
import { CODEX_MACOS_ONLY, runCodexTurn } from "../src/codex";
import { subscriptionEnv } from "../src/env";
import {
	codexPlanUsage,
	codexSubscriptionLogin,
	loginShellPath,
} from "../src/status";

vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	execFile: vi.fn(),
}));

import { execFile } from "node:child_process";

afterEach(() => vi.restoreAllMocks());

describe("Windows subscriptions", () => {
	it.each([
		String.raw`"%dp0%\..\..\Windows\System32\cmd.exe"`,
		String.raw`"%dp0%\C:\Windows\System32\powershell.exe"`,
		String.raw`"%~dp0\..\evil\claude-code\cli.js"`,
		String.raw`"%dp0%\C:\elsewhere\claude.exe"`,
		String.raw`"%dp0%\powershell.exe"`,
	])("rejects unsafe shim target %s even when it exists", (contents) => {
		expect(
			findCliOnPath("claude", String.raw`C:\npm`, "win32", ".CMD", {
				isFile: (file) =>
					!file.toLowerCase().endsWith(String.raw`\npm\claude.exe`),
				readFile: () => contents,
				resolve: (file) => file,
			}),
		).toBeNull();
	});
	it("rejects scripts from PATHEXT outside the shim branch", () => {
		expect(
			findCliOnPath("claude", String.raw`C:\npm`, "win32", ".JS;.EXE", {
				isFile: (file) => file.endsWith(".js"),
				resolve: (file) => file,
			}),
		).toBeNull();
	});
	it.each(["darwin", "linux"] as const)(
		"omits Windows-only variables on %s",
		(platform) => {
			const parent = Object.fromEntries(
				"USERPROFILE APPDATA LOCALAPPDATA SystemRoot SystemDrive WINDIR ComSpec PATHEXT TEMP TMP USERNAME HOMEDRIVE HOMEPATH ProgramData ProgramFiles ProgramFiles(x86) CLAUDE_CODE_GIT_BASH_PATH"
					.split(" ")
					.map((key) => [key, "synthetic"]),
			);
			expect(subscriptionEnv(parent, {}, platform).env).toEqual({});
		},
	);
	it.each([
		[
			'@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*',
			String.raw`node_modules\@anthropic-ai\claude-code\bin\claude.exe`,
		],
		[
			'@ECHO off\r\n"%~dp0\\node_modules\\.pnpm\\@anthropic-ai+claude-code@1.0.0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
			String.raw`node_modules\.pnpm\@anthropic-ai+claude-code@1.0.0\node_modules\@anthropic-ai\claude-code\bin\claude.exe`,
		],
		[
			String.raw`"%~dp0\global\5\node_modules\@anthropic-ai\claude-code\bin\CLAUDE.EXE" %*`,
			String.raw`global\5\node_modules\@anthropic-ai\claude-code\bin\CLAUDE.EXE`,
		],
	])("resolves a quoted npm or pnpm target: %s", (shim, target) => {
		const exe = `C:\\global\\${target}`;
		const checks = {
			readFile: () => `IF EXIST "%dp0%\\node.exe" (\r\n${shim}`,
			resolve: (file: string) => file,
			isFile: (file: string) =>
				file === exe ||
				file === "C:\\global\\claude.cmd" ||
				file === "C:\\global\\node.exe",
		};
		expect(findCliOnPath("claude", "C:\\global", "win32", ".CMD", checks)).toBe(
			exe,
		);
		expect(
			findCliOnPath("claude", "C:\\global", "win32", ".CMD", {
				...checks,
				isFile: (file) => file.endsWith(".cmd"),
			}),
		).toBeNull();
	});
	it("keeps mixed-case allowlisted keys and one PATH, without credentials", () => {
		const names =
			"USERPROFILE APPDATA LOCALAPPDATA SystemRoot SystemDrive WINDIR ComSpec PATHEXT TEMP TMP USERNAME HOMEDRIVE HOMEPATH ProgramData ProgramFiles ProgramFiles(x86) CLAUDE_CODE_GIT_BASH_PATH".split(
				" ",
			);
		const parent = Object.fromEntries(
			names.map((name) => [name.toLowerCase(), `value-${name}`]),
		);
		const { env, removed } = subscriptionEnv(
			{
				...parent,
				Path: "old",
				PATH: "current",
				openai_api_key: "synthetic-secret",
			},
			{ Path: "new" },
			"win32",
		);
		for (const name of names) expect(env[name]).toBe(`value-${name}`);
		expect(
			Object.keys(env).filter((key) => key.toLowerCase() === "path"),
		).toEqual(["PATH"]);
		expect(env.PATH).toBe("new");
		expect(removed).toEqual(["openai_api_key"]);
		expect(JSON.stringify(env)).not.toContain("secret");
	});
	it("redirects TEMP and TMP with a private TMPDIR through the host allowlist", () => {
		const { env } = subscriptionEnv(
			{ TEMP: "real", TMP: "real" },
			{ TMPDIR: "C:\\private\\tmp" },
			"win32",
		);
		expect(env).toEqual({
			TMPDIR: "C:\\private\\tmp",
			TEMP: "C:\\private\\tmp",
			TMP: "C:\\private\\tmp",
		});
		expect(subscriptionEnv(env, {}, "win32").env).toEqual(env);
	});
	it("prefers exe to PATHEXT shims and resolves only the native Claude package entry", () => {
		const root = "C:\\npm";
		const shim = `${root}\\claude.cmd`;
		const exe = `${root}\\claude.exe`;
		const packageExe = `${root}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
		const find = (files: string[]) =>
			findCliOnPath("claude", root, "win32", ".CMD;.EXE", {
				isFile: (file) => files.includes(file),
				readFile: () =>
					'"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
				resolve: (file) => file,
			});
		expect(find([shim, exe, packageExe])).toBe(exe);
		expect(find([shim, packageExe])).toBe(packageExe);
		expect(find([shim])).toBeNull();
		expect(
			findCliOnPath("codex", root, "win32", ".BAT;.CMD", {
				isFile: (file) => file === `${root}\\codex.cmd`,
				resolve: (file) => file,
			}),
		).toBeNull();
	});
	it("reads registry PATH with absolute PowerShell, never a login shell", async () => {
		vi.stubEnv("SystemRoot", "C:\\Windows");
		vi.stubEnv("PATH", "C:\\process");
		vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
			const callback = args[3] as (error: Error | null, stdout: string) => void;
			callback(null, "C:\\user;C:\\PROCESS\r\nC:\\machine\r\n");
			return {} as ReturnType<typeof execFile>;
		});
		expect(await loginShellPath("/bin/zsh", 123, "win32")).toBe(
			"C:\\PROCESS;C:\\user;C:\\machine",
		);
		expect(vi.mocked(execFile).mock.calls[0]?.[0]).toBe(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		);
		vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
			(args[3] as (error: Error, stdout: string) => void)(
				new Error("timeout"),
				"",
			);
			return {} as ReturnType<typeof execFile>;
		});
		expect(await loginShellPath("/bin/zsh", 123, "win32")).toBeNull();
		vi.unstubAllEnvs();
	});
	it("fails closed before Codex auth, disk access, or spawning on Windows", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		const result = await runCodexTurn({} as Parameters<typeof runCodexTurn>[0]);
		expect(result.boundary).toBe(CODEX_MACOS_ONLY);
		expect((await codexSubscriptionLogin({})).detail).toBe(CODEX_MACOS_ONLY);
		expect((await codexPlanUsage({ binary: "codex.cmd" })).error).toBe(
			CODEX_MACOS_ONLY,
		);
	});
});

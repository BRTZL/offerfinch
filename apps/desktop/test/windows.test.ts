import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isMacPlatform, primaryModifier } from "../src/shared/platform";
import { comboLabel, matches } from "../src/shared/shortcuts";
import { findChrome } from "../src/worker/browser";

describe("Windows browser lookup", () => {
	const env = {
		ProgramFiles: "C:\\Program Files",
		"ProgramFiles(x86)": "C:\\Program Files (x86)",
		LOCALAPPDATA: "C:\\Users\\Example\\AppData\\Local",
	};
	const browsers = [
		["Google Chrome", "Google/Chrome/Application/chrome.exe"],
		["Chromium", "Chromium/Application/chrome.exe"],
		["Microsoft Edge", "Microsoft/Edge/Application/msedge.exe"],
		["Brave Browser", "BraveSoftware/Brave-Browser/Application/brave.exe"],
	] as const;
	for (const [name, suffix] of browsers) {
		for (const root of Object.values(env)) {
			it(`finds ${name} under ${root} with Windows separators on macOS`, () => {
				const executable = path.win32.join(root, suffix);
				expect(
					findChrome(undefined, "win32", env, (file) => file === executable),
				).toEqual({ name, executable });
			});
		}
	}
	it("prefers Chrome in a user install over Edge in Program Files", () => {
		const chrome = path.win32.join(env.LOCALAPPDATA, browsers[0][1]);
		const edge = path.win32.join(env.ProgramFiles, browsers[2][1]);
		expect(
			findChrome(undefined, "win32", env, (file) =>
				[chrome, edge].includes(file),
			)?.executable,
		).toBe(chrome);
	});
	it("supports injected roots, missing env, overrides and explicit absence", () => {
		const exists = vi.fn(() => true);
		expect(findChrome(undefined, "win32", {}, exists)).toBeNull();
		expect(exists).not.toHaveBeenCalled();
		expect(findChrome(["D:\\Apps"], "win32", {}, exists)?.executable).toBe(
			"D:\\Apps\\Google\\Chrome\\Application\\chrome.exe",
		);
		expect(
			findChrome([], "win32", { OFFERFINCH_CHROME: "D:\\custom.exe" }, exists)
				?.name,
		).toBe("Custom browser");
		expect(
			findChrome([], "win32", { OFFERFINCH_CHROME: "none" }, exists),
		).toBeNull();
	});
});

describe("platform shortcuts", () => {
	it("detects macOS and Windows", () => {
		expect(isMacPlatform("MacIntel")).toBe(true);
		expect(isMacPlatform("darwin")).toBe(true);
		expect(isMacPlatform("Win32")).toBe(false);
	});
	it("uses Control on Windows and Command on Mac, rejecting the other modifier", () => {
		const control = {
			key: "k",
			ctrlKey: true,
			metaKey: false,
			shiftKey: false,
			altKey: false,
		};
		const command = { ...control, ctrlKey: false, metaKey: true };
		expect(matches(control, "command-menu", false)).toBe(true);
		expect(matches(command, "command-menu", false)).toBe(false);
		expect(matches(command, "command-menu", true)).toBe(true);
		expect(matches(control, "command-menu", true)).toBe(false);
		expect(matches({ ...control, metaKey: true }, "command-menu", false)).toBe(
			false,
		);
		expect(primaryModifier(control, false)).toBe(true);
		expect(comboLabel({ key: "k", cmd: true }, false)).toBe("Ctrl+K");
		expect(comboLabel({ key: "k", cmd: true }, true)).toBe("⌘K");
	});
});

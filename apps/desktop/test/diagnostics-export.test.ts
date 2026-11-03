import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The test-only stand-ins (OFFERFINCH_TEST_SAVE_TO, _CHANGELOG, _VERSION) work only in an
 * unpackaged build: a packaged app started with OFFERFINCH_TEST=1 (measure.mjs, the screenshot
 * scripts) must never read a file it was pointed at into the window, or overwrite a path
 * without the save panel.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "of-diag-export-"));
const electron = vi.hoisted(() => ({
	isPackaged: true,
	showSaveDialog: vi.fn(async () => ({
		canceled: true,
		filePath: undefined as string | undefined,
	})),
}));

vi.mock("electron", () => ({
	app: {
		get isPackaged() {
			return electron.isPackaged;
		},
		getPath: (name: string) => path.join(root, name),
		getVersion: () => "1.2.3",
		getLocale: () => "en",
		getAppPath: () => path.join(root, "app"),
	},
	dialog: { showSaveDialog: electron.showSaveDialog },
}));
vi.mock("../src/main/state", () => ({
	TEST_MODE: true,
	log: () => {},
	mainState: {
		startedAt: Date.now(),
		worker: { request: () => Promise.reject(new Error("no worker here")) },
	},
}));

const { prepareDiagnostics, releaseNotes, saveDiagnostics, testOverride } =
	await import("../src/main/diagnostics-export");

const fabricated = path.join(root, "planted-changelog.md");
const saveTo = path.join(root, "planted-target.zip");

beforeEach(() => {
	for (const dir of ["logs", "userData", "downloads", "app"])
		fs.mkdirSync(path.join(root, dir), { recursive: true });
	fs.writeFileSync(fabricated, "## 9.9.9\n\n- PLANTED NOTES\n");
	fs.writeFileSync(saveTo, "KEEP ME");
	vi.stubEnv("OFFERFINCH_TEST_CHANGELOG", fabricated);
	vi.stubEnv("OFFERFINCH_TEST_VERSION", "9.9.9");
	vi.stubEnv("OFFERFINCH_TEST_SAVE_TO", saveTo);
	(process as unknown as { getSystemVersion: () => string }).getSystemVersion =
		() => "26.0";
	(process as unknown as { resourcesPath: string }).resourcesPath = path.join(
		root,
		"Resources",
	);
	electron.showSaveDialog.mockClear();
});
afterEach(() => {
	vi.unstubAllEnvs();
});

describe("a packaged build", () => {
	beforeEach(() => {
		electron.isPackaged = true;
	});

	it("ignores every test override", () => {
		expect(testOverride("OFFERFINCH_TEST_SAVE_TO")).toBeUndefined();
		expect(testOverride("OFFERFINCH_TEST_CHANGELOG")).toBeUndefined();
		expect(testOverride("OFFERFINCH_TEST_VERSION")).toBeUndefined();
	});

	it("reads its own changelog and version, not the planted ones", () => {
		const notes = releaseNotes();
		expect(notes.version).toBe("1.2.3");
		expect(notes.changelog).not.toContain("PLANTED");
	});

	it("asks with the save panel and leaves the planted path alone", async () => {
		const bundle = await prepareDiagnostics();
		expect(await saveDiagnostics(bundle.id)).toBe(false);
		expect(electron.showSaveDialog).toHaveBeenCalledOnce();
		expect(fs.readFileSync(saveTo, "utf8")).toBe("KEEP ME");
	});
});

describe("an unpackaged test run", () => {
	beforeEach(() => {
		electron.isPackaged = false;
	});

	it("uses the overrides, so the e2e can drive the sheet", async () => {
		expect(releaseNotes()).toEqual({
			version: "9.9.9",
			changelog: "## 9.9.9\n\n- PLANTED NOTES\n",
		});
		const bundle = await prepareDiagnostics();
		expect(await saveDiagnostics(bundle.id)).toBe(true);
		expect(electron.showSaveDialog).not.toHaveBeenCalled();
		expect(fs.readFileSync(saveTo).subarray(0, 2).toString()).toBe("PK");
	});
});

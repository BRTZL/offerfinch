import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	packaged: true,
	test: false,
	release: true,
	updater: { on: vi.fn(), autoDownload: false, autoInstallOnAppQuit: false },
}));
vi.mock("node:fs", () => ({
	default: {
		readFileSync: () => JSON.stringify({ offerfinchRelease: mocks.release }),
	},
}));
vi.mock("electron", () => ({
	app: {
		get isPackaged() {
			return mocks.packaged;
		},
		getAppPath: () => "/app",
		getVersion: () => "1.0.0",
	},
	BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("electron-updater", () => ({ autoUpdater: mocks.updater }));
vi.mock("../src/main/state", () => ({
	get TEST_MODE() {
		return mocks.test;
	},
	log: vi.fn(),
	mainState: {},
}));
vi.mock("../src/main/menu", () => ({ buildMenu: vi.fn() }));
vi.mock("../src/main/tray", () => ({ updateTray: vi.fn() }));

import { createUpdates } from "../src/main/app-updates";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	mocks.packaged = true;
	mocks.test = false;
	mocks.release = true;
	mocks.updater.on.mockClear();
});

describe("release updater gating", () => {
	it.each(["win32", "darwin"])(
		"enables the updater for a %s release",
		async (platform) => {
			vi.stubGlobal("process", { ...process, platform });
			const updates = await createUpdates();
			expect(updates.get().status).toBe("idle");
			expect(mocks.updater.on).toHaveBeenCalled();
			expect(mocks.updater.autoDownload).toBe(true);
			expect(mocks.updater.autoInstallOnAppQuit).toBe(true);
		},
	);
	it.each(["test", "development", "local"])(
		"disables updates for Windows %s builds",
		async (kind) => {
			vi.stubGlobal("process", { ...process, platform: "win32" });
			vi.stubEnv("OFFERFINCH_FAKE_UPDATE", "");
			mocks.test = kind === "test";
			mocks.packaged = kind !== "development";
			mocks.release = kind !== "local";
			const updates = await createUpdates();
			expect(updates.get().status).toBe("disabled");
			expect(mocks.updater.on).not.toHaveBeenCalled();
		},
	);
});

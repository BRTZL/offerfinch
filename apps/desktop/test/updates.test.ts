import { describe, expect, it, vi } from "vitest";
import {
	releaseNoteLines,
	shortError,
	type Updater,
	Updates,
} from "../src/main/updates";
import type { UpdateState } from "../src/shared/bridge";

class StubUpdater implements Updater {
	autoDownload = false;
	autoInstallOnAppQuit = false;
	installs = 0;
	check = vi.fn(async () => null);
	handlers = new Map<string, (arg: never) => void>();
	on(event: string, fn: (arg: never) => void) {
		this.handlers.set(event, fn);
		return this;
	}
	emit(event: string, arg?: unknown) {
		this.handlers.get(event)?.(arg as never);
	}
	checkForUpdates() {
		return this.check();
	}
	quitAndInstall() {
		this.installs++;
	}
}

const make = (
	disabledReason: string | null = null,
	clock = { now: new Date("2026-11-02T12:00:00Z") },
) => {
	const updater = new StubUpdater();
	const states: UpdateState[] = [];
	const ready: string[] = [];
	const updates = new Updates(updater, {
		currentVersion: "0.1.0",
		disabledReason,
		onChange: (s) => states.push(s),
		onReady: (v) => ready.push(v),
		log: () => {},
		now: () => clock.now,
	});
	return { updater, updates, states, ready };
};

describe("Updates", () => {
	it("downloads in the background and installs only once ready", async () => {
		const { updater, updates, ready } = make();
		expect(updater.autoDownload).toBe(true);
		expect(updater.autoInstallOnAppQuit).toBe(true);
		expect(updates.install()).toBe(false);
		updater.emit("checking-for-update");
		expect(updates.get().status).toBe("checking");
		updater.emit("update-available", { version: "0.2.0" });
		updater.emit("download-progress", { percent: 41.6 });
		expect(updates.get()).toEqual({
			status: "downloading",
			currentVersion: "0.1.0",
			version: "0.2.0",
			percent: 42,
			notes: [],
		});
		updater.emit("update-downloaded", { version: "0.2.0" });
		updater.emit("update-downloaded", { version: "0.2.0" });
		expect(updates.get().status).toBe("ready");
		expect(ready).toEqual(["0.2.0"]);
		// No second check while one is ready to install.
		await updates.check();
		expect(updater.check).not.toHaveBeenCalled();
		expect(updates.install()).toBe(true);
		expect(updater.installs).toBe(1);
	});

	it("turns a failed install into an error that can be checked again", async () => {
		const { updater, updates } = make();
		updater.emit("update-downloaded", { version: "0.2.0" });
		updater.emit(
			"error",
			new Error("Code signature at URL did not pass validation"),
		);
		expect(updates.get().status).toBe("error");
		expect(updates.install()).toBe(false);
		await updates.check();
		expect(updater.check).toHaveBeenCalledTimes(1);
	});

	it("reports errors in one short line", async () => {
		const { updater, updates } = make();
		updater.check.mockRejectedValueOnce(
			new Error("net::ERR_INTERNET_DISCONNECTED\n at stack"),
		);
		await updates.check();
		expect(updates.get()).toEqual({
			status: "error",
			currentVersion: "0.1.0",
			error: "No connection to GitHub",
			checkedAt: "2026-11-02T12:00:00.000Z",
		});
		// An error does not block the next check.
		await updates.check();
		expect(updater.check).toHaveBeenCalledTimes(2);
	});

	it("does nothing in a build that does not update", async () => {
		const { updater, updates } = make(
			"Development builds don't update themselves.",
		);
		expect(updates.get().status).toBe("disabled");
		updates.start();
		await updates.check();
		expect(updater.check).not.toHaveBeenCalled();
		expect(updates.install()).toBe(false);
	});

	it("carries the release notes from finding the update to ready", () => {
		const { updater, updates } = make();
		updater.emit("update-available", {
			version: "0.2.0",
			releaseNotes: "<ul><li>One</li><li>Two</li></ul>",
		});
		expect(updates.get()).toMatchObject({ notes: ["One", "Two"] });
		// The downloaded event may come without notes: keep the ones already read.
		updater.emit("update-downloaded", { version: "0.2.0" });
		expect(updates.get()).toMatchObject({
			status: "ready",
			notes: ["One", "Two"],
		});
	});

	it("checks again on wake or focus only once the last check is 10 minutes old", async () => {
		const clock = { now: new Date("2026-11-02T12:00:00Z") };
		const { updater, updates } = make(null, clock);
		updates.checkIfStale();
		await Promise.resolve();
		expect(updater.check).toHaveBeenCalledTimes(1);
		updater.emit("update-not-available", { version: "0.1.0" });
		clock.now = new Date("2026-11-02T12:09:00Z");
		updates.checkIfStale();
		expect(updater.check).toHaveBeenCalledTimes(1);
		clock.now = new Date("2026-11-02T12:10:00Z");
		updates.checkIfStale();
		await Promise.resolve();
		expect(updater.check).toHaveBeenCalledTimes(2);
	});

	it("names the usual failures plainly", () => {
		expect(shortError(new Error("HttpError: 404 Not Found\nbody"))).toBe(
			"No release published yet",
		);
		expect(
			shortError(new Error("Code signature at URL did not pass validation")),
		).toMatch(/Developer ID/);
	});
});

describe("releaseNoteLines", () => {
	it("reads GitHub's release HTML as plain lines", () => {
		// The 0.1.5 release as GitHub's feed gave it (two of its seven bullets).
		const html = `<ul>
<li>The job filter now keeps or rejects, nothing in between, and what it rejects is hidden<br>
everywhere. A remote job that names no place (&quot;Remote&quot;) is kept and ranked lower.</li>
<li>Settings ›<br>
Models greys out a choice that would break this and says why. Plan&#39;s usage &amp; more.</li>
</ul>`;
		expect(releaseNoteLines(html)).toEqual([
			'The job filter now keeps or rejects, nothing in between, and what it rejects is hidden everywhere. A remote job that names no place ("Remote") is kept and ranked lower.',
			"Settings › Models greys out a choice that would break this and says why. Plan's usage & more.",
		]);
	});

	it("never lets markup through", () => {
		expect(
			releaseNoteLines(
				'<ul><li><a href="x">Link</a> <img src=x onerror=1>text &lt;b&gt;</li></ul>',
			),
		).toEqual(["Link text <b>"]);
	});

	it("reads Markdown bullets, the array form and empty notes", () => {
		expect(
			releaseNoteLines("- First line\n  continues here\n- Second"),
		).toEqual(["First line continues here", "Second"]);
		expect(
			releaseNoteLines([
				{ version: "0.2.0", note: "<ul><li>New</li></ul>" },
				{ version: "0.1.9", note: "<ul><li>Old</li></ul>" },
			]),
		).toEqual(["New"]);
		expect(releaseNoteLines("<p>One paragraph.</p>")).toEqual([
			"One paragraph.",
		]);
		expect(releaseNoteLines("No content.")).toEqual([]);
		expect(releaseNoteLines(null)).toEqual([]);
		expect(releaseNoteLines(undefined)).toEqual([]);
	});
});

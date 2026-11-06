import { describe, expect, it, vi } from "vitest";
import {
	releaseNoteLines,
	shortError,
	UPDATE_STILL_RUNNING,
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
	quitAndInstall = vi.fn(() => {
		this.installs++;
	});
}

const make = (
	disabledReason: string | null = null,
	clock = { now: new Date("2026-11-02T12:00:00Z") },
	beforeWindowsInstall = async () => {},
) => {
	const updater = new StubUpdater();
	const states: UpdateState[] = [];
	const ready: string[] = [];
	const updates = new Updates(updater, {
		currentVersion: "0.1.0",
		beforeWindowsInstall,
		disabledReason,
		onChange: (s) => states.push(s),
		onReady: (v) => ready.push(v),
		log: () => {},
		now: () => clock.now,
	});
	return { updater, updates, states, ready };
};

describe("Updates", () => {
	it("silently installs and restarts on Windows", async () => {
		vi.stubGlobal("process", { ...process, platform: "win32" });
		try {
			const { updater, updates } = make();
			updater.emit("update-downloaded", { version: "0.2.0" });
			expect(updates.install()).toBe(true);
			await vi.waitFor(() =>
				expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true),
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("waits for Windows shutdown and refuses a second restart press", async () => {
		vi.stubGlobal("process", { ...process, platform: "win32" });
		try {
			let finish = () => {};
			const shutdown = vi.fn(
				() =>
					new Promise<void>((resolve) => {
						finish = resolve;
					}),
			);
			const { updater, updates } = make(null, undefined, shutdown);
			updater.emit("update-downloaded", { version: "0.2.0" });
			expect(updates.install()).toBe(true);
			expect(updates.install()).toBe(false);
			expect(shutdown).toHaveBeenCalledTimes(1);
			expect(updater.quitAndInstall).not.toHaveBeenCalled();
			finish();
			await vi.waitFor(() =>
				expect(updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(
					true,
					true,
				),
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("does not launch NSIS when Windows shutdown fails", async () => {
		vi.stubGlobal("process", { ...process, platform: "win32" });
		try {
			const { updater, updates } = make(null, undefined, async () => {
				throw new Error("still running");
			});
			updater.emit("update-downloaded", { version: "0.2.0" });
			updates.install();
			await vi.waitFor(() => expect(updates.get().status).toBe("error"));
			expect(updater.quitAndInstall).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("keeps macOS restart immediate without Windows shutdown", () => {
		vi.stubGlobal("process", { ...process, platform: "darwin" });
		try {
			const shutdown = vi.fn(async () => {});
			const { updater, updates } = make(null, undefined, shutdown);
			updater.emit("update-downloaded", { version: "0.2.0" });
			expect(updates.install()).toBe(true);
			expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
			expect(shutdown).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("checks at launch and every 30 minutes", async () => {
		vi.useFakeTimers();
		const { updater, updates } = make();
		try {
			updates.start();
			await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 1);
			expect(updater.check).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(updater.check).toHaveBeenCalledTimes(2);
		} finally {
			updates.stop();
			vi.useRealTimers();
		}
	});

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

describe("Updates while try-it mode runs", () => {
	it("refuses every check while suspended, and checks again on resume", async () => {
		const { updater, updates } = make();
		await updates.suspend();
		// Settings, the app menu and the timer all go through check() or start().
		await updates.check();
		updates.start();
		expect(updater.check).not.toHaveBeenCalled();
		updates.resume();
		expect(updater.check).toHaveBeenCalledTimes(1);
		updates.stop();
	});

	it("waits for a running check and cancels the download it started", async () => {
		const { updater, updates, ready } = make();
		let cancelled = false;
		let endDownload = () => {};
		let answer = (_: unknown) => {};
		updater.check.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}) as never,
		);
		void updates.check();
		updater.emit("checking-for-update");
		let suspended = false;
		const suspending = updates.suspend().then(() => {
			suspended = true;
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(suspended).toBe(false);
		// The check finds an update; its download starts and is cancelled at once.
		updater.emit("update-available", { version: "0.2.0" });
		answer({
			cancellationToken: {
				cancel: () => {
					cancelled = true;
					endDownload();
				},
			},
			downloadPromise: new Promise<void>((_, reject) => {
				endDownload = () => reject(new Error("cancelled"));
			}),
		});
		await suspending;
		expect(cancelled).toBe(true);
		expect(ready).toEqual([]);
		// Leaving: the cancelled download reported nothing, so it is checked again.
		updates.resume();
		expect(updates.get().status).toBe("idle");
		expect(updater.check).toHaveBeenCalledTimes(2);
		updates.stop();
	});

	it("refuses to suspend while a check hangs, and updates go on as before", async () => {
		const { updater, updates } = make();
		let answer = (_: unknown) => {};
		updater.check.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}) as never,
		);
		void updates.check();
		const started = Date.now();
		await expect(updates.suspend(30)).rejects.toThrow(UPDATE_STILL_RUNNING);
		expect(Date.now() - started).toBeLessThan(1_000);
		// Not suspended: the hung check's result still counts, and nothing new started meanwhile.
		expect(updates.isSuspended()).toBe(false);
		expect(updater.check).toHaveBeenCalledTimes(1);
		updater.emit("update-downloaded", { version: "0.2.0" });
		answer(null);
		expect(updates.canInstall()).toBe(true);
		updates.stop();
	});

	it("refuses to suspend while a cancelled download goes on", async () => {
		const { updater, updates, ready } = make();
		let cancels = 0;
		updater.check.mockImplementationOnce((async () => ({
			cancellationToken: {
				cancel: () => {
					cancels++;
				},
			},
			// The cancel is ignored: the download never ends.
			downloadPromise: new Promise<void>(() => {}),
		})) as never);
		await updates.check();
		await expect(updates.suspend(30)).rejects.toThrow(UPDATE_STILL_RUNNING);
		expect(cancels).toBe(1);
		expect(updates.isSuspended()).toBe(false);
		// A download that ends later is announced as usual.
		updater.emit("update-downloaded", { version: "0.2.0" });
		expect(ready).toEqual(["0.2.0"]);
		updates.stop();
	});

	it("goes back to idle when a download cancelled by a refused suspend ends later", async () => {
		const { updater, updates } = make();
		let endDownload = () => {};
		updater.check.mockImplementationOnce((async () => ({
			cancellationToken: { cancel: () => {} },
			downloadPromise: new Promise<void>((_, reject) => {
				endDownload = () => reject(new Error("cancelled"));
			}),
		})) as never);
		await updates.check();
		updater.emit("update-available", { version: "0.2.0" });
		expect(updates.get().status).toBe("downloading");
		await expect(updates.suspend(20)).rejects.toThrow(UPDATE_STILL_RUNNING);
		// The cancel takes effect after the deadline: no event says so.
		endDownload();
		await vi.waitFor(() => expect(updates.get().status).toBe("idle"));
		await updates.check();
		expect(updater.check).toHaveBeenCalledTimes(2);
		updates.stop();
	});

	it("refuses to install a downloaded update while suspended", async () => {
		const { updater, updates } = make();
		updater.emit("update-downloaded", { version: "0.2.0" });
		expect(updates.canInstall()).toBe(true);
		await updates.suspend();
		expect(updates.canInstall()).toBe(false);
		expect(updates.install()).toBe(false);
		expect(updater.installs).toBe(0);
		updates.resume();
		expect(updates.install()).toBe(true);
		expect(updater.installs).toBe(1);
		updates.stop();
	});

	it("announces a download that finished while suspended only on resume", async () => {
		const { updater, updates, ready } = make();
		await updates.suspend();
		updater.emit("update-downloaded", { version: "0.3.0" });
		expect(ready).toEqual([]);
		updates.resume();
		expect(ready).toEqual(["0.3.0"]);
		updates.stop();
	});
});

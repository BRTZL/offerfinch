import { describe, expect, it, vi } from "vitest";
import { shortError, type Updater, Updates } from "../src/main/updates";
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

const make = (disabledReason: string | null = null) => {
	const updater = new StubUpdater();
	const states: UpdateState[] = [];
	const ready: string[] = [];
	const updates = new Updates(updater, {
		currentVersion: "0.1.0",
		disabledReason,
		onChange: (s) => states.push(s),
		onReady: (v) => ready.push(v),
		log: () => {},
		now: () => new Date("2026-11-02T12:00:00Z"),
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

	it("names the usual failures plainly", () => {
		expect(shortError(new Error("HttpError: 404 Not Found\nbody"))).toBe(
			"No release published yet",
		);
		expect(
			shortError(new Error("Code signature at URL did not pass validation")),
		).toMatch(/Developer ID/);
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

	it("does not hold the switch for a check that hangs", async () => {
		const { updater, updates } = make();
		updater.check.mockImplementationOnce(() => new Promise(() => {}) as never);
		void updates.check();
		const started = Date.now();
		await updates.suspend(30);
		expect(Date.now() - started).toBeLessThan(1_000);
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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Shared with the mocks below (hoisted above the imports). */
const h = vi.hoisted(() => ({
	userData: "",
	loads: [] as string[],
	/** What the windows were sent (the worker-restart event). */
	sent: [] as string[],
	/** Holds the restore in its safety backup until the test lets it go on. */
	safety: null as Promise<void> | null,
}));

vi.mock("electron", () => ({
	app: {
		isPackaged: false,
		getPath: () => h.userData,
		getVersion: () => "1.0.0",
	},
	BrowserWindow: {
		getAllWindows: () => [
			{
				setTitle: () => {},
				webContents: {
					loadURL: async (url: string) => h.loads.push(url),
					send: (channel: string) => h.sent.push(channel),
				},
			},
		],
	},
	dialog: {
		showOpenDialog: async () => ({
			canceled: false,
			filePaths: ["/backups/offerfinch-backup.zip"],
		}),
	},
	protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
}));

vi.mock("../src/main/backup", async (original) => ({
	...(await original<typeof import("../src/main/backup")>()),
	stageRestore: async () => ({
		dir: fs.mkdtempSync(path.join(h.userData, "staged-")),
		summary: {},
	}),
	applyRestore: async (options: {
		stopWorker: () => Promise<void>;
		startWorker: (dbFile: string) => Promise<void>;
	}) => {
		await options.stopWorker();
		await h.safety;
		const dbFile = path.join(h.userData, "restored.sqlite");
		await options.startWorker(dbFile);
		return { dbFile, safetyBackup: "/backups/before-restore.zip" };
	},
}));

const { checkBackup, restoreBackup } = await import(
	"../src/main/backup-actions"
);
const { demoStatus, switchDemo } = await import("../src/main/demo-actions");
const { BACKUP_RUNNING, DEMO_SWITCHING, lifecycle } = await import(
	"../src/main/lifecycle"
);
const { mainState } = await import("../src/main/state");
const { DEMO_REFUSAL } = await import("../src/main/demo-actions");
const { IPC } = await import("../src/shared/bridge");

/** The worker and updates as main drives them, recording what ran. */
function stubs() {
	const calls: string[] = [];
	const worker = {
		stop: vi.fn(async () => {
			calls.push("stop");
		}),
		restart: vi.fn(async () => {
			calls.push(`start ${mainState.demo ? "demo" : "real"}`);
		}),
	};
	const updates = {
		suspend: vi.fn(async () => {
			calls.push("suspend updates");
		}),
		resume: vi.fn(() => {
			calls.push("resume updates");
		}),
	};
	const sites = {
		blocked: null as string | null,
		block: vi.fn((reason: string | null) => {
			sites.blocked = reason;
		}),
		closeAll: vi.fn(() => {
			calls.push("close sites");
		}),
	};
	Object.assign(mainState, { worker, updates, sites });
	return { calls, worker, updates, sites };
}

beforeEach(() => {
	h.userData = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-switch-"));
	h.loads = [];
	h.sent = [];
	h.safety = null;
	Object.assign(mainState, {
		demo: false,
		databaseFile: path.join(h.userData, "offerfinch.sqlite"),
		realDatabaseFile: null,
		leaveFailed: null,
	});
});

describe("one switch at a time: demo, backup and restore", () => {
	it("refuses to enter demo while a restore runs, and the restore stays on the real data", async () => {
		const { calls } = stubs();
		let goOn = () => {};
		h.safety = new Promise<void>((resolve) => {
			goOn = resolve;
		});
		const check = await checkBackup();
		if (check.status !== "ready") throw new Error(check.status);
		const restoring = restoreBackup(check.id);
		await vi.waitFor(() => expect(calls).toEqual(["stop"]));
		// The click on Try it with sample data while the safety backup is being made.
		expect(await switchDemo(true)).toEqual({
			ok: false,
			error: BACKUP_RUNNING,
		});
		goOn();
		expect((await restoring).status).toBe("restored");
		expect(mainState.demo).toBe(false);
		expect(mainState.databaseFile).toBe(
			path.join(h.userData, "restored.sqlite"),
		);
		expect(calls).toEqual(["stop", "start real"]);
		calls.length = 0;
		// Once the restore is done, the demo can be entered.
		expect(await switchDemo(true)).toEqual({ ok: true });
		expect(mainState.demo).toBe(true);
		expect(await switchDemo(false)).toEqual({ ok: true });
	});

	it("refuses a backup or restore while the demo switch runs", async () => {
		const { worker } = stubs();
		let started = () => {};
		worker.restart.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					started = resolve;
				}),
		);
		const entering = switchDemo(true);
		await vi.waitFor(() => expect(worker.restart).toHaveBeenCalled());
		expect(await checkBackup()).toEqual({
			status: "refused",
			error: DEMO_SWITCHING,
		});
		started();
		expect(await entering).toEqual({ ok: true });
		expect(await switchDemo(false)).toEqual({ ok: true });
	});

	it("refuses to switch while a key is being saved", async () => {
		stubs();
		const keySave = lifecycle.share();
		if ("busy" in keySave) throw new Error(keySave.busy);
		const refused = await switchDemo(true);
		expect(refused.ok).toBe(false);
		expect(mainState.demo).toBe(false);
		keySave.release();
		expect(await switchDemo(true)).toEqual({ ok: true });
		// And a key save waits for nothing while a switch runs: it is refused.
		const { worker } = stubs();
		let started = () => {};
		worker.restart.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					started = resolve;
				}),
		);
		const leaving = switchDemo(false);
		await vi.waitFor(() => expect(worker.restart).toHaveBeenCalled());
		expect(lifecycle.share()).toEqual({ busy: DEMO_SWITCHING });
		started();
		await leaving;
	});

	it("keeps a failed leave in the strip, and Leave again starts the real worker", async () => {
		const { calls, worker, updates } = stubs();
		expect(await switchDemo(true)).toEqual({ ok: true });
		calls.length = 0;
		h.loads = [];
		worker.restart.mockImplementationOnce(async () => {
			calls.push("start real (fails)");
			throw new Error("The worker did not start in time");
		});
		expect(await switchDemo(false)).toEqual({
			ok: false,
			error: "The worker did not start in time",
		});
		expect(demoStatus()).toEqual({
			demo: true,
			leaveFailed: "The worker did not start in time",
		});
		// The windows reload to show the error and the retry; updates stay suspended.
		expect(h.loads).toHaveLength(1);
		expect(updates.resume).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(h.userData, "demo"))).toBe(false);
		// Entering again is refused until the leave is done.
		expect((await switchDemo(true)).ok).toBe(false);

		calls.length = 0;
		expect(await switchDemo(false)).toEqual({ ok: true });
		expect(calls).toEqual([
			"stop",
			"close sites",
			"start real",
			"resume updates",
		]);
		expect(demoStatus()).toEqual({ demo: false, leaveFailed: null });
		expect(mainState.databaseFile).toBe(
			path.join(h.userData, "offerfinch.sqlite"),
		);
	});
});

describe("site tabs and the demo", () => {
	it("closes every site tab once the real worker stops, and opens none until leaving", async () => {
		const { calls, worker, sites } = stubs();
		let started = () => {};
		worker.restart.mockImplementationOnce(async () => {
			calls.push("start demo");
			// Throughout the switch, a sheet or a run's claim is refused.
			expect(sites.blocked).toBe(DEMO_SWITCHING);
			await new Promise<void>((resolve) => {
				started = resolve;
			});
		});
		const entering = switchDemo(true);
		await vi.waitFor(() => expect(worker.restart).toHaveBeenCalled());
		started();
		expect(await entering).toEqual({ ok: true });
		expect(calls).toEqual([
			"suspend updates",
			"stop",
			"close sites",
			"start demo",
		]);
		expect(sites.blocked).toBe(DEMO_REFUSAL);
		calls.length = 0;
		expect(await switchDemo(false)).toEqual({ ok: true });
		expect(calls).toEqual([
			"stop",
			"close sites",
			"start real",
			"resume updates",
		]);
		expect(sites.blocked).toBe(null);
	});

	it("keeps sites closed after a failed leave", async () => {
		const { worker, sites } = stubs();
		expect(await switchDemo(true)).toEqual({ ok: true });
		worker.restart.mockRejectedValueOnce(new Error("no start"));
		expect((await switchDemo(false)).ok).toBe(false);
		expect(sites.blocked).toBe(DEMO_REFUSAL);
		expect(await switchDemo(false)).toEqual({ ok: true });
		expect(sites.blocked).toBe(null);
	});

	it("refuses to enter when an update request does not end, and changes nothing", async () => {
		const { calls, updates, sites } = stubs();
		updates.suspend.mockRejectedValueOnce(
			new Error("An update check is still running. Try again in a moment."),
		);
		expect(await switchDemo(true)).toEqual({
			ok: false,
			error: "An update check is still running. Try again in a moment.",
		});
		// The real worker was never stopped; updates go on (suspend() undid itself).
		expect(calls).toEqual(["resume updates"]);
		expect(h.sent).toEqual([]);
		expect(h.loads).toEqual([]);
		expect(mainState.demo).toBe(false);
		expect(sites.blocked).toBe(null);
	});
});

describe("a demo folder that cannot be made", () => {
	it("starts the real worker on the real database again and reports the error", async () => {
		const { calls } = stubs();
		const mkdir = vi.spyOn(fs, "mkdirSync").mockImplementationOnce(() => {
			throw Object.assign(new Error("EACCES: permission denied, mkdir"), {
				code: "EACCES",
			});
		});
		try {
			expect(await switchDemo(true)).toEqual({
				ok: false,
				error: "EACCES: permission denied, mkdir",
			});
		} finally {
			mkdir.mockRestore();
		}
		expect(calls).toEqual([
			"suspend updates",
			"stop",
			"close sites",
			"stop",
			"close sites",
			"start real",
			"resume updates",
		]);
		expect(demoStatus()).toEqual({ demo: false, leaveFailed: null });
		expect(mainState.databaseFile).toBe(
			path.join(h.userData, "offerfinch.sqlite"),
		);
		expect(mainState.realDatabaseFile).toBe(null);
		// The window keeps the welcome and its error, and connects to the new real worker.
		expect(h.loads).toEqual([]);
		expect(h.sent).toEqual([IPC.workerRestart]);
	});

	it("offers Leave again when the real worker does not start either", async () => {
		const { calls, worker } = stubs();
		const mkdir = vi.spyOn(fs, "mkdirSync").mockImplementationOnce(() => {
			throw new Error("ENOSPC: no space left on device, mkdir");
		});
		worker.restart.mockRejectedValueOnce(
			new Error("The worker did not start in time"),
		);
		try {
			expect((await switchDemo(true)).ok).toBe(false);
		} finally {
			mkdir.mockRestore();
		}
		expect(demoStatus()).toEqual({
			demo: true,
			leaveFailed: "The worker did not start in time",
		});
		expect(mainState.databaseFile).toBe(
			path.join(h.userData, "offerfinch.sqlite"),
		);
		calls.length = 0;
		expect(await switchDemo(false)).toEqual({ ok: true });
		expect(calls).toEqual([
			"stop",
			"close sites",
			"start real",
			"resume updates",
		]);
		expect(demoStatus()).toEqual({ demo: false, leaveFailed: null });
	});
});

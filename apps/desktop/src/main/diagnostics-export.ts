import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app, dialog } from "electron";
import type { DiagnosticsPreview, ReleaseNotesSource } from "../shared/bridge";
import {
	buildDiagnostics,
	type DiagnosticFile,
	type KnownPersonal,
	previewOf,
	zipDiagnostics,
} from "./diagnostics";
import { log, mainState, TEST_MODE } from "./state";

/**
 * Test runs' stand-ins for the save panel, the changelog and the version. Honoured only in an
 * unpackaged build: measure.mjs and the screenshot scripts run the packaged app with
 * OFFERFINCH_TEST=1, and there an environment variable must never choose a file the app reads
 * into the window or a path it overwrites without asking.
 */
export function testOverride(
	name:
		| "OFFERFINCH_TEST_SAVE_TO"
		| "OFFERFINCH_TEST_CHANGELOG"
		| "OFFERFINCH_TEST_VERSION",
): string | undefined {
	if (!TEST_MODE || app.isPackaged) return undefined;
	return process.env[name] || undefined;
}

/** The worker answers in well under this; a stuck worker must not hold the export. */
const WORKER_WAIT_MS = 10_000;

/** Bundles shown in a review sheet and not yet saved or cancelled: at most a few. */
const prepared = new Map<string, DiagnosticFile[]>();

interface WorkerDiagnostics {
	settings: unknown;
	personal: KnownPersonal;
}

function askWorker(): Promise<WorkerDiagnostics> {
	return Promise.race([
		mainState.worker.request<WorkerDiagnostics>("diagnostics"),
		new Promise<never>((_, reject) =>
			setTimeout(
				() => reject(new Error("The worker did not answer")),
				WORKER_WAIT_MS,
			),
		),
	]);
}

function systemLines(): Record<string, string> {
	const update = mainState.updates?.get();
	return {
		OfferFinch: app.getVersion(),
		Electron: process.versions.electron ?? "",
		Chrome: process.versions.chrome ?? "",
		Node: process.versions.node ?? "",
		macOS: process.getSystemVersion(),
		Architecture: process.arch,
		Packaged: String(app.isPackaged),
		Locale: app.getLocale(),
		"Running for": `${Math.round((Date.now() - mainState.startedAt) / 60_000)} min`,
		Updates: update
			? `${update.status}${"error" in update ? `: ${update.error}` : ""}`
			: "unknown",
		Notifications: mainState.notifier?.get().status ?? "unknown",
	};
}

/**
 * Builds the bundle and keeps it until the user saves or cancels. If the worker cannot answer
 * (it may be what is broken), the bundle is made without its summary, and with no name to
 * redact the sheet says so: email, phone, key and path patterns still apply.
 */
export async function prepareDiagnostics(): Promise<DiagnosticsPreview> {
	const warnings: string[] = [];
	let fromWorker: WorkerDiagnostics;
	try {
		fromWorker = await askWorker();
	} catch (error) {
		log("diagnostics: worker summary unavailable", String(error));
		warnings.push(
			"The background worker did not answer, so the settings summary is missing and your name could not be read from your profile to remove it. Check the logs below before you share them.",
		);
		fromWorker = {
			settings: { unavailable: "The worker did not answer." },
			personal: { names: [], emails: [], phones: [], links: [] },
		};
	}
	const files = buildDiagnostics({
		logsDir: app.getPath("logs"),
		userDataDir: app.getPath("userData"),
		system: systemLines(),
		settings: fromWorker.settings,
		known: fromWorker.personal,
	});
	const id = randomUUID();
	// One open sheet at a time is normal; never let cancelled bundles pile up in memory.
	if (prepared.size >= 3) prepared.clear();
	prepared.set(id, files);
	return { id, files: files.map(previewOf), warnings };
}

const defaultName = () =>
	`offerfinch-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`;

/** Saves the prepared bundle where the user picks. Test runs save to OFFERFINCH_TEST_SAVE_TO. */
export async function saveDiagnostics(id: string): Promise<boolean> {
	const files = prepared.get(id);
	if (!files) throw new Error("This bundle is gone. Export it again.");
	const testTarget = testOverride("OFFERFINCH_TEST_SAVE_TO");
	const target =
		testTarget ??
		(
			await dialog.showSaveDialog({
				defaultPath: path.join(app.getPath("downloads"), defaultName()),
				filters: [{ name: "Zip archive", extensions: ["zip"] }],
			})
		).filePath;
	if (!target) return false;
	await zipDiagnostics(files, target);
	prepared.delete(id);
	log("diagnostics saved", { files: files.length });
	return true;
}

export function discardDiagnostics(id: string) {
	prepared.delete(id);
}

/**
 * The release notes bundled with the app: CHANGELOG.md in the app's Resources (packaged) or
 * apps/desktop (development). Unpackaged test runs can point at a fabricated changelog and
 * version.
 */
export function releaseNotes(): ReleaseNotesSource {
	const file =
		testOverride("OFFERFINCH_TEST_CHANGELOG") ??
		(app.isPackaged
			? path.join(process.resourcesPath, "CHANGELOG.md")
			: path.join(app.getAppPath(), "CHANGELOG.md"));
	let changelog = "";
	try {
		changelog = fs.readFileSync(file, "utf8");
	} catch (error) {
		log("release notes unreadable", String(error));
	}
	return {
		version: testOverride("OFFERFINCH_TEST_VERSION") ?? app.getVersion(),
		changelog,
	};
}

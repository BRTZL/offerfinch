import path from "node:path";
import { app, Menu, nativeImage, Tray } from "electron";
import { showsDemo, switchDemo } from "./demo-actions";
import { assets, mainState } from "./state";
import { showWindow } from "./window";

/* ------------------------------------------------------------------- tray */

function relative(iso: string | null): string {
	if (!iso) return "never";
	const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function trayMenu() {
	const s = mainState.lastStatus;
	const state =
		s === null
			? "Starting…"
			: s.state === "scanning"
				? "Scanning…"
				: s.paused
					? "Paused"
					: s.state === "error"
						? `Problem: ${s.error ?? "see the app"}`
						: "Idle";
	const counts = s
		? `${s.counts.review} to review · ${s.counts.questions} question${s.counts.questions === 1 ? "" : "s"} · ${s.counts.applied} applied`
		: "";
	return Menu.buildFromTemplate([
		...(showsDemo()
			? [
					{ label: "Demo: sample data, nothing here is real", enabled: false },
					{
						label:
							mainState.leaveFailed === null
								? "Leave Demo"
								: "Leave Demo (Try Again)",
						click: () => void switchDemo(false),
					},
					{ type: "separator" as const },
				]
			: []),
		{ label: state, enabled: false },
		{ label: `Last scan: ${relative(s?.lastScanAt ?? null)}`, enabled: false },
		...(s?.lastScanSummary
			? [{ label: s.lastScanSummary, enabled: false }]
			: []),
		...(counts ? [{ label: counts, enabled: false }] : []),
		{ type: "separator" },
		{
			label: "Scan now",
			enabled: Boolean(s) && s?.state !== "scanning",
			click: () => void mainState.worker.request("scanNow").catch(() => {}),
		},
		{
			label: s?.paused ? "Resume scans" : "Pause scans",
			enabled: Boolean(s),
			click: () =>
				void mainState.worker.request("setPaused", !s?.paused).catch(() => {}),
		},
		{ type: "separator" },
		// Not while try-it mode runs: installing is refused then (updates are suspended).
		...(mainState.updates?.canInstall()
			? [
					{
						label: `Restart to Update to ${(mainState.updates.get() as { version: string }).version}`,
						click: () => mainState.updates?.install(),
					},
					{ type: "separator" as const },
				]
			: []),
		{ label: "Open OfferFinch", click: () => showWindow() },
		{ label: "About OfferFinch", click: () => app.showAboutPanel() },
		{ type: "separator" },
		{
			label: "Quit OfferFinch",
			accelerator: "Command+Q",
			click: () => {
				mainState.quitting = true;
				app.quit();
			},
		},
	]);
}

/** The menu bar icon: the finch, with a square at its top right when a scan stopped or failed. */
let trayVariant: "normal" | "attention" | null = null;

function trayImage(variant: "normal" | "attention") {
	const image = nativeImage.createFromPath(
		path.join(
			assets,
			variant === "attention"
				? "trayAttentionTemplate.png"
				: "trayTemplate.png",
		),
	);
	image.setTemplateImage(true);
	return image;
}

export function updateTray() {
	if (!mainState.tray) return;
	const variant =
		mainState.lastStatus?.state === "error" ||
		mainState.lastStatus?.lastScanSummary === "Last scan stopped"
			? "attention"
			: "normal";
	if (variant !== trayVariant) {
		trayVariant = variant;
		mainState.tray.setImage(trayImage(variant));
	}
	mainState.tray.setContextMenu(trayMenu());
	const review = mainState.lastStatus?.counts.review ?? 0;
	// Try-it mode says so in the menu bar, next to the finch.
	const count = review > 0 ? String(review) : "";
	mainState.tray.setTitle(
		showsDemo() ? `Demo${count ? ` ${count}` : ""}` : count,
		{ fontType: "monospacedDigit" },
	);
	mainState.tray.setToolTip(
		showsDemo()
			? "OfferFinch: demo with sample data"
			: mainState.lastStatus?.state === "scanning"
				? "OfferFinch: scanning"
				: variant === "attention"
					? "OfferFinch: the last scan stopped"
					: "OfferFinch",
	);
}

export function createTray() {
	trayVariant = "normal";
	mainState.tray = new Tray(trayImage("normal"));
	updateTray();
}

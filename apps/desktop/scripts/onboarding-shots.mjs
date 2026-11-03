// Every onboarding screen and notable sub-state of the packaged app, as macOS draws the window
// (screencapture -l: title bar, traffic lights and material included), in light and dark at
// 1440 × 900, with the fabricated e2e identity, fake models and a temporary data folder.
// Writes docs/screenshots/onboarding/NN-name-<theme>.png, in order.
// Usage: node scripts/onboarding-shots.mjs <OfferFinch.app>
// Needs the screen unlocked and Screen Recording permission for the terminal.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";
import { startFixtureBoards } from "../e2e/fixture-boards.ts";
import { RESUME } from "../e2e/launch.ts";
import { assertSafeBuild } from "./safe-build.mjs";

const appPath = path.resolve(process.argv[2]);
assertSafeBuild(appPath);
const root = path.resolve(import.meta.dirname, "../../..");
const out = path.join(root, "docs/screenshots/onboarding");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const windowId = path.join(os.tmpdir(), "offerfinch-window-id");
if (!fs.existsSync(windowId))
	execFileSync("swiftc", [
		"-O",
		path.join(import.meta.dirname, "window-id.swift"),
		"-o",
		windowId,
	]);

const boards = await startFixtureBoards();
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "of-onboarding-shots-"));
// Notifications as macOS left them for this bundle the last time: blocked, so the step asks.
fs.writeFileSync(
	path.join(userData, "notifications.json"),
	JSON.stringify({ status: "blocked", missed: 0, lastError: null, at: null }),
);
const env = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => k !== "ELECTRON_RUN_AS_NODE"),
);
const app = await electron.launch({
	executablePath: path.join(appPath, "Contents/MacOS/OfferFinch"),
	env: {
		...env,
		OFFERFINCH_USER_DATA: userData,
		OFFERFINCH_TEST: "1",
		OFFERFINCH_FAKE_MODELS: "1",
		OFFERFINCH_NO_SCHEDULE: "1",
		// Slow enough to see drafting in progress.
		OFFERFINCH_FAKE_DELAY_MS: "6000",
		OFFERFINCH_FETCH_REWRITE: JSON.stringify(boards.rewrite),
		OFFERFINCH_SITE_ORIGINS: JSON.stringify(boards.siteOrigins),
	},
});
const page = await app.firstWindow();
const pid = app.process().pid;
let n = 0;

await app.evaluate(({ BrowserWindow, app: a }) => {
	const win = BrowserWindow.getAllWindows()[0];
	win?.setContentSize(1440, 900);
	win?.center();
	a.focus({ steal: true });
	win?.focus();
});

const theme = (scheme) =>
	app.evaluate(({ nativeTheme }, s) => {
		nativeTheme.themeSource = s;
	}, scheme);

async function shot(name) {
	n++;
	await page.mouse.move(2, 898);
	for (const scheme of ["light", "dark"]) {
		await theme(scheme);
		await page.waitForTimeout(700);
		const id = execFileSync(windowId, [String(pid)], {
			encoding: "utf8",
		}).trim();
		const file = path.join(
			out,
			`${String(n).padStart(2, "0")}-${name}-${scheme}.png`,
		);
		execFileSync("screencapture", ["-o", "-x", "-l", id, file]);
		console.log(path.relative(root, file));
	}
	await theme("system");
}

try {
	await page.getByTestId("welcome").waitFor();
	await page.waitForTimeout(1500);
	await shot("welcome");

	await page.getByTestId("welcome-start").click();
	await page.getByTestId("setup-ai").waitFor();
	await shot("connect-ai");
	await page.getByTestId("models-manual").getByRole("button").first().click();
	for (const role of ["scoring", "tailoring", "claims"]) {
		await page.getByTestId(`role-${role}-mode`).click();
		await page.getByTestId(`role-${role}-fake`).click();
	}
	await page.getByTestId("step-continue").click();

	await page.getByTestId("resume-option-upload").waitFor();
	await shot("resume-options");
	await page.getByTestId("onboarding-file").setInputFiles({
		name: "sam-rivera-resume.txt",
		mimeType: "text/plain",
		buffer: Buffer.from(RESUME),
	});
	await page
		.getByTestId("resume-file-status")
		.getByText(/words read/)
		.waitFor();
	await shot("resume-upload");
	await page.getByTestId("resume-back").click();
	await page.getByTestId("resume-option-paste").click();
	await page.getByTestId("onboarding-text").fill(RESUME);
	await shot("resume-paste");
	await page.getByTestId("onboarding-structure").click();
	await page.getByTestId("resume-drafting").waitFor();
	await shot("resume-drafting");

	await page.getByTestId("onboarding-draft").waitFor({ timeout: 60_000 });
	await shot("review-draft");
	await page.getByTestId("onboarding-save").click();

	// What you want: the rules and job-board search (the fixture boards' stand-in).
	await page.getByTestId("setup-sources").waitFor();
	await shot("what-you-want");
	await page.getByTestId("step-continue").click();

	// Stay in the loop: notifications, then open at login.
	await page.getByTestId("notify-test").waitFor();
	await page.waitForTimeout(800);
	await shot("notifications-needs-permission");
	await page.getByTestId("notify-test").click();
	await page
		.locator('[data-testid="notify-status"][data-status="delivered"]')
		.waitFor();
	await shot("stay-in-the-loop");
	await page.getByTestId("step-continue").click();

	await page.getByTestId("first-scan-start").waitFor();
	await shot("first-search");
	await page.getByTestId("first-scan-start").click();
	await page.getByTestId("first-scan-progress").waitFor();
	await shot("first-search-running");
	await page.getByTestId("onboarding-finish").waitFor({ timeout: 120_000 });
	await shot("first-search-done");
} finally {
	await app.close();
	await boards.close();
}

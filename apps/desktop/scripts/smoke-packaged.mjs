// Launch check for a packaged build (.github/workflows/desktop-release.yml): opens the app in
// background test mode (never on screen, never the active app) against a temporary data folder,
// waits for its first screen and fails on any page error. Never touches the user's own data.
//
// Usage: node scripts/smoke-packaged.mjs <path to OfferFinch.app>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";

const bundle = process.argv[2];
if (!bundle) {
	console.error("Usage: node scripts/smoke-packaged.mjs <OfferFinch.app>");
	process.exit(1);
}
const executablePath = path.resolve(bundle, "Contents/MacOS/OfferFinch");
if (!fs.existsSync(executablePath)) {
	console.error(`No app binary at ${executablePath}`);
	process.exit(1);
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-smoke-"));
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		([k, v]) => k !== "ELECTRON_RUN_AS_NODE" && v !== undefined,
	),
);
let electronApp;
let failed = false;
try {
	electronApp = await electron.launch({
		executablePath,
		args: [],
		timeout: 60_000,
		env: {
			...env,
			OFFERFINCH_USER_DATA: userData,
			OFFERFINCH_TEST: "1",
			OFFERFINCH_TEST_BACKGROUND: "1",
			OFFERFINCH_FAKE_MODELS: "1",
			OFFERFINCH_NO_SCHEDULE: "1",
		},
	});
	const page = await electronApp.firstWindow({ timeout: 60_000 });
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	// A new user starts in setup: reaching it means the renderer, the worker and the database
	// (better-sqlite3's native module, unpacked from the asar) all loaded.
	const deadline = Date.now() + 60_000;
	let pathname = "";
	while (Date.now() < deadline) {
		pathname = new URL(page.url()).pathname;
		if (pathname === "/onboarding") break;
		await new Promise((r) => setTimeout(r, 500));
	}
	const version = await electronApp.evaluate(({ app }) => app.getVersion());
	if (pathname !== "/onboarding") {
		failed = true;
		console.error(`The app did not reach setup (at ${pathname || "nothing"}).`);
	}
	if (errors.length) {
		failed = true;
		console.error(`Page errors:\n${errors.join("\n")}`);
	}
	if (!failed) console.log(`OfferFinch ${version} launched and reached setup.`);
} catch (error) {
	failed = true;
	console.error(
		`Launch failed: ${error instanceof Error ? error.message : error}`,
	);
} finally {
	await electronApp?.close().catch(() => {});
	fs.rmSync(userData, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

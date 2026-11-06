// Hidden renderer screenshots of the packaged app with fabricated e2e identity (Sam Rivera)
// and fake models: every screen, light and dark, at 1440 × 900. Native window chrome and
// vibrancy are omitted; no window is shown or focused. Measures the shared DOM geometry too.
// Usage: node scripts/screenshots.mjs <OfferFinch.app> <prepared data folder>
// Prepare with E2E_USER_DATA=<folder> pnpm e2e desktop.spec.ts. Set OFFERFINCH_SCREENSHOTS
// to keep comparison artifacts outside the repository; otherwise updates docs/screenshots.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";
import { assertSafeBuild } from "./safe-build.mjs";

const appPath = path.resolve(process.argv[2]);
assertSafeBuild(appPath);
const prepared = path.resolve(process.argv[3]);
const root = path.resolve(import.meta.dirname, "../../..");
const out =
	process.env.OFFERFINCH_SCREENSHOTS ??
	path.join(root, "docs/screenshots/desktop");
fs.mkdirSync(out, { recursive: true });
const exe = path.join(appPath, "Contents/MacOS/OfferFinch");
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		([k]) => k !== "ELECTRON_RUN_AS_NODE" && k !== "PATH",
	),
);
// A GUI app's PATH, and no login shell PATH: the Models page shows no real CLI paths.
env.PATH = "/usr/bin:/bin";
env.SHELL = "/bin/sh";
// A home folder of its own, so no install folder of this Mac's user is found or shown.
env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "of-shots-home-"));
// Terms that must never show in a screenshot: the denylist kept outside the repository
// (scripts/check-public.mjs), plus the Mac user's own login name.
const DENYLIST =
	process.env.PUBLIC_DENYLIST ??
	path.join(os.homedir(), ".config/offerfinch/public-denylist.txt");
const REAL = [
	os.userInfo().username,
	...(fs.existsSync(DENYLIST)
		? fs
				.readFileSync(DENYLIST, "utf8")
				.split("\n")
				.map((t) => t.trim())
				.filter((t) => t.length > 2 && !t.startsWith("#"))
		: []),
];

const geometry = {};

/** The shared geometry of the screen on show, measured from the system's data-ds marks. */
async function measure(page) {
	return page.evaluate(() => {
		const r = (el) => el?.getBoundingClientRect();
		const main = r(document.querySelector("#main"));
		const header = document.querySelector("[data-ds=page-header]");
		const title = document.querySelector("[data-ds=page-title]");
		const pageEl = document.querySelector("[data-ds=page]");
		const sections = [...document.querySelectorAll("[data-ds=section]")].filter(
			(s) => s.parentElement?.closest("[data-ds=section]") === null,
		);
		const gaps = [];
		for (let i = 1; i < sections.length; i++) {
			const a = r(sections[i - 1]);
			const b = r(sections[i]);
			if (Math.abs(a.left - b.left) < 2)
				gaps.push(Math.round(b.top - a.bottom));
		}
		const row = document.querySelector("[data-ds=row]");
		const formRow = document.querySelector("[data-ds=form-row]");
		const titleStyle = title ? getComputedStyle(title) : null;
		const titleText = title ? r(title) : null;
		return {
			header: header ? Math.round(r(header).height) : null,
			titleSize: titleStyle?.fontSize ?? null,
			// The title's text box centre against the header's: 0 when centred.
			titleOffset:
				header && titleText
					? Math.round(
							titleText.top +
								titleText.height / 2 -
								(r(header).top + r(header).height / 2),
						)
					: null,
			headerInset:
				header && main
					? Math.round(Number.parseFloat(getComputedStyle(header).paddingLeft))
					: null,
			contentInset: pageEl
				? Math.round(Number.parseFloat(getComputedStyle(pageEl).paddingLeft))
				: null,
			sectionGap: gaps.length ? [...new Set(gaps)] : null,
			rowHeight: row ? Math.round(r(row).height) : null,
			formRowHeight: formRow ? Math.round(r(formRow).height) : null,
			bodySize: getComputedStyle(document.body).fontSize,
		};
	});
}

async function run(dataDir, steps, extraEnv = {}) {
	const app = await electron.launch({
		executablePath: exe,
		env: {
			...env,
			OFFERFINCH_USER_DATA: dataDir,
			OFFERFINCH_TEST: "1",
			OFFERFINCH_TEST_BACKGROUND: "1",
			OFFERFINCH_FAKE_MODELS: "1",
			OFFERFINCH_NO_SCHEDULE: "1",
			...extraEnv,
		},
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(20_000);
	// The fixture timestamp keeps relative dates stable across before/after captures.
	await page.clock.setFixedTime(new Date(fs.statSync(prepared).mtimeMs));
	await app.evaluate(({ BrowserWindow }) => {
		const win = BrowserWindow.getAllWindows()[0];
		win?.setContentSize(1440, 900);
	});
	const go = async (to) => {
		await page.evaluate((p) => {
			history.pushState(null, "", p);
			dispatchEvent(new PopStateEvent("popstate"));
		}, to);
		await page.waitForTimeout(900);
	};
	const theme = async (scheme) => {
		await app.evaluate(({ nativeTheme }, s) => {
			nativeTheme.themeSource = s;
		}, scheme);
		await page.waitForTimeout(400);
	};
	// The same state in both themes.
	const shot = async (name) => {
		// No hover highlight: the pointer rests where the last click was otherwise.
		await page.mouse.move(1, 899);
		const text = await page.evaluate(() => document.body.textContent ?? "");
		const leak = REAL.find((r) => text.includes(r));
		if (leak) throw new Error(`${name}: real identity on screen (${leak})`);
		geometry[name] = await measure(page);
		for (const scheme of ["light", "dark"]) {
			await theme(scheme);
			const file = path.join(out, `${name}-${scheme}.png`);
			// Hidden pages have no native material behind the sidebar.
			await page.evaluate(() =>
				document.documentElement.classList.remove("vibrant"),
			);
			await page.screenshot({ path: file, animations: "disabled" });
			await page.evaluate(() =>
				document.documentElement.classList.add("vibrant"),
			);
			console.log(path.relative(root, file));
		}
		await theme("light");
	};
	try {
		await page.waitForTimeout(1500);
		await steps({ page, go, shot, app });
	} catch (error) {
		console.error(
			"Screenshot state:",
			page.url(),
			await page.locator("body").textContent(),
		);
		throw error;
	} finally {
		await app.close();
	}
}

const copy = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "of-shots-"));
	fs.cpSync(prepared, dir, { recursive: true });
	for (const f of ["migration.json", "SingletonLock", "SingletonSocket"])
		fs.rmSync(path.join(dir, f), { force: true });
	return dir;
};

for (const old of fs.readdirSync(out))
	if (old.endsWith(".png")) fs.rmSync(path.join(out, old));

// First start: the welcome, then setup; "Finish later" opens the calm, empty Home.
await run(
	fs.mkdtempSync(path.join(os.tmpdir(), "of-shots-new-")),
	async ({ page, shot }) => {
		await page.getByTestId("welcome").waitFor();
		await shot("01-onboarding-welcome");
		await page.getByTestId("welcome-start").click();
		await page.getByTestId("setup-ai").waitFor();
		// Starting models: the test models for every step.
		for (const role of ["scoring", "tailoring", "claims"]) {
			await page.getByTestId(`role-${role}-mode`).click();
			await page.getByTestId(`role-${role}-fake`).click();
		}
		await page.waitForTimeout(500);
		await shot("02-onboarding-connect-ai");
		await page.getByTestId("step-continue").click();
		await page.getByTestId("resume-option-paste").click();
		await page.getByTestId("onboarding-text").waitFor();
		await shot("03-onboarding-resume");
		await page.getByTestId("onboarding-later").click();
		// Nothing set up yet: capture the empty Home.
		await page.getByTestId("home").waitFor();
		await shot("04-home-empty");
	},
);

// A Mac in use: every screen.
await run(copy(), async ({ page, go, shot }) => {
	await go("/");
	await page.getByTestId("home").waitFor();
	await shot("05-home");
	await go("/inbox?view=review");
	await page.getByTestId("inbox-row").first().waitFor();
	await page.getByTestId("inbox-row").first().click();
	await page.getByTestId("approve").waitFor();
	await page.waitForTimeout(1200);
	await shot("06-inbox");
	await go("/inbox?view=matches");
	await page.getByTestId("inbox-row").first().click();
	await page.getByTestId("prepare").waitFor();
	await page.waitForTimeout(800);
	await shot("06b-inbox-match");
	await go("/inbox?view=all");
	await page
		.locator("[data-testid=inbox-row][data-state=applied]")
		.first()
		.click();
	await page.waitForTimeout(1500);
	await shot("07-inbox-applied");
	await go("/questions");
	await page.waitForTimeout(800);
	await shot("08-questions");
	await go("/applied");
	await page.waitForTimeout(800);
	await shot("09-applied");
	await go("/rejected");
	await page.waitForTimeout(800);
	await shot("10-rejected");
	await go("/profile/about");
	await page.waitForTimeout(800);
	await shot("11-profile");
	await go("/profile/experience");
	await page.getByTestId("record-row").first().waitFor();
	await shot("11b-profile-experience");
	await go("/settings/models");
	await page.getByTestId("role-scoring").waitFor();
	await shot("12-settings-models");
	// The picker open: every model by provider, with effort.
	await page.getByTestId("role-tailoring-mode").click();
	await page.getByTestId("role-tailoring-mode-menu").waitFor();
	await shot("12b-settings-models-picker");
	await page.keyboard.press("Escape");
	await go("/settings/sources");
	await page.getByTestId("source-job-board-search").waitFor();
	await shot("13-settings-sources");
	await go("/settings/job-filter");
	await page.waitForTimeout(800);
	await shot("13b-settings-job-search");
	await go("/settings/spending");
	await page.waitForTimeout(800);
	await shot("14-settings-spending");
	await go("/settings/general");
	await page.getByTestId("about-version").waitFor();
	await shot("15-settings-general");
	await go("/");
	await page.getByTestId("search-button").click();
	await page.getByTestId("command-menu").waitFor();
	await shot("16-command-menu");
});

fs.writeFileSync(
	process.env.OFFERFINCH_SCREENSHOTS
		? path.join(out, "consistency.json")
		: path.join(root, "docs/design/desktop/consistency.json"),
	`${JSON.stringify(geometry, null, "\t")}\n`,
);
console.log(
	process.env.OFFERFINCH_SCREENSHOTS
		? path.join(out, "consistency.json")
		: "docs/design/desktop/consistency.json",
);

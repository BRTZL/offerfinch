import fs from "node:fs";
import path from "node:path";
import {
	type ElectronApplication,
	expect,
	type Page,
	test,
} from "@playwright/test";

import { launchApp, openRoute, tempUserData } from "./launch";

/**
 * The first run as a focused, full-window flow: no app sidebar, one centred column, a footer
 * whose buttons never move, a faint ambient field that runs only while the window is visible and
 * focused (never under reduced motion) and is gone after onboarding. Frames in both themes at the
 * smallest and the design's window size go to E2E_SHOTS.
 */
test.describe.configure({ mode: "serial" });

const SHOTS = process.env.E2E_SHOTS
	? path.resolve(process.env.E2E_SHOTS)
	: null;
const userData = tempUserData();

async function size(app: ElectronApplication, width: number, height: number) {
	await app.evaluate(
		({ BrowserWindow }, [w, h]) => {
			const win = BrowserWindow.getAllWindows()[0];
			win?.setContentSize(w as number, h as number);
			win?.center();
		},
		[width, height],
	);
}
async function theme(
	app: ElectronApplication,
	scheme: "light" | "dark" | "system",
) {
	await app.evaluate(({ nativeTheme }, s) => {
		nativeTheme.themeSource = s;
	}, scheme);
}
/** Hides or shows the window as far as the app knows; tests never put it on screen. */
async function setShown(app: ElectronApplication, shown: boolean) {
	await app.evaluate(
		(_e, v) =>
			(
				globalThis as unknown as {
					__offerfinchTest: { setShown: (v: boolean) => void };
				}
			).__offerfinchTest.setShown(v),
		shown,
	);
}
/** The app runs in the background in tests and already acts as if its window were in front. */
async function focus(_app: ElectronApplication) {}
async function frames(app: ElectronApplication, page: Page, name: string) {
	if (!SHOTS) return;
	fs.mkdirSync(SHOTS, { recursive: true });
	for (const [w, h] of [
		[960, 600],
		[1440, 900],
	] as const)
		for (const scheme of ["light", "dark"] as const) {
			await size(app, w, h);
			await theme(app, scheme);
			await page.waitForTimeout(450);
			await page.screenshot({
				path: path.join(SHOTS, `onboarding-${name}-${w}x${h}-${scheme}.png`),
			});
		}
	await theme(app, "system");
	await size(app, 1440, 900);
}
const boxOf = async (page: Page, testId: string) => {
	const b = await page.getByTestId(testId).boundingBox();
	if (!b) throw new Error(`no box for ${testId}`);
	return {
		x: Math.round(b.x),
		y: Math.round(b.y),
		right: Math.round(b.x + b.width),
	};
};

test("onboarding: centred, steady footer, keyboard and drag and drop on the resume step", async () => {
	const { app, page, errors } = await launchApp({ userData });
	try {
		await focus(app);
		await expect(page.getByTestId("welcome")).toBeVisible();
		// Full window: no app sidebar; the Grid mark on the welcome.
		await expect(page.locator('[data-ds="sidebar"]')).toHaveCount(0);
		await expect(
			page.locator('[data-testid="welcome"] svg[data-brand="grid"]'),
		).toBeVisible();
		await frames(app, page, "welcome");

		// One centred column at both sizes.
		for (const [w, h] of [
			[960, 600],
			[1440, 900],
		] as const) {
			await size(app, w, h);
			await page.waitForTimeout(300);
			const col = await page.getByTestId("welcome").boundingBox();
			const center = (col?.x ?? 0) + (col?.width ?? 0) / 2;
			expect(Math.abs(center - w / 2), `${w}x${h}: centred`).toBeLessThan(3);
		}

		await page.getByTestId("welcome-start").click();
		await expect(page.getByTestId("step-count")).toContainText("Step 1 of 5");
		await expect(page.getByTestId("setup-ai")).toBeVisible();
		await frames(app, page, "connect-ai");
		// Back and the primary action stay where they are from step to step.
		const back1 = await boxOf(page, "step-back");
		const primary1 = await boxOf(page, "step-continue");
		await page.getByTestId("step-skip").click();
		await expect(page.getByTestId("step-count")).toContainText("Step 2 of 5");
		// The finch stands over the current step. Under reduced motion it moves without a hop.
		const finch = page.getByTestId("setup-finch");
		await expect(finch).toHaveAttribute("data-step", "1");
		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.getByTestId("step-ai").click();
		await expect(finch).toHaveAttribute("data-step", "0");
		await expect(finch).not.toHaveAttribute("data-hopping", /.*/);
		await expect(finch.locator("svg")).toHaveAttribute("data-frame", "idle");
		await page.getByTestId("step-profile").click();
		await expect(finch).toHaveAttribute("data-step", "1");
		await expect(finch).not.toHaveAttribute("data-hopping", /.*/);
		await page.emulateMedia({ reducedMotion: "no-preference" });
		expect(await boxOf(page, "step-back")).toEqual(back1);
		expect(await boxOf(page, "onboarding-structure")).toEqual(primary1);

		// The resume step: three ways, no file control or text box until one is chosen.
		await expect(page.getByTestId("onboarding-text")).toHaveCount(0);
		await expect(page.getByTestId("onboarding-structure")).toBeDisabled();
		await frames(app, page, "resume-options");

		// Keyboard: Tab to "Paste or type it", Enter opens the editor focused; Other ways goes back.
		await page.getByTestId("resume-option-upload").focus();
		await page.keyboard.press("Tab");
		await expect(page.getByTestId("resume-option-paste")).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(page.getByTestId("onboarding-text")).toBeFocused();
		await page.keyboard.type(
			"Avery Quinn, frontend engineer. Built the billing pages in React.",
		);
		await expect(page.getByTestId("onboarding-structure")).toBeEnabled();
		await frames(app, page, "resume-paste");
		await page.getByTestId("resume-back").click();
		await expect(page.getByTestId("resume-option-paste")).toBeVisible();

		// Drag and drop a file anywhere on the step: a chip with its name, size and words read.
		const drop = async (name: string, type: string, body: string) =>
			page.getByTestId("resume-drop").evaluate(
				(el, [n, t, b]) => {
					const data = new DataTransfer();
					data.items.add(
						new File([b as string], n as string, { type: t as string }),
					);
					el.dispatchEvent(
						new DragEvent("dragover", {
							dataTransfer: data,
							bubbles: true,
							cancelable: true,
						}),
					);
					el.dispatchEvent(
						new DragEvent("drop", {
							dataTransfer: data,
							bubbles: true,
							cancelable: true,
						}),
					);
				},
				[name, type, body],
			);
		await drop(
			"avery-quinn.txt",
			"text/plain",
			"Avery Quinn\nFrontend Engineer at Harbor Mills, 2021 - Present\n- Built the billing pages in React.",
		);
		await expect(page.getByTestId("resume-file")).toContainText(
			"avery-quinn.txt",
		);
		await expect(page.getByTestId("resume-file-status")).toContainText(
			/words read/,
		);
		await expect(page.getByTestId("onboarding-structure")).toBeEnabled();
		await frames(app, page, "resume-file");

		// Replace with a file of the wrong kind: a clear error, and nothing to draft from.
		await page.getByTestId("onboarding-file").setInputFiles({
			name: "resume.docx",
			mimeType:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			buffer: Buffer.from("not text"),
		});
		await expect(
			page.getByText("Choose a PDF, TXT or Markdown file."),
		).toBeVisible();
		await expect(page.getByTestId("onboarding-structure")).toBeDisabled();
		await frames(app, page, "resume-error");
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});

test("the ambient field runs only while onboarding is shown and the window is focused", async () => {
	const { app, page } = await launchApp({ userData });
	try {
		await focus(app);
		// Setup already started: Home offers it; open it as Home's link does.
		await page.waitForTimeout(1500);
		await openRoute(app, page, "/onboarding");
		await expect(page.getByTestId("onboarding")).toBeVisible({
			timeout: 30_000,
		});
		const field = page.getByTestId("ambient-field");
		await expect(field).toHaveCount(1);
		await expect(field).toHaveAttribute("data-running", "true", {
			timeout: 10_000,
		});

		// CPU and memory while it runs, then after onboarding is left (sampled once a second).
		const sample = async (seconds: number) => {
			const rows: { cpu: number; mb: number }[] = [];
			for (let i = 0; i < seconds; i++) {
				await page.waitForTimeout(1000);
				rows.push(
					await app.evaluate(({ app: a }) => {
						const metrics = a.getAppMetrics();
						const pick = metrics.filter(
							(m) => m.type === "Tab" || m.type === "GPU",
						);
						return {
							cpu: pick.reduce((s, m) => s + m.cpu.percentCPUUsage, 0),
							mb: Math.round(
								pick.reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024,
							),
						};
					}),
				);
			}
			const mean = (k: "cpu" | "mb") =>
				Math.round((rows.reduce((s, r) => s + r[k], 0) / rows.length) * 10) /
				10;
			return { cpu: mean("cpu"), mb: mean("mb") };
		};
		const during = await sample(15);

		// Hidden (closed to the menu bar, or minimised): paused. Reduced motion: still.
		await setShown(app, false);
		await expect(field).toHaveAttribute("data-running", "false", {
			timeout: 10_000,
		});
		await setShown(app, true);
		await focus(app);
		await expect(field).toHaveAttribute("data-running", "true", {
			timeout: 10_000,
		});
		await page.emulateMedia({ reducedMotion: "reduce" });
		await expect(field).toHaveAttribute("data-running", "false", {
			timeout: 10_000,
		});
		await page.emulateMedia({ reducedMotion: "no-preference" });
		await expect(field).toHaveAttribute("data-running", "true", {
			timeout: 10_000,
		});

		// Leaving onboarding removes it entirely.
		await openRoute(app, page, "/settings/general");
		await expect(page.locator('[data-ds="sidebar"]')).toBeVisible();
		await expect(field).toHaveCount(0);
		const after = await sample(15);
		console.log(
			"ambient during",
			JSON.stringify(during),
			"after",
			JSON.stringify(after),
		);
		// Nothing keeps drawing afterwards: the renderer and GPU sit near idle.
		expect(after.cpu).toBeLessThan(3);
	} finally {
		await app.close();
	}
});
